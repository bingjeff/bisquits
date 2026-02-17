import { Client as ColyseusClient, type Room } from "colyseus.js";
import "./style.css";
import { DEFAULT_CONFIG, type GameState, type Tile } from "../../shared/game/engine";

interface DragState {
  tileId: string;
  pointerId: number;
  pointerOffsetX: number;
  pointerOffsetY: number;
  sourceElement: HTMLButtonElement;
  dragProxy: HTMLDivElement;
  isOverTradeZone: boolean;
}

interface MultiplayerPlayerSnapshot {
  clientId: string;
  name: string;
  ready: boolean;
  wins: number;
  gamesPlayed: number;
  longestWord: string;
}

interface MultiplayerRoomSnapshot {
  phase: "lobby" | "playing";
  ownerClientId: string;
  lastWinnerName: string;
  lastLongestWord: string;
  roundsPlayed: number;
  players: Record<string, MultiplayerPlayerSnapshot>;
}

interface RoomNoticeMessage {
  level?: "info" | "error";
  message?: string;
}

interface MatchRecord {
  roomId: string;
  winnerName: string;
  longestWord: string;
  players: string[];
  playedAt: string;
}

interface PlayerAggregate {
  name: string;
  gamesPlayed: number;
  wins: number;
  longestWord: string;
  updatedAt: string;
}

interface StatsSnapshot {
  totalMatches: number;
  recentMatches: MatchRecord[];
  players: Record<string, PlayerAggregate>;
}

interface GameSnapshotMessage {
  gameState: GameState;
  bagCount: number;
  reason: string;
  actorClientId?: string;
  serverTime: number;
}

interface GameFinishedMessage {
  winnerName?: string;
  longestWord?: string;
  winnerClientId?: string;
  winningBoardTiles?: Tile[];
}

interface ListedRoomMetadata {
  phase?: string;
  ownerName?: string;
  playerCount?: number;
  maxPlayers?: number;
  hasActiveGame?: boolean;
}

interface ListedRoom {
  roomId: string;
  name: string;
  clients: number;
  maxClients: number;
  metadata: ListedRoomMetadata;
}

function createPlaceholderState(): GameState {
  return {
    config: { ...DEFAULT_CONFIG },
    status: "running",
    turn: 0,
    nextTileId: 1,
    drawPile: [],
    tiles: [],
    lastAction: "Join or create a room to begin.",
  };
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app root element.");
}

app.innerHTML = `
  <main class="app-shell">
    <header class="header">
      <div>
        <p class="eyebrow">Bisquits</p>
      </div>
    </header>

    <section class="layout">
      <section class="board-panel">
        <div id="board" class="board" aria-label="Game board">
          <div id="board-cells" class="board-cells"></div>
          <div id="board-tiles" class="board-tiles"></div>
        </div>
      </section>

      <aside class="hud-panel">
        <div id="bag-card" class="hud-card">
          <p class="label">Bag Remaining</p>
          <p id="bag-count" class="metric-number"></p>
        </div>

        <div id="shelf-card" class="hud-card">
          <p class="label">Tile Shelf</p>
          <div id="tile-shelf" class="tile-shelf" aria-label="Tile shelf"></div>
        </div>

        <div id="action-card" class="hud-card">
          <p class="label">Actions</p>
          <div id="trade-zone" class="trade-zone" aria-label="Trade zone">
            Drop stale bisquit here for three fresh ones!
          </div>
          <div id="serve-row" class="button-row button-row-single">
            <button id="serve-btn" class="button">Serve the bisquits!</button>
          </div>
        </div>

        <div class="hud-card">
          <p class="label">Connection</p>
          <p id="net-status" class="metric-subtle">Disconnected</p>
          <div id="connect-view">
            <label class="field-label" for="player-name-input">Name</label>
            <input id="player-name-input" class="text-input" maxlength="20" autocomplete="nickname" />
            <div class="button-row button-row-single">
              <button id="create-room-btn" class="button">Create</button>
            </div>
            <div class="button-row button-row-single">
              <button id="refresh-rooms-btn" class="button button-muted">Refresh Open Rooms</button>
            </div>
            <ul id="available-room-list" class="room-list"></ul>
          </div>
          <div id="session-view" class="panel-hidden" aria-hidden="true">
            <p class="field-label">Name</p>
            <p id="active-player-name" class="metric-subtle player-name-label"></p>
            <p class="field-label">Room</p>
            <p id="active-room-id" class="metric-subtle room-id-label"></p>
            <div class="button-row button-row-single">
              <button id="quit-room-btn" class="button button-muted">Quit</button>
            </div>
          </div>
        </div>

        <div id="room-card" class="hud-card">
          <p class="label">Room</p>
          <div id="room-controls-row" class="button-row">
            <button id="ready-btn" class="button button-muted">Ready</button>
            <button id="start-room-btn" class="button button-muted">Start</button>
          </div>
          <p id="room-details" class="metric-subtle"></p>
          <ul id="room-player-list" class="player-list"></ul>
          <p id="room-notice" class="room-notice"></p>
          <p id="stats-summary" class="metric-subtle"></p>
        </div>

        <div class="hud-card">
          <p class="label">Status</p>
          <p id="status-text" class="status-text"></p>
          <p id="action-text" class="action-text"></p>
        </div>
      </aside>
    </section>
  </main>
  <div id="win-overlay" class="overlay" aria-hidden="true">
    <div class="overlay-card">
      <p class="eyebrow">Round Complete</p>
      <h2 class="overlay-title">Winning Plate</h2>
      <p class="overlay-subtitle">Are these bisquits in order?</p>
      <div id="winning-table" class="winning-table" aria-label="Winning table"></div>
      <div class="button-row overlay-actions button-row-single">
        <button id="overlay-close-btn" class="button">Close</button>
      </div>
    </div>
  </div>
`;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

