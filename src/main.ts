import "./style.css";
import {
  applyPressureTick,
  canTradeTile,
  createGame,
  moveTile,
  servePlate,
  tradeTile,
  type GameState,
  type Tile,
} from "./game/engine";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root element.");
}

app.innerHTML = `
  <main class="app-shell">
    <header class="header">
      <div>
        <p class="eyebrow">Bisquits Prototype</p>
        <h1>Single-Client Table</h1>
      </div>
      <div class="header-controls">
        <label for="player-count">Table Size</label>
        <select id="player-count" class="select">
          <option value="2">2 players</option>
          <option value="3">3 players</option>
          <option value="4" selected>4 players</option>
        </select>
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
        <div class="hud-card">
          <p class="label">Status</p>
          <p id="status-text" class="status-text"></p>
          <p id="action-text" class="action-text"></p>
        </div>

        <div class="hud-card">
          <p class="label">Bag Remaining</p>
          <p id="bag-count" class="metric-number"></p>
          <p class="label">Pressure Tick</p>
          <p id="pressure-countdown" class="metric-subtle"></p>
        </div>

        <div id="trade-zone" class="trade-zone" aria-label="Trade zone">
          Drop a tile here to trade one for three.
        </div>

        <div class="button-row">
          <button id="serve-btn" class="button">Serve Plate</button>
          <button id="reset-btn" class="button button-muted">Reset</button>
        </div>
      </aside>
    </section>
  </main>
`;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

const board = requireElement<HTMLDivElement>("#board");
const boardCells = requireElement<HTMLDivElement>("#board-cells");
const boardTiles = requireElement<HTMLDivElement>("#board-tiles");
const playerCountSelect = requireElement<HTMLSelectElement>("#player-count");
const statusText = requireElement<HTMLParagraphElement>("#status-text");
const actionText = requireElement<HTMLParagraphElement>("#action-text");
const bagCount = requireElement<HTMLParagraphElement>("#bag-count");
const pressureCountdown = requireElement<HTMLParagraphElement>("#pressure-countdown");
const tradeZone = requireElement<HTMLDivElement>("#trade-zone");
const serveButton = requireElement<HTMLButtonElement>("#serve-btn");
const resetButton = requireElement<HTMLButtonElement>("#reset-btn");

interface DragState {
  tileId: string;
  pointerId: number;
  pointerOffsetX: number;
  pointerOffsetY: number;
  tileSize: number;
  element: HTMLButtonElement;
}

const rng = Math.random;

let state: GameState = createGame({ players: Number(playerCountSelect.value) }, rng);
let drag: DragState | null = null;
let pressureTimer: number | null = null;
let pressureDeadline = 0;

function randomInRange([min, max]: [number, number]): number {
  const span = max - min;
  return Math.round(min + rng() * span);
}

function clearPressureLoop(): void {
  if (pressureTimer !== null) {
    window.clearTimeout(pressureTimer);
    pressureTimer = null;
  }
  pressureDeadline = 0;
}

function schedulePressureLoop(): void {
  clearPressureLoop();
  if (state.status !== "running") {
    return;
  }

  const delay = randomInRange(state.config.pressureRangeMs);
  pressureDeadline = Date.now() + delay;
  pressureTimer = window.setTimeout(() => {
    state = applyPressureTick(state);
    render();
    schedulePressureLoop();
  }, delay);
}

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

