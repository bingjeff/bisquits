import { Client, Room } from "colyseus";
import {
  createGame,
  moveTile,
  servePlate,
  tradeTile,
  type GameState,
  type Tile,
} from "../../shared/game/engine";
import { BisquitsRoomState, PlayerState } from "../state/BisquitsRoomState";
import { statsStore } from "../stats/StatsStore";

interface PlayerNameMessage {
  name?: string;
}

interface ReadyMessage {
  ready?: boolean;
}

interface MoveTileMessage {
  tileId?: string;
  row?: number;
  col?: number;
}

interface TradeTileMessage {
  tileId?: string;
}

type RoomNoticeLevel = "info" | "error";

function sanitizeName(input: unknown, fallback: string): string {
  const base = typeof input === "string" ? input.trim() : "";
  const collapsed = base.replace(/\s+/g, " ");
  const cleaned = collapsed.replace(/[^\w -]/g, "");
  return (cleaned.slice(0, 20) || fallback).trim();
}

function getJoinName(options: unknown): unknown {
  if (!options || typeof options !== "object") {
    return options;
  }

  const source = options as Record<string, unknown>;
  if (typeof source.name === "string") {
    return source.name;
  }
  if (typeof source.playerName === "string") {
    return source.playerName;
  }
  if (
    source.options &&
    typeof source.options === "object" &&
    typeof (source.options as Record<string, unknown>).name === "string"
  ) {
    return (source.options as Record<string, unknown>).name;
  }

  return options;
}

function computeLongestWordFromBoard(gameState: GameState): string {
  const boardLetters = new Map<string, string>();
  for (const tile of gameState.tiles.filter(isBoardTile)) {
    boardLetters.set(`${tile.row}:${tile.col}`, tile.letter);
  }

  let best = "";
  const updateBest = (candidate: string): void => {
    if (candidate.length > best.length) {
      best = candidate;
    }
  };

  for (let row = 1; row <= gameState.config.rows; row += 1) {
    let sequence = "";
    for (let col = 1; col <= gameState.config.cols; col += 1) {
      const letter = boardLetters.get(`${row}:${col}`);
      if (letter) {
        sequence += letter;
      } else {
        if (sequence.length >= 2) {
          updateBest(sequence);
        }
        sequence = "";
      }
    }
    if (sequence.length >= 2) {
      updateBest(sequence);
    }
  }

  for (let col = 1; col <= gameState.config.cols; col += 1) {
    let sequence = "";
    for (let row = 1; row <= gameState.config.rows; row += 1) {
      const letter = boardLetters.get(`${row}:${col}`);
      if (letter) {
        sequence += letter;
      } else {
        if (sequence.length >= 2) {
          updateBest(sequence);
        }
        sequence = "";
      }
    }
    if (sequence.length >= 2) {
      updateBest(sequence);
    }
  }

  return best;
}

function isBoardTile(tile: Tile): tile is Tile & { zone: "board"; row: number; col: number } {
  return tile.zone === "board" && tile.row !== null && tile.col !== null;
}

function hasStagingTiles(gameState: GameState): boolean {
  return gameState.tiles.some((tile) => tile.zone === "staging");
}

export class BisquitsRoom extends Room<BisquitsRoomState> {
  maxClients = 4;

  private playerGameStates = new Map<string, GameState>();
  private activeRoundPlayers = 0;
  private sharedBagCount = 0;