function tileNumericId(tileId: string): number {
  const value = Number(tileId.replace(/\D+/g, ""));
  return Number.isFinite(value) ? value : 0;
}

function compareByTileId(a: Tile, b: Tile): number {
  const delta = tileNumericId(a.id) - tileNumericId(b.id);
  if (delta !== 0) {
    return delta;
  }
  return a.id.localeCompare(b.id);
}

function isBoardTile(tile: Tile): tile is Tile & { zone: "board"; row: number; col: number } {
  return tile.zone === "board" && tile.row !== null && tile.col !== null;
}

function hasStagingTiles(gameState: GameState): boolean {
  return gameState.tiles.some((tile) => tile.zone === "staging");
}

function sanitizePlayerName(name: string): string {
  return (name.trim().replace(/\s+/g, " ").replace(/[^\w -]/g, "").slice(0, 20) || "Player").trim();
}

function getRoomSnapshot(room: Room): MultiplayerRoomSnapshot | null {
  const state = room.state as { toJSON?: () => unknown } | null | undefined;
  if (!state || typeof state.toJSON !== "function") {
    return null;
  }
  return state.toJSON() as MultiplayerRoomSnapshot;
}

function normalizeListedRoom(value: unknown): ListedRoom | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const source = value as Record<string, unknown>;
  const roomId = typeof source.roomId === "string" ? source.roomId : "";
  const name = typeof source.name === "string" ? source.name : "";
  if (!roomId || !name) {
    return null;
  }

  const clients = Number(source.clients);
  const maxClients = Number(source.maxClients);
  const metadataSource =
    source.metadata && typeof source.metadata === "object" ? (source.metadata as Record<string, unknown>) : {};

  return {
    roomId,
    name,
    clients: Number.isFinite(clients) ? clients : 0,
    maxClients: Number.isFinite(maxClients) ? maxClients : 0,
    metadata: {
      phase: typeof metadataSource.phase === "string" ? metadataSource.phase : undefined,
      ownerName: typeof metadataSource.ownerName === "string" ? metadataSource.ownerName : undefined,
      playerCount: Number.isFinite(Number(metadataSource.playerCount)) ? Number(metadataSource.playerCount) : undefined,
      maxPlayers: Number.isFinite(Number(metadataSource.maxPlayers)) ? Number(metadataSource.maxPlayers) : undefined,
      hasActiveGame: Boolean(metadataSource.hasActiveGame),
    },
  };
}

const board = requireElement<HTMLDivElement>("#board");
const boardCells = requireElement<HTMLDivElement>("#board-cells");
const boardTiles = requireElement<HTMLDivElement>("#board-tiles");
const tileShelf = requireElement<HTMLDivElement>("#tile-shelf");
const winOverlay = requireElement<HTMLDivElement>("#win-overlay");
const winningTable = requireElement<HTMLDivElement>("#winning-table");
const overlayCloseButton = requireElement<HTMLButtonElement>("#overlay-close-btn");

const statusText = requireElement<HTMLParagraphElement>("#status-text");
const actionText = requireElement<HTMLParagraphElement>("#action-text");
const bagCount = requireElement<HTMLParagraphElement>("#bag-count");
const tradeZone = requireElement<HTMLDivElement>("#trade-zone");
const serveButton = requireElement<HTMLButtonElement>("#serve-btn");

