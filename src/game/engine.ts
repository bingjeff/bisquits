export type GameStatus = "running" | "won" | "lost";
export type TileZone = "board" | "staging";

export interface GameConfig {
  rows: number;
  cols: number;
  players: number;
  initialVisibleTiles: number;
  pressureRangeMs: [number, number];
}

export interface Tile {
  id: string;
  letter: string;
  zone: TileZone;
  row: number | null;
  col: number | null;
}

export interface GameState {
  config: GameConfig;
  status: GameStatus;
  turn: number;
  nextTileId: number;
  drawPile: string[];
  tiles: Tile[];
  lastAction: string;
}

export type RandomSource = () => number;

export const DEFAULT_CONFIG: GameConfig = {
  rows: 12,
  cols: 12,
  players: 4,
  initialVisibleTiles: 12,
  pressureRangeMs: [4500, 8500],
};

const TILE_DISTRIBUTION = [
  "J",
  "K",
  "Q",
  "X",
  "Z",
  "J",
  "K",
  "Q",
  "X",
  "Z",
  "B",
  "C",
  "F",
  "H",
  "M",
  "P",
  "V",
  "W",
  "Y",
  "B",
  "C",
  "F",
  "H",
  "M",
  "P",
  "V",
  "W",
  "Y",
  "B",
  "C",
  "F",
  "H",
  "M",
  "P",
  "V",
  "W",
  "Y",
  "G",
  "G",
  "G",
  "G",
  "L",
  "L",
  "L",
  "L",
  "L",
  "D",
  "S",
  "U",
  "D",
  "S",
  "U",
  "D",
  "S",
  "U",
  "D",
  "S",
  "U",
  "N",
  "N",
  "N",
  "N",
  "N",
  "N",
  "N",
  "N",
  "T",
  "R",
  "T",
  "R",
  "T",
  "R",
  "T",
  "R",
  "T",
  "R",
  "T",
  "R",
  "T",
  "R",
  "T",
  "R",
  "T",
  "R",
  "O",
  "O",
  "O",
  "O",
  "O",
  "O",
  "O",
  "O",
  "O",
  "O",
  "O",
  "I",
  "I",
  "I",
  "I",
  "I",
  "I",
  "I",
  "I",
  "I",
  "I",
  "I",
  "I",
  "A",
  "A",
  "A",
  "A",
  "A",
  "A",
  "A",
  "A",
  "A",
  "A",
  "A",
  "A",
  "A",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
  "E",
];

function clampPlayers(players: number): number {
  return Math.max(2, Math.min(4, Math.round(players)));
}

function shuffle<T>(values: T[], rng: RandomSource): void {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = values[i];
    values[i] = values[j];
    values[j] = tmp;
  }
}

function cloneState(state: GameState): GameState {
  return {
    ...state,
    config: { ...state.config },
    drawPile: [...state.drawPile],
    tiles: state.tiles.map((tile) => ({ ...tile })),
  };
}

function drawOne(drawPile: string[]): string | null {
  const next = drawPile.shift();
  return next ?? null;
}

function addVisibleTile(state: GameState): boolean {
  const letter = drawOne(state.drawPile);
  if (!letter) {
    return false;
  }

  state.tiles.push({
    id: `t${state.nextTileId}`,
    letter,
    zone: "staging",
    row: null,
    col: null,
  });
  state.nextTileId += 1;
  return true;
}

function burnOtherPlayers(state: GameState): boolean {
  const hiddenDrawCount = state.config.players - 1;
  if (state.drawPile.length < hiddenDrawCount) {
    return false;
  }

  state.drawPile.splice(0, hiddenDrawCount);
  return true;
}

function canServeRound(state: GameState): boolean {
  return state.drawPile.length > state.config.players;
}

function insertLetterIntoBag(drawPile: string[], letter: string, rng: RandomSource): void {
  const slot = Math.floor(rng() * (drawPile.length + 1));
  drawPile.splice(slot, 0, letter);
}

function moveTileToStaging(tile: Tile): void {
  tile.zone = "staging";
  tile.row = null;
  tile.col = null;
}

function moveTileToBoard(tile: Tile, row: number, col: number): void {
  tile.zone = "board";
  tile.row = row;
  tile.col = col;
}