function gridToPoint(tile: Tile): { x: number; y: number } {
  const metrics = getBoardMetrics();
  const x = (tile.col - 1) * metrics.cellWidth + (metrics.cellWidth - metrics.tileSize) * 0.5;
  const y = (tile.row - 1) * metrics.cellHeight + (metrics.cellHeight - metrics.tileSize) * 0.5;
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

function renderGrid(): void {
  boardCells.innerHTML = "";
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

function renderTiles(): void {
  const metrics = getBoardMetrics();
  boardTiles.innerHTML = "";

  const sortedTiles = [...state.tiles].sort((a, b) => {
    if (a.row !== b.row) {
      return a.row - b.row;
    }
    if (a.col !== b.col) {
      return a.col - b.col;
    }
    return a.id.localeCompare(b.id);
  });

  for (const tile of sortedTiles) {
    const tileElement = document.createElement("button");
    tileElement.type = "button";
    tileElement.className = "tile";
    tileElement.dataset.tileId = tile.id;
    tileElement.textContent = tile.letter;
    tileElement.style.width = `${metrics.tileSize}px`;
    tileElement.style.height = `${metrics.tileSize}px`;
    tileElement.style.fontSize = `${Math.max(12, metrics.tileSize * 0.42)}px`;

    const point = gridToPoint(tile);
    tileElement.style.transform = `translate(${point.x}px, ${point.y}px)`;
    tileElement.addEventListener("pointerdown", (event) => startDrag(event, tile, tileElement));

    boardTiles.append(tileElement);
  }
}

function renderStatus(): void {
  const statusMap: Record<GameState["status"], string> = {
    running: "Game running",
    won: "You won",
    lost: "You lost",
  };

  statusText.textContent = statusMap[state.status];
  actionText.textContent = state.lastAction;
  bagCount.textContent = `${state.drawPile.length}`;

  if (state.status !== "running") {
    pressureCountdown.textContent = "Stopped";
  } else if (pressureDeadline > 0) {
    const seconds = Math.max(0, (pressureDeadline - Date.now()) / 1000);
    pressureCountdown.textContent = `${seconds.toFixed(1)}s`;
  } else {
    pressureCountdown.textContent = "Scheduling...";
  }

  serveButton.disabled = state.status !== "running";
  serveButton.textContent = state.drawPile.length <= state.config.players ? "Serve Final Plate" : "Serve Plate";
}

function renderTradeZoneState(isHovering: boolean): void {
  tradeZone.classList.toggle("trade-zone-hover", isHovering);
  tradeZone.classList.toggle("trade-zone-disabled", !canTradeTile(state));
}

function render(): void {
  if (state.status !== "running") {
    clearPressureLoop();
  }
  renderTiles();
  renderStatus();
  renderTradeZoneState(false);
}

function updateDraggedTilePosition(clientX: number, clientY: number): void {
  if (!drag) {
    return;
  }

  const rect = board.getBoundingClientRect();
  const minX = 0;
  const maxX = rect.width - drag.tileSize;
  const minY = 0;
  const maxY = rect.height - drag.tileSize;

  const rawX = clientX - rect.left - drag.pointerOffsetX;
  const rawY = clientY - rect.top - drag.pointerOffsetY;
  const x = Math.max(minX, Math.min(maxX, rawX));
  const y = Math.max(minY, Math.min(maxY, rawY));
  drag.element.style.transform = `translate(${x}px, ${y}px)`;
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

  const draggedTileId = drag.tileId;
  const dropInTrade = pointerInsideElement(event.clientX, event.clientY, tradeZone);
  const targetCell = pointerToCell(event.clientX, event.clientY);

  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", endDrag);
  window.removeEventListener("pointercancel", endDrag);

  drag = null;
  stopDraggingVisualState();

  if (dropInTrade) {
    state = tradeTile(state, draggedTileId, rng);
  } else if (targetCell) {
    state = moveTile(state, draggedTileId, targetCell.row, targetCell.col);
  }

  render();
}

function onDragMove(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) {
    return;
  }

  updateDraggedTilePosition(event.clientX, event.clientY);
  const isHoveringTrade = pointerInsideElement(event.clientX, event.clientY, tradeZone);
  renderTradeZoneState(isHoveringTrade);
}

function startDrag(event: PointerEvent, tile: Tile, element: HTMLButtonElement): void {
  if (state.status !== "running") {
    return;
  }

  const metrics = getBoardMetrics();
  const snapped = gridToPoint(tile);
  const rect = board.getBoundingClientRect();

  drag = {
    tileId: tile.id,
    pointerId: event.pointerId,
    pointerOffsetX: event.clientX - (rect.left + snapped.x),
    pointerOffsetY: event.clientY - (rect.top + snapped.y),
    tileSize: metrics.tileSize,
    element,
  };

  board.classList.add("board-drag-active");
  document.body.classList.add("dragging-active");
  element.classList.add("tile-dragging");
  element.setPointerCapture(event.pointerId);

  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

  event.preventDefault();
}

function resetGame(players: number): void {
  state = createGame({ players }, rng);
  renderGrid();
  render();
  schedulePressureLoop();
}

serveButton.addEventListener("click", () => {
  state = servePlate(state);
  render();
});

resetButton.addEventListener("click", () => {
  resetGame(Number(playerCountSelect.value));
});

playerCountSelect.addEventListener("change", () => {
  resetGame(Number(playerCountSelect.value));
});

const boardResizeObserver = new ResizeObserver(() => {
  renderTiles();
});
boardResizeObserver.observe(board);

window.setInterval(() => {
  if (state.status === "running") {
    renderStatus();
  }
}, 150);

renderGrid();
render();
schedulePressureLoop();
