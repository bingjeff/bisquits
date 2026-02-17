import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPressureTick,
  canTradeTile,
  createGame,
  moveTile,
  servePlate,
  tradeTile,
  type GameState,
} from "../shared/game/engine";

function firstStagingTileId(state: GameState): string {
  const tile = state.tiles.find((candidate) => candidate.zone === "staging");
  assert.ok(tile, "expected at least one staging tile");
  return tile.id;
}

test("createGame clamps players and populates shelf", () => {
  const state = createGame({ players: 9 }, () => 0.42);

  assert.equal(state.config.players, 4);
  assert.equal(state.status, "running");
  assert.equal(state.tiles.filter((tile) => tile.zone === "staging").length, state.config.initialVisibleTiles);
  assert.equal(state.turn, state.config.initialVisibleTiles);
});

test("moveTile places a staging tile on board", () => {
  const state = createGame({ players: 2, initialVisibleTiles: 3, rows: 6, cols: 6 }, () => 0.25);
  const tileId = firstStagingTileId(state);

  const next = moveTile(state, tileId, 2, 3);
  const moved = next.tiles.find((tile) => tile.id === tileId);

  assert.ok(moved);
  assert.equal(moved.zone, "board");
  assert.equal(moved.row, 2);
  assert.equal(moved.col, 3);
  assert.match(next.lastAction, /Placed/);
});

test("moveTile swaps board tiles when destination is occupied", () => {
  let state = createGame({ players: 2, initialVisibleTiles: 2, rows: 6, cols: 6 }, () => 0.75);
  const staging = state.tiles.filter((tile) => tile.zone === "staging");
  assert.equal(staging.length, 2);

  state = moveTile(state, staging[0].id, 1, 1);
  state = moveTile(state, staging[1].id, 1, 2);

  const swapped = moveTile(state, staging[0].id, 1, 2);
  const first = swapped.tiles.find((tile) => tile.id === staging[0].id);
  const second = swapped.tiles.find((tile) => tile.id === staging[1].id);

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.zone, "board");
  assert.equal(second.zone, "board");
  assert.equal(first.row, 1);
  assert.equal(first.col, 2);
  assert.equal(second.row, 1);
  assert.equal(second.col, 1);
  assert.match(swapped.lastAction, /Swapped/);
});

test("tradeTile exchanges one tile for three", () => {
  const state = createGame({ players: 2, initialVisibleTiles: 4 }, () => 0.11);
  const tileId = firstStagingTileId(state);

  assert.equal(canTradeTile(state), true);
  const traded = tradeTile(state, tileId, () => 0);

  assert.equal(traded.turn, state.turn + 1);
  assert.equal(traded.tiles.length, state.tiles.length + 2);
  assert.equal(traded.drawPile.length, state.drawPile.length - 2);
  assert.match(traded.lastAction, /Traded/);

  // Ensure the input state wasn't mutated.
  assert.equal(state.tiles.length, 4);
});

test("servePlate ends in win when no full round can be served", () => {
  const state = createGame({ players: 4, initialVisibleTiles: 0 }, () => 0.33);
  const nearEnd: GameState = {
    ...state,
    drawPile: Array.from({ length: state.config.players }, () => "A"),
    lastAction: "Before final serve",
  };

  const served = servePlate(nearEnd);

  assert.equal(served.status, "won");
  assert.match(served.lastAction, /won/i);
});

test("applyPressureTick ends in loss when no full round can be served", () => {
  const state = createGame({ players: 4, initialVisibleTiles: 0 }, () => 0.66);
  const nearEnd: GameState = {
    ...state,
    drawPile: Array.from({ length: state.config.players }, () => "A"),
    lastAction: "Before pressure",
  };

  const pressured = applyPressureTick(nearEnd);

  assert.equal(pressured.status, "lost");
  assert.notEqual(pressured.lastAction, nearEnd.lastAction);
  assert.equal(pressured.lastAction.length > 0, true);
});