function performServeRound(baseState: GameState): GameState {
  const next = cloneState(baseState);
  burnOtherPlayers(next);
  addVisibleTile(next);
  next.turn += 1;
  return next;
}

export function createGame(
  config: Partial<GameConfig> = {},
  rng: RandomSource = Math.random,
): GameState {
  const resolvedConfig: GameConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    players: clampPlayers(config.players ?? DEFAULT_CONFIG.players),
  };

  const drawPile = [...TILE_DISTRIBUTION];
  shuffle(drawPile, rng);

  let state: GameState = {
    config: resolvedConfig,
    status: "running",
    turn: 0,
    nextTileId: 1,
    drawPile,
    tiles: [],
    lastAction: "Game created.",
  };

  for (let i = 0; i < resolvedConfig.initialVisibleTiles; i += 1) {
    if (!canServeRound(state)) {
      break;
    }
    state = performServeRound(state);
  }

  return {
    ...state,
    lastAction: "Shelf stocked. Drag tiles onto the board, trade one-for-three, and keep serving.",
  };
}

export function servePlate(baseState: GameState): GameState {
  if (baseState.status !== "running") {
    return baseState;
  }

  if (!canServeRound(baseState)) {
    return {
      ...baseState,
      status: "won",
      lastAction: "You served the final plate and won.",
    };
  }

  const next = performServeRound(baseState);
  return {
    ...next,
    lastAction: "You served a plate. Opponents also drew hidden tiles.",
  };
}

export function applyPressureTick(baseState: GameState): GameState {
  if (baseState.status !== "running") {
    return baseState;
  }

  if (!canServeRound(baseState)) {
    return {
      ...baseState,
      status: "lost",
      lastAction: "The bag ran dry before your next serve. You lost.",
    };
  }

  const next = performServeRound(baseState);
  return {
    ...next,
    lastAction: "Pressure tick: the table advanced and a new tile arrived.",
  };
}

export function canTradeTile(state: GameState): boolean {
  return state.drawPile.length > 3;
}

export function tradeTile(
  baseState: GameState,
  tileId: string,
  rng: RandomSource = Math.random,
): GameState {
  if (baseState.status !== "running") {
    return baseState;
  }

  if (!canTradeTile(baseState)) {
    return {
      ...baseState,
      lastAction: "Not enough tiles remain to trade.",
    };
  }

  const next = cloneState(baseState);
  const index = next.tiles.findIndex((tile) => tile.id === tileId);
  if (index < 0) {
    return baseState;
  }

  const [discarded] = next.tiles.splice(index, 1);
  insertLetterIntoBag(next.drawPile, discarded.letter, rng);

  for (let i = 0; i < 3; i += 1) {
    addVisibleTile(next);
  }

  next.turn += 1;
  next.lastAction = `Traded ${discarded.letter} for three new tiles.`;
  return next;
}

export function moveTile(baseState: GameState, tileId: string, targetRow: number, targetCol: number): GameState {
  if (baseState.status !== "running") {
    return baseState;
  }

  const next = cloneState(baseState);
  const tile = next.tiles.find((item) => item.id === tileId);
  if (!tile) {
    return baseState;
  }

  const row = Math.max(1, Math.min(next.config.rows, Math.round(targetRow)));
  const col = Math.max(1, Math.min(next.config.cols, Math.round(targetCol)));
  const occupied = next.tiles.find(
    (item) => item.id !== tileId && item.zone === "board" && item.row === row && item.col === col,
  );

  const movedFromBoard = tile.zone === "board";
  const originalRow = tile.row;
  const originalCol = tile.col;
  moveTileToBoard(tile, row, col);

  if (occupied) {
    if (movedFromBoard && originalRow !== null && originalCol !== null) {
      moveTileToBoard(occupied, originalRow, originalCol);
      next.lastAction = `Swapped ${tile.letter} with ${occupied.letter}.`;
    } else {
      moveTileToStaging(occupied);
      next.lastAction = `Placed ${tile.letter} on ${row},${col}; ${occupied.letter} moved to shelf.`;
    }
    return next;
  }

  next.lastAction = movedFromBoard
    ? `Moved ${tile.letter} to ${row},${col}.`
    : `Placed ${tile.letter} on ${row},${col}.`;
  return next;
}
