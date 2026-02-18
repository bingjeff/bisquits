import { randomUUID } from "node:crypto";
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
  resumeToken?: string;
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

interface SeatReservation {
  playerId: string;
  expiresAt: number;
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

function getJoinResumeToken(options: unknown): string {
  if (!options || typeof options !== "object") {
    return "";
  }

  const source = options as Record<string, unknown>;
  if (typeof source.resumeToken === "string") {
    return source.resumeToken.trim();
  }

  return "";
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

function parseBoundedInt(input: string | undefined, fallback: number, min: number, max: number): number {
  const numeric = Number(input);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

export class BisquitsRoom extends Room<BisquitsRoomState> {
  maxClients = 4;

  private readonly seatReservationSeconds = parseBoundedInt(process.env.BISQUITS_RESERVATION_SECONDS, 300, 10, 3600);

  private playerGameStates = new Map<string, GameState>();
  private playerIdBySessionId = new Map<string, string>();
  private resumeTokenByPlayerId = new Map<string, string>();
  private seatReservationsByToken = new Map<string, SeatReservation>();
  private reservationSweepTimer: NodeJS.Timeout | null = null;

  private activeRoundPlayers = 0;
  private sharedBagCount = 0;

  onCreate(): void {
    this.setState(new BisquitsRoomState());
    this.setPrivate(false);
    this.autoDispose = true;
    this.patchRate = 50;

    this.reservationSweepTimer = setInterval(() => {
      this.pruneExpiredSeatReservations();
    }, 1000);
    this.reservationSweepTimer.unref();

    this.onMessage("set_name", (client, message: PlayerNameMessage) => {
      this.renamePlayer(client, message.name);
    });

    this.onMessage("set_ready", (client, message: ReadyMessage) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || this.state.phase !== "lobby" || !player.connected) {
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

    this.onMessage("request_seat_token", (client) => {
      this.sendSeatToken(client, client.sessionId);
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
    this.pruneExpiredSeatReservations();

    const fallbackName = `Player ${this.clients.length}`;
    const requestedName = sanitizeName(getJoinName(options), fallbackName);
    const resumeToken = getJoinResumeToken(options);

    const reclaimedPlayer = this.tryReclaimSeat(client, requestedName, resumeToken);
    let player: PlayerState;
    let joinedMessage = "joined";

    if (reclaimedPlayer) {
      player = reclaimedPlayer;
      joinedMessage = "rejoined";
    } else {
      if (this.state.players.size >= this.maxClients) {
        throw new Error("Room is full.");
      }

      player = new PlayerState();
      player.playerId = this.generatePlayerId();
      player.clientId = client.sessionId;
      player.name = requestedName;
      player.connected = true;

      this.state.players.set(client.sessionId, player);
      this.playerIdBySessionId.set(client.sessionId, player.playerId);
    }

    if (!this.state.ownerClientId || !this.state.players.get(this.state.ownerClientId)?.connected) {
      this.state.ownerClientId = this.getFirstConnectedPlayerSessionId() || client.sessionId;
    }

    this.sendSeatToken(client, client.sessionId);

    this.sendNotice(client, "info", `${joinedMessage === "joined" ? "Joined" : "Rejoined"} room ${this.roomId}.`);
    this.broadcast("room_notice", {
      level: "info",
      message: `${player.name} ${joinedMessage} the room.`,
    });

    const stats = await statsStore.getSnapshot();
    client.send("stats_snapshot", stats);

    if (this.state.phase === "playing") {
      const playerGame = this.getOrCreatePlayerGameState(client.sessionId);
      client.send("game_snapshot", this.buildGameSnapshot(playerGame, "sync"));
    }

    this.updateRoomMetadata();
  }

  onLeave(client: Client, consented: boolean): void {
    const leavingPlayer = this.state.players.get(client.sessionId);
    if (!leavingPlayer) {
      return;
    }

    if (consented) {
      this.removePlayerBySession(client.sessionId, `${leavingPlayer.name} left the room.`);
      return;
    }

    leavingPlayer.connected = false;
    this.playerIdBySessionId.delete(client.sessionId);
    this.reserveDisconnectedSeat(leavingPlayer.playerId);

    if (this.state.ownerClientId === client.sessionId) {
      this.state.ownerClientId = this.getFirstConnectedPlayerSessionId() || this.getFirstPlayerId();
    }

    this.broadcast("room_notice", {
      level: "info",
      message: `${leavingPlayer.name} disconnected. Their board is reserved for rejoin.`,
    });
    this.updateRoomMetadata();
  }

  private startAuthoritativeGame(client: Client): void {
    if (client.sessionId !== this.state.ownerClientId) {
      this.sendNotice(client, "error", "Only the host can start the game.");
      return;
    }

    const connectedPlayers = this.getConnectedPlayers();
    if (connectedPlayers.length < 2) {
      this.sendNotice(client, "error", "At least 2 connected players are required.");
      return;
    }

    this.state.phase = "playing";
    this.state.players.forEach((player: PlayerState) => {
      player.ready = false;
    });

    this.activeRoundPlayers = Math.min(4, connectedPlayers.length);
    this.playerGameStates.clear();
    for (const [, participant] of connectedPlayers) {
      this.playerGameStates.set(participant.playerId, createGame({ players: this.activeRoundPlayers }));
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

    const playerId = this.getPlayerIdForSession(client.sessionId);
    if (!playerId) {
      this.sendActionRejected(client, "Unknown player seat.");
      return;
    }

    const next = moveTile(current, tileId, row, col);
    this.playerGameStates.set(playerId, next);
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

    const playerId = this.getPlayerIdForSession(client.sessionId);
    if (!playerId) {
      this.sendActionRejected(client, "Unknown player seat.");
      return;
    }

    const previousBagCount = current.drawPile.length;
    const next = tradeTile(current, tileId);
    this.playerGameStates.set(playerId, next);
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
    const nextByPlayerId = new Map<string, GameState>();
    for (const [playerId, participantState] of this.playerGameStates.entries()) {
      nextByPlayerId.set(playerId, servePlate(participantState));
    }

    this.playerGameStates = nextByPlayerId;

    const actorPlayerId = this.getPlayerIdForSession(client.sessionId);
    const actorNextState = actorPlayerId ? nextByPlayerId.get(actorPlayerId) : undefined;
    if (actorNextState?.status === "running") {
      this.sharedBagCount = Math.max(0, previousSharedBagCount - nextByPlayerId.size);
      this.synchronizePlayerBagSizes(this.sharedBagCount);
    } else {
      this.sharedBagCount = this.getCurrentBagCountFromRound();
    }

    this.sendSnapshotsToAllPlayers("serve_plate", client.sessionId);

    if (!actorNextState || actorNextState.status === "running") {
      return;
    }

    if (actorNextState.status === "won") {
      if (actorPlayerId) {
        void this.finalizeWinner(actorPlayerId);
      }
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
      const playerId = this.getPlayerIdForSession(participant.sessionId);
      if (!playerId) {
        continue;
      }
      const gameState = this.playerGameStates.get(playerId);
      if (!gameState) {
        continue;
      }
      participant.send("game_snapshot", this.buildGameSnapshot(gameState, reason, actorClientId));
    }
  }

  private getOrCreatePlayerGameState(sessionId: string): GameState {
    const playerId = this.getPlayerIdForSession(sessionId);
    if (!playerId) {
      return createGame({ players: Math.max(2, Math.min(4, this.clients.length)) });
    }

    const existing = this.playerGameStates.get(playerId);
    if (existing) {
      return existing;
    }

    const players = this.activeRoundPlayers > 0 ? this.activeRoundPlayers : Math.min(4, this.getConnectedPlayerCount());
    const created = createGame({ players: Math.max(2, players) });
    if (this.sharedBagCount > 0 && created.drawPile.length !== this.sharedBagCount) {
      this.resizeBag(created, this.sharedBagCount);
    }
    this.playerGameStates.set(playerId, created);
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

  private async finalizeWinner(winnerPlayerId: string): Promise<void> {
    if (this.state.phase !== "playing") {
      return;
    }

    const winnerEntry = this.getPlayerEntryByPlayerId(winnerPlayerId);
    const winner = winnerEntry?.player;
    if (!winner) {
      this.finalizeNoWinner("Winner left the room before scoring.");
      return;
    }

    const winningGameState = this.playerGameStates.get(winnerPlayerId);
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
      winnerClientId: winner.clientId,
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

    const playerId = this.getPlayerIdForSession(client.sessionId);
    if (!playerId) {
      this.sendActionRejected(client, "Your seat is not active in this room.");
      return null;
    }

    const gameState = this.playerGameStates.get(playerId);
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

  private sendSeatToken(client: Client, sessionId: string): void {
    const playerId = this.getPlayerIdForSession(sessionId);
    if (!playerId) {
      return;
    }
    const token = this.issueResumeToken(playerId);
    client.send("seat_token", {
      token,
      playerId,
      roomId: this.roomId,
      expiresInSeconds: this.seatReservationSeconds,
    });
  }

  private issueResumeToken(playerId: string): string {
    const existing = this.resumeTokenByPlayerId.get(playerId);
    if (existing) {
      return existing;
    }

    const token = randomUUID().replace(/-/g, "");
    this.resumeTokenByPlayerId.set(playerId, token);
    return token;
  }

  private reserveDisconnectedSeat(playerId: string): void {
    const token = this.issueResumeToken(playerId);
    this.seatReservationsByToken.set(token, {
      playerId,
      expiresAt: Date.now() + this.seatReservationSeconds * 1000,
    });
  }

  private pruneExpiredSeatReservations(): void {
    if (this.seatReservationsByToken.size === 0) {
      return;
    }

    const now = Date.now();
    const expiredTokens: string[] = [];

    for (const [token, reservation] of this.seatReservationsByToken.entries()) {
      if (reservation.expiresAt <= now) {
        expiredTokens.push(token);
      }
    }

    if (expiredTokens.length === 0) {
      return;
    }

    for (const token of expiredTokens) {
      const reservation = this.seatReservationsByToken.get(token);
      if (!reservation) {
        continue;
      }
      this.seatReservationsByToken.delete(token);

      const entry = this.getPlayerEntryByPlayerId(reservation.playerId);
      if (!entry || entry.player.connected) {
        continue;
      }

      this.removePlayerBySession(entry.sessionId, `${entry.player.name} timed out and was removed from the room.`);
    }
  }

  private tryReclaimSeat(client: Client, requestedName: string, resumeToken: string): PlayerState | null {
    if (!resumeToken) {
      return null;
    }

    const reservation = this.seatReservationsByToken.get(resumeToken);
    if (!reservation) {
      return null;
    }

    if (reservation.expiresAt <= Date.now()) {
      this.seatReservationsByToken.delete(resumeToken);
      return null;
    }

    const entry = this.getPlayerEntryByPlayerId(reservation.playerId);
    if (!entry || entry.player.connected) {
      this.seatReservationsByToken.delete(resumeToken);
      return null;
    }

    const player = entry.player;
    this.state.players.delete(entry.sessionId);
    player.clientId = client.sessionId;
    player.connected = true;
    if (requestedName && requestedName !== player.name) {
      player.name = requestedName;
    }
    this.state.players.set(client.sessionId, player);
    this.playerIdBySessionId.set(client.sessionId, player.playerId);
    this.seatReservationsByToken.delete(resumeToken);

    if (this.state.ownerClientId === entry.sessionId) {
      this.state.ownerClientId = client.sessionId;
    }

    return player;
  }

  private removePlayerBySession(sessionId: string, message: string): void {
    const player = this.state.players.get(sessionId);
    if (!player) {
      return;
    }

    this.state.players.delete(sessionId);
    this.playerIdBySessionId.delete(sessionId);
    this.playerGameStates.delete(player.playerId);

    const resumeToken = this.resumeTokenByPlayerId.get(player.playerId);
    if (resumeToken) {
      this.seatReservationsByToken.delete(resumeToken);
    }
    this.resumeTokenByPlayerId.delete(player.playerId);

    if (this.state.ownerClientId === sessionId) {
      this.state.ownerClientId = this.getFirstConnectedPlayerSessionId() || this.getFirstPlayerId();
    }

    if (this.getConnectedPlayerCount() < 2 && this.state.phase === "playing") {
      this.clearRoundGames();
      this.state.phase = "lobby";
      this.broadcast("room_notice", {
        level: "info",
        message: "Game reset to lobby because connected player count dropped below 2.",
      });
    }

    this.broadcast("room_notice", {
      level: "info",
      message,
    });

    this.updateRoomMetadata();
  }

  private generatePlayerId(): string {
    return randomUUID().replace(/-/g, "");
  }

  private getPlayerIdForSession(sessionId: string): string {
    const mapped = this.playerIdBySessionId.get(sessionId);
    if (mapped) {
      return mapped;
    }

    const player = this.state.players.get(sessionId);
    if (!player) {
      return "";
    }

    this.playerIdBySessionId.set(sessionId, player.playerId);
    return player.playerId;
  }

  private getPlayerEntryByPlayerId(playerId: string): { sessionId: string; player: PlayerState } | null {
    let matched: { sessionId: string; player: PlayerState } | null = null;
    this.state.players.forEach((player: PlayerState, sessionId: string) => {
      if (!matched && player.playerId === playerId) {
        matched = { sessionId, player };
      }
    });
    return matched;
  }

  private getConnectedPlayers(): Array<[string, PlayerState]> {
    const entries: Array<[string, PlayerState]> = [];
    this.state.players.forEach((player: PlayerState, sessionId: string) => {
      if (player.connected) {
        entries.push([sessionId, player]);
      }
    });
    return entries;
  }

  private getConnectedPlayerCount(): number {
    return this.getConnectedPlayers().length;
  }

  private getFirstConnectedPlayerSessionId(): string {
    let first = "";
    this.state.players.forEach((player: PlayerState, sessionId: string) => {
      if (!first && player.connected) {
        first = sessionId;
      }
    });
    return first;
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
      playerCount: this.state.players.size,
      connectedCount: this.getConnectedPlayerCount(),
      reservedCount: this.seatReservationsByToken.size,
      maxPlayers: this.maxClients,
      hasActiveGame: this.state.phase === "playing",
      lastWinnerName: this.state.lastWinnerName,
      lastLongestWord: this.state.lastLongestWord,
      roundsPlayed: this.state.roundsPlayed,
      createdAt: this.state.createdAt,
    });
  }

  onDispose(): void {
    if (this.reservationSweepTimer) {
      clearInterval(this.reservationSweepTimer);
      this.reservationSweepTimer = null;
    }
  }
}