const netStatus = requireElement<HTMLParagraphElement>("#net-status");
const playerNameInput = requireElement<HTMLInputElement>("#player-name-input");
const connectView = requireElement<HTMLDivElement>("#connect-view");
const sessionView = requireElement<HTMLDivElement>("#session-view");
const activePlayerName = requireElement<HTMLParagraphElement>("#active-player-name");
const activeRoomId = requireElement<HTMLParagraphElement>("#active-room-id");
const createRoomButton = requireElement<HTMLButtonElement>("#create-room-btn");
const refreshRoomsButton = requireElement<HTMLButtonElement>("#refresh-rooms-btn");
const availableRoomList = requireElement<HTMLUListElement>("#available-room-list");
const quitRoomButton = requireElement<HTMLButtonElement>("#quit-room-btn");
const roomCard = requireElement<HTMLDivElement>("#room-card");
const bagCard = requireElement<HTMLDivElement>("#bag-card");
const shelfCard = requireElement<HTMLDivElement>("#shelf-card");
const actionCard = requireElement<HTMLDivElement>("#action-card");
const roomControlsRow = requireElement<HTMLDivElement>("#room-controls-row");
const readyButton = requireElement<HTMLButtonElement>("#ready-btn");
const startRoomButton = requireElement<HTMLButtonElement>("#start-room-btn");
const roomDetails = requireElement<HTMLParagraphElement>("#room-details");
const roomPlayerList = requireElement<HTMLUListElement>("#room-player-list");
const roomNotice = requireElement<HTMLParagraphElement>("#room-notice");
const statsSummary = requireElement<HTMLParagraphElement>("#stats-summary");

const localNameSeed = Math.floor(100 + Math.random() * 900);
playerNameInput.value = `Player ${localNameSeed}`;

const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const defaultColyseusEndpoint = `${wsProtocol}://${window.location.hostname}:2567`;
const colyseusEndpoint = import.meta.env.VITE_COLYSEUS_URL || defaultColyseusEndpoint;
const multiplayerClient = new ColyseusClient(colyseusEndpoint);

let state: GameState = createPlaceholderState();
let drag: DragState | null = null;
let isWinOverlayDismissed = true;

let multiplayerRoom: Room | null = null;
let multiplayerSnapshot: MultiplayerRoomSnapshot | null = null;
let multiplayerStats: StatsSnapshot | null = null;
let lobbyRoom: Room | null = null;
let connectingLobby: Promise<void> | null = null;
let listedRooms: ListedRoom[] = [];
let isRefreshingRooms = false;
let roomNoticeLevel: "info" | "error" = "info";
let roomNoticeMessage = "";
let sharedBagCount = 0;
let winningBoardTiles: Array<Tile & { zone: "board"; row: number; col: number }> = [];

function getBoardMetrics(): { width: number; height: number; cellWidth: number; cellHeight: number; tileSize: number } {
  const rect = board.getBoundingClientRect();
  const cellWidth = rect.width / state.config.cols;
  const cellHeight = rect.height / state.config.rows;
  const tileSize = Math.min(cellWidth, cellHeight) * 0.86;
  return {
    width: rect.width,
    height: rect.height,
    cellWidth,
    cellHeight,
    tileSize,
  };
}

function gridToPoint(row: number, col: number): { x: number; y: number } {
  const metrics = getBoardMetrics();
  const x = (col - 1) * metrics.cellWidth + (metrics.cellWidth - metrics.tileSize) * 0.5;
  const y = (row - 1) * metrics.cellHeight + (metrics.cellHeight - metrics.tileSize) * 0.5;
  return { x, y };
}

function pointerInsideElement(clientX: number, clientY: number, element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

function pointerToCell(clientX: number, clientY: number): { row: number; col: number } | null {
  const rect = board.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return null;
  }

  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const col = Math.min(state.config.cols, Math.max(1, Math.floor((x / rect.width) * state.config.cols) + 1));
  const row = Math.min(state.config.rows, Math.max(1, Math.floor((y / rect.height) * state.config.rows) + 1));
  return { row, col };
}

function getLocalRoomPlayer(): MultiplayerPlayerSnapshot | null {
  if (!multiplayerRoom || !multiplayerSnapshot) {
    return null;
  }
  return multiplayerSnapshot.players[multiplayerRoom.sessionId] ?? null;
}

function isServerAuthoritativePlaying(): boolean {
  return Boolean(multiplayerRoom && multiplayerSnapshot?.phase === "playing");
}

function setRoomNotice(level: "info" | "error", message: string): void {
  roomNoticeLevel = level;
  roomNoticeMessage = message;
}

function sortListedRooms(rooms: ListedRoom[]): ListedRoom[] {
  return [...rooms].sort((a, b) => {
    const aCount = a.metadata.playerCount ?? a.clients;
    const bCount = b.metadata.playerCount ?? b.clients;
    if (aCount !== bCount) {
      return bCount - aCount;
    }
    return a.roomId.localeCompare(b.roomId);
  });
}

