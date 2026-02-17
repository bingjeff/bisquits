import { Client, Room } from "colyseus";
import {
  applyPressureTick,
  canTradeTile,
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

export class BisquitsRoom extends Room<BisquitsRoomState> {
  maxClients = 4;

  private gameState: GameState | null = null;
  private pressureTimeout: NodeJS.Timeout | null = null;
  private nextPressureAt = 0;

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
      player.ready = Boolean(message?.ready);
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

    if (this.state.phase === "playing" && this.gameState) {
      client.send("game_snapshot", this.buildGameSnapshot("sync"));
    }

    this.updateRoomMetadata();
  }

  onLeave(client: Client): void {
    const leavingPlayer = this.state.players.get(client.sessionId);
    const leavingName = leavingPlayer?.name ?? "Player";
    this.state.players.delete(client.sessionId);

    if (this.state.ownerClientId === client.sessionId) {
      this.state.ownerClientId = this.getFirstPlayerId();
    }

    if (this.state.players.size < 2 && this.state.phase === "playing") {
      this.state.phase = "lobby";
      this.clearPressureTimer();
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

    this.gameState = createGame({ players: Math.min(4, this.clients.length) });
    this.broadcast("game_started", { startedAt: Date.now() });
    this.schedulePressureTick();
    this.broadcast("game_snapshot", this.buildGameSnapshot("start_game", client.sessionId));
    this.updateRoomMetadata();
  }

  private handleMoveTile(client: Client, message: MoveTileMessage): void {
    if (!this.ensurePlaying(client)) {
      return;
    }

    const tileId = typeof message?.tileId === "string" ? message.tileId : "";
    const row = Number(message?.row);
    const col = Number(message?.col);
    if (!tileId || !Number.isFinite(row) || !Number.isFinite(col)) {
      this.sendActionRejected(client, "Move requires tile id, row, and col.");
      return;
    }

    this.gameState = moveTile(this.gameState as GameState, tileId, row, col);
    this.schedulePressureTick();
    this.broadcast("game_snapshot", this.buildGameSnapshot("move_tile", client.sessionId));
  }

  private handleTradeTile(client: Client, message: TradeTileMessage): void {
    if (!this.ensurePlaying(client)) {
      return;
    }

    const tileId = typeof message?.tileId === "string" ? message.tileId : "";
    if (!tileId) {
      this.sendActionRejected(client, "Trade requires tile id.");
      return;
    }

    const current = this.gameState as GameState;
    if (!canTradeTile(current)) {
      this.sendActionRejected(client, "Not enough tiles remain to trade.");
      return;
    }

    this.gameState = tradeTile(current, tileId);
    this.schedulePressureTick();
    this.broadcast("game_snapshot", this.buildGameSnapshot("trade_tile", client.sessionId));
  }

  private handleServePlate(client: Client): void {
    if (!this.ensurePlaying(client)) {
      return;
    }

    const nextState = servePlate(this.gameState as GameState);
    this.gameState = nextState;
    if (nextState.status === "running") {
      this.schedulePressureTick();
      this.broadcast("game_snapshot", this.buildGameSnapshot("serve_plate", client.sessionId));
      return;
    }

    this.clearPressureTimer();
    this.broadcast("game_snapshot", this.buildGameSnapshot("serve_plate", client.sessionId));
    if (nextState.status === "won") {
      void this.finalizeWinner(client.sessionId);
      return;
    }
    this.finalizeNoWinner("Round ended without a winner.");
  }

  private runPressureTick(): void {
    if (this.state.phase !== "playing" || !this.gameState) {
      this.clearPressureTimer();
      return;
    }

    const nextState = applyPressureTick(this.gameState);
    this.gameState = nextState;
    if (nextState.status === "running") {
      this.schedulePressureTick();
      this.broadcast("game_snapshot", this.buildGameSnapshot("pressure_tick"));
      return;
    }

    this.clearPressureTimer();
    this.broadcast("game_snapshot", this.buildGameSnapshot("pressure_tick"));
    this.finalizeNoWinner("The bag ran dry before any player could serve.");
  }

  private schedulePressureTick(): void {
    this.clearPressureTimer();
    if (!this.gameState || this.state.phase !== "playing" || this.gameState.status !== "running") {
      return;
    }

    const [min, max] = this.gameState.config.pressureRangeMs;
    const delay = Math.round(min + Math.random() * (max - min));
    this.nextPressureAt = Date.now() + delay;
    this.pressureTimeout = setTimeout(() => this.runPressureTick(), delay);
  }

  private clearPressureTimer(): void {
    if (this.pressureTimeout) {
      clearTimeout(this.pressureTimeout);
      this.pressureTimeout = null;
    }
    this.nextPressureAt = 0;
  }

  private buildGameSnapshot(reason: string, actorClientId?: string): {
    gameState: GameState;
    nextPressureAt: number;
    reason: string;
    actorClientId?: string;
    serverTime: number;
  } {
    return {
      gameState: this.gameState as GameState,
      nextPressureAt: this.nextPressureAt,
      reason,
      actorClientId,
      serverTime: Date.now(),
    };
  }

  private async finalizeWinner(winnerClientId: string): Promise<void> {
    if (!this.gameState || this.state.phase !== "playing") {
      return;
    }

    const winner = this.state.players.get(winnerClientId);
    if (!winner) {
      this.finalizeNoWinner("Winner left the room before scoring.");
      return;
    }

    const longestWord = computeLongestWordFromBoard(this.gameState);
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
    });
    this.broadcast("room_notice", {
      level: "info",
      message: `${winner.name} won the round${longestWord ? ` with longest word ${longestWord}` : ""}.`,
    });
    this.updateRoomMetadata();
  }

  private finalizeNoWinner(message: string): void {
    this.state.phase = "lobby";
    this.broadcast("room_notice", {
      level: "info",
      message,
    });
    this.updateRoomMetadata();
  }

  private ensurePlaying(client: Client): boolean {
    if (this.state.phase !== "playing" || !this.gameState) {
      this.sendActionRejected(client, "No active game in this room.");
      return false;
    }
    return true;
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

  onDispose(): void {
    this.clearPressureTimer();
  }
}