  onCreate(): void {
    this.setState(new BisquitsRoomState());
    this.setPrivate(false);
    this.autoDispose = true;
    this.patchRate = 50;

    this.onMessage("set_name", (client, message: PlayerNameMessage) => {
      this.renamePlayer(client, message.name);
    });

    this.onMessage("set_ready", (client, message: ReadyMessage) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || this.state.phase !== "lobby") {
        return;
      }
      const nextReady = Boolean(message?.ready);
      if (player.ready === nextReady) {
        return;
      }
      player.ready = nextReady;
      this.broadcast("room_notice", {
        level: "info",
        message: `${player.name} is ${nextReady ? "ready" : "not ready"}.`,
      });
      this.updateRoomMetadata();
    });

    this.onMessage("start_game", (client) => {
      this.startAuthoritativeGame(client);
    });

    this.onMessage("action_move_tile", (client, message: MoveTileMessage) => {
      this.handleMoveTile(client, message);
    });

    this.onMessage("action_trade_tile", (client, message: TradeTileMessage) => {
      this.handleTradeTile(client, message);
    });

    this.onMessage("action_serve_plate", (client) => {
      this.handleServePlate(client);
    });

    this.updateRoomMetadata();
  }

  async onJoin(client: Client, options: PlayerNameMessage): Promise<void> {
    const player = new PlayerState();
    player.clientId = client.sessionId;
    player.name = sanitizeName(getJoinName(options), `Player ${this.clients.length}`);

    this.state.players.set(client.sessionId, player);
    if (!this.state.ownerClientId) {
      this.state.ownerClientId = client.sessionId;
    }

    this.sendNotice(client, "info", `Joined room ${this.roomId}.`);
    this.broadcast("room_notice", {
      level: "info",
      message: `${player.name} joined the room.`,
    });

    const stats = await statsStore.getSnapshot();
    client.send("stats_snapshot", stats);

    if (this.state.phase === "playing") {
      const playerGame = this.getOrCreatePlayerGameState(client.sessionId);
      client.send("game_snapshot", this.buildGameSnapshot(playerGame, "sync"));
    }

    this.updateRoomMetadata();
  }

  onLeave(client: Client): void {
    const leavingPlayer = this.state.players.get(client.sessionId);
    const leavingName = leavingPlayer?.name ?? "Player";
    this.state.players.delete(client.sessionId);
    this.playerGameStates.delete(client.sessionId);

    if (this.state.ownerClientId === client.sessionId) {
      this.state.ownerClientId = this.getFirstPlayerId();
    }

    if (this.state.players.size < 2 && this.state.phase === "playing") {
      this.clearRoundGames();
      this.state.phase = "lobby";
      this.broadcast("room_notice", {
        level: "info",
        message: "Game reset to lobby because player count dropped below 2.",
      });
    }

    this.broadcast("room_notice", {
      level: "info",
      message: `${leavingName} left the room.`,
    });
    this.updateRoomMetadata();
  }

  private startAuthoritativeGame(client: Client): void {
    if (client.sessionId !== this.state.ownerClientId) {
      this.sendNotice(client, "error", "Only the host can start the game.");
      return;
    }
    if (this.clients.length < 2) {
      this.sendNotice(client, "error", "At least 2 players are required.");
      return;
    }

    this.state.phase = "playing";
    this.state.players.forEach((player: PlayerState) => {
      player.ready = false;
    });

    this.activeRoundPlayers = Math.min(4, this.clients.length);
    this.playerGameStates.clear();
    for (const participant of this.clients) {
      this.playerGameStates.set(participant.sessionId, createGame({ players: this.activeRoundPlayers }));
    }
    this.sharedBagCount = this.getCurrentBagCountFromRound();

    this.broadcast("game_started", { startedAt: Date.now() });
    this.sendSnapshotsToAllPlayers("start_game", client.sessionId);
    this.updateRoomMetadata();
  }

  private handleMoveTile(client: Client, message: MoveTileMessage): void {
    const current = this.ensurePlaying(client);
    if (!current) {
      return;
    }

    const tileId = typeof message?.tileId === "string" ? message.tileId : "";
    const row = Number(message?.row);
    const col = Number(message?.col);
    if (!tileId || !Number.isFinite(row) || !Number.isFinite(col)) {
      this.sendActionRejected(client, "Move requires tile id, row, and col.");
      return;
    }

    const next = moveTile(current, tileId, row, col);
    this.playerGameStates.set(client.sessionId, next);
    client.send("game_snapshot", this.buildGameSnapshot(next, "move_tile", client.sessionId));
  }

  private handleTradeTile(client: Client, message: TradeTileMessage): void {
    const current = this.ensurePlaying(client);
    if (!current) {
      return;
    }

    const tileId = typeof message?.tileId === "string" ? message.tileId : "";
    if (!tileId) {
      this.sendActionRejected(client, "Trade requires tile id.");
      return;
    }

    if (this.sharedBagCount <= 3) {
      this.sendActionRejected(client, "Not enough tiles remain to trade.");
      return;
    }

    const previousBagCount = current.drawPile.length;
    const next = tradeTile(current, tileId);
    this.playerGameStates.set(client.sessionId, next);
    const bagDelta = previousBagCount - next.drawPile.length;
    if (bagDelta !== 0) {
      this.sharedBagCount = Math.max(0, this.sharedBagCount - bagDelta);
      this.synchronizePlayerBagSizes(this.sharedBagCount);
    }
    this.sendSnapshotsToAllPlayers("trade_tile", client.sessionId);
  }

  private handleServePlate(client: Client): void {
    const current = this.ensurePlaying(client);
    if (!current) {
      return;
    }

    if (hasStagingTiles(current)) {
      this.sendActionRejected(client, "Place all tray tiles on your board before serving.");
      return;
    }

    const previousSharedBagCount = this.sharedBagCount;
    const nextByClientId = new Map<string, GameState>();
    for (const participant of this.clients) {
      const participantState = this.getOrCreatePlayerGameState(participant.sessionId);
      nextByClientId.set(participant.sessionId, servePlate(participantState));
    }

    this.playerGameStates = nextByClientId;
    const actorNextState = nextByClientId.get(client.sessionId);
    if (actorNextState?.status === "running") {
      const servingPlayers = Math.min(this.maxClients, this.clients.length);
      this.sharedBagCount = Math.max(0, previousSharedBagCount - servingPlayers);
      this.synchronizePlayerBagSizes(this.sharedBagCount);
    } else {
      this.sharedBagCount = this.getCurrentBagCountFromRound();
    }

    this.sendSnapshotsToAllPlayers("serve_plate", client.sessionId);

    if (!actorNextState || actorNextState.status === "running") {
      return;
    }

    if (actorNextState.status === "won") {
      void this.finalizeWinner(client.sessionId);
      return;
    }

    this.finalizeNoWinner("Round ended without a winner.");
  }

  private buildGameSnapshot(gameState: GameState, reason: string, actorClientId?: string): {
    gameState: GameState;
    bagCount: number;
    nextPressureAt: number;
    reason: string;
    actorClientId?: string;
    serverTime: number;
  } {
    return {
      gameState,
      bagCount: this.sharedBagCount,
      nextPressureAt: 0,
      reason,
      actorClientId,
      serverTime: Date.now(),
    };
  }

  private sendSnapshotsToAllPlayers(reason: string, actorClientId?: string): void {
    for (const participant of this.clients) {
      const gameState = this.playerGameStates.get(participant.sessionId);
      if (!gameState) {
        continue;
      }
      participant.send("game_snapshot", this.buildGameSnapshot(gameState, reason, actorClientId));
    }
  }

  private getOrCreatePlayerGameState(clientId: string): GameState {
    const existing = this.playerGameStates.get(clientId);
    if (existing) {
      return existing;
    }

    const players = this.activeRoundPlayers > 0 ? this.activeRoundPlayers : Math.min(4, this.clients.length);
    const created = createGame({ players });
    if (this.sharedBagCount > 0 && created.drawPile.length !== this.sharedBagCount) {
      this.resizeBag(created, this.sharedBagCount);
    }
    this.playerGameStates.set(clientId, created);
    return created;
  }

  private clearRoundGames(): void {
    this.playerGameStates.clear();
    this.activeRoundPlayers = 0;
    this.sharedBagCount = 0;
  }

  private synchronizePlayerBagSizes(targetCount: number): void {
    for (const gameState of this.playerGameStates.values()) {
      if (gameState.drawPile.length !== targetCount) {
        this.resizeBag(gameState, targetCount);
      }
    }
  }

  private resizeBag(gameState: GameState, targetCount: number): void {
    if (gameState.drawPile.length > targetCount) {
      gameState.drawPile.splice(targetCount);
      return;
    }

    const missing = targetCount - gameState.drawPile.length;
    if (missing <= 0) {
      return;
    }

    const refillLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (let i = 0; i < missing; i += 1) {
      const slot = Math.floor(Math.random() * refillLetters.length);
      gameState.drawPile.push(refillLetters[slot] ?? "E");
    }
  }

  private getCurrentBagCountFromRound(): number {
    const firstState = this.playerGameStates.values().next().value as GameState | undefined;
    return firstState ? firstState.drawPile.length : 0;
  }

  private async finalizeWinner(winnerClientId: string): Promise<void> {
    if (this.state.phase !== "playing") {
      return;
    }

    const winner = this.state.players.get(winnerClientId);
    if (!winner) {
      this.finalizeNoWinner("Winner left the room before scoring.");
      return;
    }

    const winningGameState = this.playerGameStates.get(winnerClientId);
    if (!winningGameState) {
      this.finalizeNoWinner("Winner state was unavailable.");
      return;
    }

    const winningBoardTiles = winningGameState.tiles.filter(isBoardTile).map((tile) => ({ ...tile }));
    const longestWord = computeLongestWordFromBoard(winningGameState);
    if (longestWord.length > winner.longestWord.length) {
      winner.longestWord = longestWord;
    }

    const playerNames: string[] = [];
    this.state.players.forEach((player: PlayerState) => {
      player.gamesPlayed += 1;
      playerNames.push(player.name);
    });

    winner.wins += 1;
    this.state.lastWinnerName = winner.name;
    this.state.lastLongestWord = longestWord;
    this.state.roundsPlayed += 1;
    this.state.phase = "lobby";

    const snapshot = await statsStore.recordMatch({
      roomId: this.roomId,
      winnerName: winner.name,
      longestWord,
      players: playerNames,
    });

    this.broadcast("stats_snapshot", snapshot);
    this.broadcast("game_finished", {
      winnerName: winner.name,
      longestWord,
      winnerClientId,
      winningBoardTiles,
    });
    this.broadcast("room_notice", {
      level: "info",
      message: `${winner.name} won the round${longestWord ? ` with longest word ${longestWord}` : ""}.`,
    });
    this.clearRoundGames();
    this.updateRoomMetadata();
  }

  private finalizeNoWinner(message: string): void {
    this.state.phase = "lobby";
    this.clearRoundGames();
    this.broadcast("room_notice", {
      level: "info",
      message,
    });
    this.updateRoomMetadata();
  }

  private ensurePlaying(client: Client): GameState | null {
    if (this.state.phase !== "playing") {
      this.sendActionRejected(client, "No active game in this room.");
      return null;
    }

    const gameState = this.playerGameStates.get(client.sessionId);
    if (!gameState) {
      this.sendActionRejected(client, "Your board is not active in this round.");
      return null;
    }

    return gameState;
  }

  private renamePlayer(client: Client, proposedName: unknown): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) {
      return;
    }
    const previousName = player.name;
    player.name = sanitizeName(proposedName, previousName);
    this.broadcast("room_notice", {
      level: "info",
      message: `${previousName} is now ${player.name}.`,
    });
    this.updateRoomMetadata();
  }

  private sendActionRejected(client: Client, message: string): void {
    client.send("action_rejected", { message });
  }

  private sendNotice(client: Client, level: RoomNoticeLevel, message: string): void {
    client.send("room_notice", { level, message });
  }

  private getFirstPlayerId(): string {
    let firstPlayerId = "";
    this.state.players.forEach((_player: PlayerState, clientId: string) => {
      if (!firstPlayerId) {
        firstPlayerId = clientId;
      }
    });
    return firstPlayerId;
  }

  private updateRoomMetadata(): void {
    const ownerName = this.state.players.get(this.state.ownerClientId)?.name ?? "";
    this.setMetadata({
      phase: this.state.phase,
      ownerName,
      playerCount: this.clients.length,
      maxPlayers: this.maxClients,
      hasActiveGame: this.state.phase === "playing",
      lastWinnerName: this.state.lastWinnerName,
      lastLongestWord: this.state.lastLongestWord,
      roundsPlayed: this.state.roundsPlayed,
      createdAt: this.state.createdAt,
    });
  }

  onDispose(): void {}
}