function upsertListedRoom(room: ListedRoom): void {
  const index = listedRooms.findIndex((entry) => entry.roomId === room.roomId);
  if (index >= 0) {
    listedRooms[index] = room;
  } else {
    listedRooms.push(room);
  }
  listedRooms = sortListedRooms(listedRooms);
}

function removeListedRoom(roomId: string): void {
  listedRooms = listedRooms.filter((entry) => entry.roomId !== roomId);
}

function renderAvailableRooms(): void {
  availableRoomList.innerHTML = "";
  const visibleRooms = listedRooms.filter((room) => room.name === "bisquits");

  if (visibleRooms.length === 0) {
    const item = document.createElement("li");
    item.className = "room-list-empty";
    item.textContent = isRefreshingRooms ? "Refreshing open rooms..." : "No open rooms right now.";
    availableRoomList.append(item);
    return;
  }

  for (const room of visibleRooms) {
    const item = document.createElement("li");
    item.className = "room-list-item";

    const header = document.createElement("div");
    header.className = "room-list-heading";
    const phase = room.metadata.phase ?? (room.metadata.hasActiveGame ? "playing" : "lobby");
    const count = room.metadata.playerCount ?? room.clients;
    const cap = room.metadata.maxPlayers ?? room.maxClients;
    header.textContent = `${room.roomId} · ${phase} · ${count}/${cap}`;

    const detail = document.createElement("div");
    detail.className = "room-list-meta";
    const ownerName = room.metadata.ownerName ? `Host: ${room.metadata.ownerName}` : "Host unknown";
    detail.textContent = ownerName;

    const joinButton = document.createElement("button");
    joinButton.type = "button";
    joinButton.className = "button button-muted room-join-btn";
    joinButton.textContent = "Join";
    joinButton.disabled = multiplayerRoom?.roomId === room.roomId;
    joinButton.addEventListener("click", () => {
      void connectToRoom("join", room.roomId);
    });

    item.append(header, detail, joinButton);
    availableRoomList.append(item);
  }
}

async function ensureLobbyConnection(): Promise<void> {
  if (lobbyRoom) {
    return;
  }
  if (connectingLobby) {
    await connectingLobby;
    return;
  }

  connectingLobby = (async () => {
    try {
      const room = await multiplayerClient.joinOrCreate("lobby");
      lobbyRoom = room;

      room.onMessage("rooms", (payload: unknown) => {
        const next = Array.isArray(payload) ? payload.map(normalizeListedRoom).filter(Boolean) as ListedRoom[] : [];
        listedRooms = sortListedRooms(next);
        isRefreshingRooms = false;
        renderAvailableRooms();
      });

      room.onMessage("+", (payload: unknown) => {
        if (Array.isArray(payload) && payload.length >= 2) {
          const normalized = normalizeListedRoom(payload[1]);
          if (normalized) {
            upsertListedRoom(normalized);
            renderAvailableRooms();
          }
        }
      });

      room.onMessage("-", (payload: unknown) => {
        const roomId = typeof payload === "string" ? payload : "";
        if (roomId) {
          removeListedRoom(roomId);
          renderAvailableRooms();
        }
      });

      room.onLeave(() => {
        lobbyRoom = null;
      });

      room.send("filter", { name: "bisquits" });
    } catch {
      // Keep multiplayer flow working even if lobby feed isn't available.
    } finally {
      connectingLobby = null;
      isRefreshingRooms = false;
      renderAvailableRooms();
    }
  })();

  await connectingLobby;
}

async function refreshOpenRooms(): Promise<void> {
  isRefreshingRooms = true;
  renderAvailableRooms();
  await ensureLobbyConnection();
  lobbyRoom?.send("filter", { name: "bisquits" });
}

async function leaveRoomSilently(): Promise<void> {
  if (!multiplayerRoom) {
    return;
  }
  const roomToLeave = multiplayerRoom;
  multiplayerRoom = null;
  multiplayerSnapshot = null;
  state = createPlaceholderState();
  sharedBagCount = 0;
  winningBoardTiles = [];
  isWinOverlayDismissed = true;
  try {
    await roomToLeave.leave();
  } catch {
    // Ignore disconnect errors on teardown.
  }
}

