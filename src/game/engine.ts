export type GameStatus = "running" | "won" | "lost";

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
  row: number;
  col: number;
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

function firstOpenCell(state: GameState): { row: number; col: number } | null {
  const occupied = new Set<string>();
  for (const tile of state.tiles) {
    occupied.add(`${tile.row}:${tile.col}`);
  }

  for (let row = 1; row <= state.config.rows; row += 1) {
    for (let col = 1; col <= state.config.cols; col += 1) {
      if (!occupied.has(`${row}:${col}`)) {
        return { row, col };
      }
    }
  }

  return null;
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

  const cell = firstOpenCell(state);
  if (!cell) {
    return false;
  }

  state.tiles.push({
    id: `t${state.nextTileId}`,
    letter,
    row: cell.row,
    col: cell.col,
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
    lastAction: "Board seeded. Drag tiles, trade one-for-three, and keep serving.",
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
  const occupied = next.tiles.find((item) => item.id !== tileId && item.row === row && item.col === col);

  const originalRow = tile.row;
  const originalCol = tile.col;
  tile.row = row;
  tile.col = col;

  if (occupied) {
    occupied.row = originalRow;
    occupied.col = originalCol;
  }

  next.lastAction = occupied
    ? `Swapped ${tile.letter} with ${occupied.letter}.`
    : `Moved ${tile.letter} to ${row},${col}.`;
  return next;
}