function attachRoom(room: Room): void {
  multiplayerRoom = room;
  multiplayerSnapshot = getRoomSnapshot(room);
  winningBoardTiles = [];
  isWinOverlayDismissed = true;
  setRoomNotice("info", `Connected to room ${room.roomId}.`);

  room.onStateChange(() => {
    multiplayerSnapshot = getRoomSnapshot(room);
    renderMultiplayerPanel();
    renderStatus();
  });

  room.onMessage("room_notice", (payload: RoomNoticeMessage) => {
    setRoomNotice(payload?.level ?? "info", payload?.message ?? "");
    renderMultiplayerPanel();
  });

  room.onMessage("stats_snapshot", (payload: StatsSnapshot) => {
    multiplayerStats = payload;
    renderMultiplayerPanel();
  });

  room.onMessage("game_started", () => {
    winningBoardTiles = [];
    isWinOverlayDismissed = true;
    setRoomNotice("info", "Game started.");
    render();
  });

  room.onMessage("game_snapshot", (payload: GameSnapshotMessage) => {
    state = payload.gameState;
    sharedBagCount = Number.isFinite(payload.bagCount) ? payload.bagCount : state.drawPile.length;
    render();
  });

  room.onMessage("game_finished", (payload: GameFinishedMessage) => {
    const winnerName = payload?.winnerName ?? "Unknown";
    const longestWord = payload?.longestWord ? `, longest word: ${payload.longestWord}` : "";
    winningBoardTiles = (Array.isArray(payload?.winningBoardTiles) ? payload.winningBoardTiles : []).filter(
      isBoardTile,
    );
    isWinOverlayDismissed = false;
    setRoomNotice("info", `${winnerName} won${longestWord}.`);
    render();
  });

  room.onMessage("action_rejected", (payload: { message?: string }) => {
    setRoomNotice("error", payload?.message ?? "Action rejected by server.");
    renderMultiplayerPanel();
  });

  room.onError((code, message) => {
    setRoomNotice("error", `Network error (${code}): ${message}`);
    renderMultiplayerPanel();
  });

  room.onLeave((code) => {
    multiplayerRoom = null;
    multiplayerSnapshot = null;
    state = createPlaceholderState();
    sharedBagCount = 0;
    winningBoardTiles = [];
    isWinOverlayDismissed = true;
    setRoomNotice("error", `Disconnected from room (code ${code}).`);
    render();
  });
}

async function connectToRoom(mode: "create" | "join", explicitRoomId = ""): Promise<void> {
  const playerName = sanitizePlayerName(playerNameInput.value);
  playerNameInput.value = playerName;
  const targetRoomId = explicitRoomId.trim();

  createRoomButton.disabled = true;

  try {
    await leaveRoomSilently();
    let joinedRoom: Room;
    if (mode === "create") {
      joinedRoom = await multiplayerClient.create("bisquits", { name: playerName });
    } else if (targetRoomId) {
      joinedRoom = await multiplayerClient.joinById(targetRoomId, { name: playerName });
    } else {
      joinedRoom = await multiplayerClient.joinOrCreate("bisquits", { name: playerName });
    }
    attachRoom(joinedRoom);
    joinedRoom.send("set_name", { name: playerName });
    await refreshOpenRooms();
    render();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to join room.";
    setRoomNotice("error", message);
    renderMultiplayerPanel();
  } finally {
    createRoomButton.disabled = false;
  }
}

function renderGrid(): void {
  boardCells.innerHTML = "";
  boardCells.style.gridTemplateColumns = `repeat(${state.config.cols}, 1fr)`;
  boardCells.style.gridTemplateRows = `repeat(${state.config.rows}, 1fr)`;
  for (let row = 1; row <= state.config.rows; row += 1) {
    for (let col = 1; col <= state.config.cols; col += 1) {
      const cell = document.createElement("div");
      cell.className = "board-cell";
      if ((row + col) % 2 === 0) {
        cell.classList.add("board-cell-alt");
      }
      boardCells.append(cell);
    }
  }
}

function renderBoardTiles(): void {
  const metrics = getBoardMetrics();
  boardTiles.innerHTML = "";

  const sortedTiles = state.tiles
    .filter(isBoardTile)
    .sort((a, b) => {
      if (a.row !== b.row) {
        return a.row - b.row;
      }
      if (a.col !== b.col) {
        return a.col - b.col;
      }
      return compareByTileId(a, b);
    });

  for (const tile of sortedTiles) {
    const tileElement = document.createElement("button");
    tileElement.type = "button";
    tileElement.className = "tile board-tile";
    tileElement.dataset.tileId = tile.id;
    tileElement.textContent = tile.letter;
    tileElement.style.width = `${metrics.tileSize}px`;
    tileElement.style.height = `${metrics.tileSize}px`;
    tileElement.style.fontSize = `${Math.max(20, metrics.tileSize * 0.7)}px`;

    const point = gridToPoint(tile.row, tile.col);
    tileElement.style.transform = `translate(${point.x}px, ${point.y}px)`;
    tileElement.addEventListener("pointerdown", (event) => startDrag(event, tile, tileElement));

    boardTiles.append(tileElement);
  }
}

function renderShelfTiles(): void {
  const metrics = getBoardMetrics();
  tileShelf.innerHTML = "";

  const shelfTileSize = Math.round(Math.max(42, Math.min(66, metrics.tileSize)));
  const shelfTiles = state.tiles.filter((tile) => tile.zone === "staging").sort(compareByTileId);

  if (shelfTiles.length === 0) {
    const message = document.createElement("p");
    message.className = "tile-shelf-empty";
    message.textContent = isServerAuthoritativePlaying() ? "Shelf is empty." : "No active round.";
    tileShelf.append(message);
    return;
  }

  for (const tile of shelfTiles) {
    const tileElement = document.createElement("button");
    tileElement.type = "button";
    tileElement.className = "tile shelf-tile";
    tileElement.dataset.tileId = tile.id;
    tileElement.textContent = tile.letter;
    tileElement.style.width = `${shelfTileSize}px`;
    tileElement.style.height = `${shelfTileSize}px`;
    tileElement.style.fontSize = `${Math.max(20, shelfTileSize * 0.68)}px`;
    tileElement.addEventListener("pointerdown", (event) => startDrag(event, tile, tileElement));
    tileShelf.append(tileElement);
  }
}

function renderStatus(): void {
  if (!multiplayerRoom || !multiplayerSnapshot) {
    statusText.textContent = "Not connected";
    actionText.textContent = "Create or join a room to begin.";
    bagCount.textContent = "--";
    serveButton.disabled = true;
    serveButton.textContent = "Serve Plate";
    return;
  }

  if (multiplayerSnapshot.phase !== "playing") {
    statusText.textContent = "Lobby";
    actionText.textContent = state.lastAction || "Waiting for host to start.";
    bagCount.textContent = "--";
    serveButton.disabled = true;
    serveButton.textContent = "Serve Plate";
    return;
  }

  const statusMap: Record<GameState["status"], string> = {
    running: "Game running",
    won: "You won",
    lost: "You lost",
  };

  statusText.textContent = statusMap[state.status];
  actionText.textContent = state.lastAction;
  bagCount.textContent = `${sharedBagCount}`;

  serveButton.disabled = state.status !== "running" || hasStagingTiles(state);
  serveButton.textContent = sharedBagCount <= state.config.players ? "Serve Final Plate" : "Serve Plate";
}

function renderTradeZoneState(isHovering: boolean): void {
  const disabled = !isServerAuthoritativePlaying() || state.status !== "running" || sharedBagCount <= 3;
  tradeZone.classList.toggle("trade-zone-hover", isHovering && !disabled);
  tradeZone.classList.toggle("trade-zone-disabled", disabled);
}

function renderWinningTable(): void {
  winningTable.innerHTML = "";
  winningTable.style.gridTemplateColumns = `repeat(${state.config.cols}, 1fr)`;
  winningTable.style.gridTemplateRows = `repeat(${state.config.rows}, 1fr)`;
  const boardTilesByCell = new Map<string, Tile & { zone: "board"; row: number; col: number }>();
  for (const tile of winningBoardTiles) {
    boardTilesByCell.set(`${tile.row}:${tile.col}`, tile);
  }

  for (let row = 1; row <= state.config.rows; row += 1) {
    for (let col = 1; col <= state.config.cols; col += 1) {
      const cell = document.createElement("div");
      cell.className = "winning-cell";
      if ((row + col) % 2 === 0) {
        cell.classList.add("winning-cell-alt");
      }

      const tile = boardTilesByCell.get(`${row}:${col}`);
      if (tile) {
        const letter = document.createElement("span");
        letter.className = "winning-letter";
        letter.textContent = tile.letter;
        cell.append(letter);
      }

      winningTable.append(cell);
    }
  }
}

function renderWinOverlay(): void {
  const showOverlay = winningBoardTiles.length > 0 && !isWinOverlayDismissed;
  winOverlay.classList.toggle("overlay-visible", showOverlay);
  winOverlay.setAttribute("aria-hidden", String(!showOverlay));
  document.body.classList.toggle("overlay-open", showOverlay);

  if (showOverlay) {
    renderWinningTable();
  }
}

function renderMultiplayerPanel(): void {
  const currentRoom = multiplayerRoom;
  const snapshot = multiplayerSnapshot;
  refreshRoomsButton.disabled = isRefreshingRooms || connectingLobby !== null;

  if (!currentRoom || !snapshot) {
    netStatus.textContent = `Disconnected (${colyseusEndpoint})`;
    roomCard.classList.add("panel-hidden");
    bagCard.classList.add("panel-hidden");
    shelfCard.classList.add("panel-hidden");
    actionCard.classList.add("panel-hidden");
    connectView.classList.remove("panel-hidden");
    connectView.setAttribute("aria-hidden", "false");
    sessionView.classList.add("panel-hidden");
    sessionView.setAttribute("aria-hidden", "true");
    activePlayerName.textContent = "";
    activeRoomId.textContent = "";
    roomDetails.textContent = "";
    roomPlayerList.innerHTML = "";
    readyButton.disabled = true;
    readyButton.classList.add("panel-hidden");
    startRoomButton.disabled = true;
    startRoomButton.classList.add("panel-hidden");
    roomControlsRow.classList.add("panel-hidden");
    roomControlsRow.classList.add("button-row-single");
    readyButton.textContent = "Ready";
    startRoomButton.textContent = "Start";
  } else {
    const localPlayer = snapshot.players[currentRoom.sessionId] ?? null;
    const phase = snapshot.phase;
    const isPlaying = phase === "playing";
    netStatus.textContent = `Connected · ${phase}`;
    roomCard.classList.remove("panel-hidden");
    bagCard.classList.toggle("panel-hidden", !isPlaying);
    shelfCard.classList.toggle("panel-hidden", !isPlaying);
    actionCard.classList.toggle("panel-hidden", !isPlaying);
    connectView.classList.add("panel-hidden");
    connectView.setAttribute("aria-hidden", "true");
    sessionView.classList.remove("panel-hidden");
    sessionView.setAttribute("aria-hidden", "false");
    activePlayerName.textContent = localPlayer?.name ?? playerNameInput.value;
    activeRoomId.textContent = currentRoom.roomId;
    const playerCount = Object.keys(snapshot.players).length;
    roomDetails.textContent = `Room ${currentRoom.roomId} · ${playerCount}/4 players`;

    roomPlayerList.innerHTML = "";
    const players = Object.values(snapshot.players).sort((a, b) => a.name.localeCompare(b.name));
    for (const player of players) {
      const item = document.createElement("li");
      item.className = "player-list-item";
      const isHost = snapshot.ownerClientId === player.clientId;
      const isSelf = currentRoom.sessionId === player.clientId;
      const roleTokens: string[] = [];
      if (isHost) {
        roleTokens.push("HOST");
      }
      if (isSelf) {
        roleTokens.push("YOU");
      }
      roleTokens.push(snapshot.phase === "playing" ? "PLAYING" : player.ready ? "READY" : "NOT READY");
      const tag = roleTokens.join(" · ");
      const longestWord = player.longestWord ? ` · best: ${player.longestWord}` : "";
      item.textContent = `${player.name} (${tag}) · ${player.wins}W/${player.gamesPlayed}G${longestWord}`;
      roomPlayerList.append(item);
    }

    const showReady = snapshot.phase === "lobby";
    readyButton.classList.toggle("panel-hidden", !showReady);
    readyButton.disabled = !localPlayer || !showReady;
    readyButton.textContent = localPlayer?.ready ? "Unready" : "Ready";

    const isHost = snapshot.ownerClientId === currentRoom.sessionId;
    const showStart = showReady && isHost;
    startRoomButton.classList.toggle("panel-hidden", !showStart);
    roomControlsRow.classList.toggle("panel-hidden", !showReady && !showStart);
    roomControlsRow.classList.toggle("button-row-single", !showStart);
    const canStart =
      showReady &&
      isHost &&
      Object.keys(snapshot.players).length >= 2;
    startRoomButton.disabled = !canStart;
    startRoomButton.textContent = snapshot.phase === "playing" ? "Playing" : "Start";
  }

  roomNotice.textContent = roomNoticeMessage;
  roomNotice.classList.toggle("room-notice-error", roomNoticeLevel === "error");

  const latestMatch = multiplayerStats?.recentMatches?.[0];
  if (latestMatch) {
    const longestWordLabel = latestMatch.longestWord ? ` · longest: ${latestMatch.longestWord}` : "";
    statsSummary.textContent = `Last game: ${latestMatch.winnerName}${longestWordLabel} · Total matches: ${multiplayerStats?.totalMatches ?? 0}`;
  } else {
    statsSummary.textContent = "No completed multiplayer games recorded yet.";
  }

  renderAvailableRooms();
}

function render(): void {
  renderBoardTiles();
  renderShelfTiles();
  renderStatus();
  renderTradeZoneState(false);
  renderWinOverlay();
  renderMultiplayerPanel();
}

function createDragProxy(sourceElement: HTMLButtonElement, letter: string): HTMLDivElement {
  const rect = sourceElement.getBoundingClientRect();
  const proxy = document.createElement("div");
  proxy.className = "tile tile-proxy";
  proxy.textContent = letter;
  proxy.style.width = `${rect.width}px`;
  proxy.style.height = `${rect.height}px`;
  proxy.style.fontSize = window.getComputedStyle(sourceElement).fontSize;
  document.body.append(proxy);
  return proxy;
}

function updateDraggedTilePosition(clientX: number, clientY: number): void {
  if (!drag) {
    return;
  }

  const x = clientX - drag.pointerOffsetX;
  const y = clientY - drag.pointerOffsetY;
  drag.dragProxy.style.transform = `translate(${x}px, ${y}px)`;
}

function stopDraggingVisualState(): void {
  board.classList.remove("board-drag-active");
  tradeZone.classList.remove("trade-zone-hover");
  document.body.classList.remove("dragging-active");
}

function endDrag(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) {
    return;
  }

  const activeDrag = drag;
  const draggedTileId = activeDrag.tileId;
  const dropInTrade =
    activeDrag.isOverTradeZone || pointerInsideElement(event.clientX, event.clientY, tradeZone);
  const targetCell = pointerToCell(event.clientX, event.clientY);

  activeDrag.sourceElement.classList.remove("tile-source-dragging");
  if (activeDrag.sourceElement.hasPointerCapture(event.pointerId)) {
    activeDrag.sourceElement.releasePointerCapture(event.pointerId);
  }
  activeDrag.dragProxy.remove();

  document.removeEventListener("pointermove", onDragMove);
  document.removeEventListener("pointerup", endDrag);
  document.removeEventListener("pointercancel", endDrag);

  drag = null;
  stopDraggingVisualState();

  if (isServerAuthoritativePlaying() && multiplayerRoom) {
    if (dropInTrade) {
      multiplayerRoom.send("action_trade_tile", { tileId: draggedTileId });
    } else if (targetCell) {
      multiplayerRoom.send("action_move_tile", {
        tileId: draggedTileId,
        row: targetCell.row,
        col: targetCell.col,
      });
    }
  }

  render();
}

function onDragMove(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) {
    return;
  }

  updateDraggedTilePosition(event.clientX, event.clientY);
  drag.isOverTradeZone = pointerInsideElement(event.clientX, event.clientY, tradeZone);
  renderTradeZoneState(drag.isOverTradeZone);
}

function startDrag(event: PointerEvent, tile: Tile, element: HTMLButtonElement): void {
  if (!isServerAuthoritativePlaying() || !multiplayerRoom || state.status !== "running" || drag) {
    return;
  }

  const sourceRect = element.getBoundingClientRect();
  const dragProxy = createDragProxy(element, tile.letter);

  drag = {
    tileId: tile.id,
    pointerId: event.pointerId,
    pointerOffsetX: event.clientX - sourceRect.left,
    pointerOffsetY: event.clientY - sourceRect.top,
    sourceElement: element,
    dragProxy,
    isOverTradeZone: false,
  };

  board.classList.add("board-drag-active");
  document.body.classList.add("dragging-active");
  element.classList.add("tile-source-dragging");
  element.setPointerCapture(event.pointerId);

  updateDraggedTilePosition(event.clientX, event.clientY);

  document.addEventListener("pointermove", onDragMove);
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);

  event.preventDefault();
}

createRoomButton.addEventListener("click", () => {
  void connectToRoom("create");
});

refreshRoomsButton.addEventListener("click", () => {
  void refreshOpenRooms();
});

readyButton.addEventListener("click", () => {
  if (!multiplayerRoom || !multiplayerSnapshot || multiplayerSnapshot.phase === "playing") {
    return;
  }
  const localPlayer = getLocalRoomPlayer();
  if (!localPlayer) {
    return;
  }

  const nextReady = !localPlayer.ready;
  multiplayerRoom.send("set_ready", { ready: nextReady });

  const localSnapshotPlayer = multiplayerSnapshot.players[multiplayerRoom.sessionId];
  if (localSnapshotPlayer) {
    localSnapshotPlayer.ready = nextReady;
    renderMultiplayerPanel();
  }
});

startRoomButton.addEventListener("click", () => {
  multiplayerRoom?.send("start_game");
});

quitRoomButton.addEventListener("click", () => {
  void (async () => {
    await leaveRoomSilently();
    setRoomNotice("info", "Left room.");
    render();
  })();
});

playerNameInput.addEventListener("change", () => {
  const nextName = sanitizePlayerName(playerNameInput.value);
  playerNameInput.value = nextName;
});

serveButton.addEventListener("click", () => {
  if (!isServerAuthoritativePlaying()) {
    setRoomNotice("error", "No active round. Ask the host to start a game.");
    renderMultiplayerPanel();
    return;
  }

  multiplayerRoom?.send("action_serve_plate");
});

overlayCloseButton.addEventListener("click", () => {
  isWinOverlayDismissed = true;
  renderWinOverlay();
});

const boardResizeObserver = new ResizeObserver(() => {
  renderBoardTiles();
  renderShelfTiles();
});
boardResizeObserver.observe(board);

window.addEventListener("beforeunload", () => {
  void leaveRoomSilently();
});

renderGrid();
void refreshOpenRooms();
render();
