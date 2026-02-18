import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";

import { Client as ColyseusClient, type Room } from "colyseus.js";

interface StartedServer {
  child: ChildProcessWithoutNullStreams;
  logs: () => string;
  stop: () => Promise<void>;
}

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("Unable to allocate test port.")));
        return;
      }

      const port = address.port;
      probe.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

function startServer(port: number): Promise<StartedServer> {
  const child = spawn("pnpm", ["run", "server"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COLYSEUS_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) {
      return;
    }

    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Process may already be gone.
      }
    } else {
      child.kill("SIGTERM");
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode !== null) {
          return;
        }
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // Process may already be gone.
          }
        } else {
          child.kill("SIGKILL");
        }
      }, 4000);

      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      await stop();
      reject(new Error(`Timed out waiting for server startup.\n${output}`));
    }, 15000);

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before startup (code=${code}, signal=${signal}).\n${output}`));
    });

    const interval = setInterval(() => {
      if (output.includes("[colyseus] listening on ws://") && output.includes(`:${port}`)) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve({
          child,
          logs: () => output,
          stop,
        });
      }
    }, 50);
  });
}

function roomStateToJson(room: Room): Record<string, unknown> {
  const state = room.state as { toJSON?: () => unknown };
  if (state && typeof state.toJSON === "function") {
    return state.toJSON() as Record<string, unknown>;
  }
  return (state as Record<string, unknown>) ?? {};
}

function waitForRoomState(
  room: Room,
  predicate: (json: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const checkAndResolve = (): boolean => {
      const json = roomStateToJson(room);
      if (predicate(json)) {
        clearTimeout(timer);
        resolve(json);
        return true;
      }
      return false;
    };

    if (checkAndResolve()) {
      return;
    }

    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for room state. Last state: ${JSON.stringify(roomStateToJson(room))}`));
    }, timeoutMs);

    room.onStateChange(() => {
      checkAndResolve();
    });
  });
}

function waitForMessage<T>(room: Room, type: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for room message '${type}'.`));
    }, timeoutMs);

    room.onMessage(type, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function waitForGameSnapshot(
  room: Room,
  predicate: (snapshot: {
    reason: string;
    actorClientId?: string;
    bagCount?: number;
    nextPressureAt?: number;
    gameState: { status?: string; tiles: unknown[] };
  }) => boolean,
  timeoutMs = 5000,
): Promise<{
  reason: string;
  actorClientId?: string;
  bagCount?: number;
  nextPressureAt?: number;
  gameState: { status?: string; tiles: unknown[] };
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for matching game_snapshot."));
    }, timeoutMs);

    room.onMessage("game_snapshot", (payload) => {
      const snapshot = payload as {
        reason: string;
        actorClientId?: string;
        bagCount?: number;
        nextPressureAt?: number;
        gameState: { status?: string; tiles: unknown[] };
      };
      if (!predicate(snapshot)) {
        return;
      }
      clearTimeout(timer);
      resolve(snapshot);
    });
  });
}

function stagingTileCount(snapshot: { gameState: { tiles: unknown[] } }): number {
  const entries = Array.isArray(snapshot.gameState.tiles) ? snapshot.gameState.tiles : [];
  return entries.reduce((count, entry) => {
    if (!entry || typeof entry !== "object") {
      return count;
    }
    const candidate = entry as Record<string, unknown>;
    return candidate.zone === "staging" ? count + 1 : count;
  }, 0);
}

function stagingTileIds(snapshot: { gameState: { tiles: unknown[] } }): string[] {
  const entries = Array.isArray(snapshot.gameState.tiles) ? snapshot.gameState.tiles : [];
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (candidate.zone === "staging" && typeof candidate.id === "string") {
      ids.push(candidate.id);
    }
  }
  return ids;
}

function tilePositionById(
  snapshot: { gameState: { tiles: unknown[] } },
  tileId: string,
): { zone: string; row: number | null; col: number | null } | null {
  const entries = Array.isArray(snapshot.gameState.tiles) ? snapshot.gameState.tiles : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (candidate.id !== tileId) {
      continue;
    }
    return {
      zone: String(candidate.zone ?? ""),
      row: typeof candidate.row === "number" ? candidate.row : null,
      col: typeof candidate.col === "number" ? candidate.col : null,
    };
  }
  return null;
}

function roomPlayerBySessionId(json: Record<string, unknown>, sessionId: string): Record<string, unknown> | null {
  const players = (json.players as Record<string, unknown>) ?? {};
  const entry = players[sessionId];
  if (!entry || typeof entry !== "object") {
    return null;
  }
  return entry as Record<string, unknown>;
}

function roomBoardByPlayerId(json: Record<string, unknown>, playerId: string): Record<string, unknown> | null {
  const boards = (json.boards as Record<string, unknown>) ?? {};
  const entry = boards[playerId];
  if (!entry || typeof entry !== "object") {
    return null;
  }
  return entry as Record<string, unknown>;
}

test("multiplayer integration: create, join, ready, start", { timeout: 60000 }, async () => {
  const port = await getRandomPort();
  const server = await startServer(port);

  const endpoint = `ws://localhost:${port}`;
  const hostClient = new ColyseusClient(endpoint);
  const guestClient = new ColyseusClient(endpoint);
  const lobbyClient = new ColyseusClient(endpoint);

  let hostRoom: Room | null = null;
  let guestRoom: Room | null = null;
  let lobbyRoom: Room | null = null;

  try {
    hostRoom = await hostClient.create("bisquits", { name: "Host" });
    guestRoom = await guestClient.joinById(hostRoom.roomId, { name: "Guest" });
    lobbyRoom = await lobbyClient.joinOrCreate("lobby");

    hostRoom.onMessage("*", () => {
      // Ignore unrelated room messages in this test.
    });
    guestRoom.onMessage("*", () => {
      // Ignore unrelated room messages in this test.
    });
    lobbyRoom.onMessage("*", () => {
      // Ignore unrelated room messages in this test.
    });

    const listedRoomsPromise = waitForMessage<unknown[]>(lobbyRoom, "rooms", 7000);
    lobbyRoom.send("filter", { name: "bisquits" });
    const listedRooms = await listedRoomsPromise;
    const roomIds = (Array.isArray(listedRooms) ? listedRooms : [])
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return "";
        }
        const candidate = entry as Record<string, unknown>;
        return typeof candidate.roomId === "string" ? candidate.roomId : "";
      })
      .filter((roomId) => roomId.length > 0);
    assert.equal(roomIds.includes(hostRoom.roomId), true);

    await waitForRoomState(
      hostRoom,
      (json) => {
        const players = (json.players as Record<string, unknown>) ?? {};
        return Object.keys(players).length === 2;
      },
      7000,
    );

    const stateAfterJoin = roomStateToJson(hostRoom);
    const playersAfterJoin = Object.values((stateAfterJoin.players as Record<string, unknown>) ?? {}) as Array<
      Record<string, unknown>
    >;
    const joinedNames = playersAfterJoin.map((player) => String(player.name ?? ""));
    assert.equal(joinedNames.includes("Host"), true);
    assert.equal(joinedNames.includes("Guest"), true);

    const startedPromise = waitForMessage<{ startedAt: number }>(hostRoom, "game_started", 7000);
    const snapshotPromise = waitForGameSnapshot(
      hostRoom,
      (snapshot) => snapshot.reason === "start_game" && snapshot.gameState.status === "running",
      7000,
    );
    const guestStartSnapshotPromise = waitForGameSnapshot(
      guestRoom,
      (snapshot) => snapshot.reason === "start_game" && snapshot.gameState.status === "running",
      7000,
    );

    hostRoom.send("set_ready", { ready: true });
    guestRoom.send("set_ready", { ready: true });
    hostRoom.send("start_game");

    await startedPromise;
    const snapshot = await snapshotPromise;
    const guestStartSnapshot = await guestStartSnapshotPromise;

    assert.equal(snapshot.reason, "start_game");
    assert.equal(snapshot.nextPressureAt, 0);
    assert.equal(snapshot.gameState.status, "running");
    assert.equal(typeof snapshot.bagCount, "number");
    assert.ok(Array.isArray(snapshot.gameState.tiles));
    assert.ok(snapshot.gameState.tiles.length > 0);
    assert.equal(guestStartSnapshot.reason, "start_game");
    assert.equal(guestStartSnapshot.nextPressureAt, 0);
    assert.equal(snapshot.bagCount, guestStartSnapshot.bagCount);

    const guestSawHostMovePromise = waitForMessage<{
      reason: string;
      actorClientId?: string;
      gameState: { tiles: unknown[] };
    }>(guestRoom, "game_snapshot", 900)
      .then((message) => message.reason === "move_tile" && message.actorClientId === hostRoom.sessionId)
      .catch(() => false);

    const hostMoveSnapshotPromise = waitForGameSnapshot(
      hostRoom,
      (message) => message.reason === "move_tile" && message.actorClientId === hostRoom.sessionId,
      7000,
    );
    hostRoom.send("action_move_tile", { tileId: "t1", row: 1, col: 1 });
    const hostMoveSnapshot = await hostMoveSnapshotPromise;
    const guestSawHostMove = await guestSawHostMovePromise;

    assert.equal(hostMoveSnapshot.reason, "move_tile");
    assert.equal(hostMoveSnapshot.actorClientId, hostRoom.sessionId);
    assert.equal(guestSawHostMove, false);
    assert.deepEqual(tilePositionById(hostMoveSnapshot, "t1"), {
      zone: "board",
      row: 1,
      col: 1,
    });
    const stateAfterHostMove = roomStateToJson(hostRoom);
    const hostRoomPlayer = roomPlayerBySessionId(stateAfterHostMove, hostRoom.sessionId);
    assert.ok(hostRoomPlayer);
    const hostPlayerId = String(hostRoomPlayer?.playerId ?? "");
    assert.ok(hostPlayerId.length > 0);
    const hostBoard = roomBoardByPlayerId(stateAfterHostMove, hostPlayerId);
    assert.ok(hostBoard);
    const hostBoardTiles = Array.isArray(hostBoard?.tiles) ? hostBoard.tiles : [];
    const t1InHostBoard = (hostBoardTiles as Array<Record<string, unknown>>).find((tile) => tile.id === "t1");
    assert.equal(t1InHostBoard?.zone, "board");
    assert.equal(t1InHostBoard?.row, 1);
    assert.equal(t1InHostBoard?.col, 1);
    assert.deepEqual(tilePositionById(guestStartSnapshot, "t1"), {
      zone: "staging",
      row: null,
      col: null,
    });

    const hostSawGuestMovePromise = waitForGameSnapshot(
      hostRoom,
      () => true,
      900,
    )
      .then((message) => message.reason === "move_tile" && message.actorClientId === guestRoom.sessionId)
      .catch(() => false);

    const guestMoveSnapshotPromise = waitForGameSnapshot(
      guestRoom,
      (message) => message.reason === "move_tile" && message.actorClientId === guestRoom.sessionId,
      7000,
    );
    guestRoom.send("action_move_tile", { tileId: "t1", row: 2, col: 2 });
    const guestMoveSnapshot = await guestMoveSnapshotPromise;
    const hostSawGuestMove = await hostSawGuestMovePromise;

    assert.equal(guestMoveSnapshot.reason, "move_tile");
    assert.equal(guestMoveSnapshot.actorClientId, guestRoom.sessionId);
    assert.equal(hostSawGuestMove, false);
    assert.deepEqual(tilePositionById(guestMoveSnapshot, "t1"), {
      zone: "board",
      row: 2,
      col: 2,
    });

    const bagBeforeTrade = snapshot.bagCount ?? 0;
    const hostTradeSnapshotPromise = waitForGameSnapshot(
      hostRoom,
      (message) => message.reason === "trade_tile" && message.actorClientId === hostRoom.sessionId,
      7000,
    );
    const guestTradeSnapshotPromise = waitForGameSnapshot(
      guestRoom,
      (message) => message.reason === "trade_tile" && message.actorClientId === hostRoom.sessionId,
      7000,
    );
    hostRoom.send("action_trade_tile", { tileId: "t1" });
    const hostTradeSnapshot = await hostTradeSnapshotPromise;
    const guestTradeSnapshot = await guestTradeSnapshotPromise;
    assert.equal(hostTradeSnapshot.bagCount, bagBeforeTrade - 2);
    assert.equal(guestTradeSnapshot.bagCount, hostTradeSnapshot.bagCount);

    const rejectedServePromise = waitForMessage<{ message?: string }>(hostRoom, "action_rejected", 5000);
    hostRoom.send("action_serve_plate");
    const rejectedServe = await rejectedServePromise;
    assert.match(String(rejectedServe.message ?? ""), /Place all tray tiles/i);

    let hostStateForServe = hostTradeSnapshot;
    const idsToPlace = stagingTileIds(hostStateForServe);
    for (let i = 0; i < idsToPlace.length; i += 1) {
      const tileId = idsToPlace[i];
      const row = Math.floor((i + 1) / 12) + 1;
      const col = ((i + 1) % 12) + 1;
      const nextHostMovePromise = waitForGameSnapshot(
        hostRoom,
        (message) =>
          message.reason === "move_tile" &&
          message.actorClientId === hostRoom.sessionId &&
          tilePositionById(message, tileId)?.zone === "board",
        7000,
      );
      hostRoom.send("action_move_tile", { tileId, row, col });
      hostStateForServe = await nextHostMovePromise;
    }

    assert.equal(stagingTileCount(hostStateForServe), 0);

    const guestStagingBeforeServe = stagingTileCount(guestTradeSnapshot);
    const hostServeSnapshotPromise = waitForGameSnapshot(
      hostRoom,
      (message) => message.reason === "serve_plate" && message.actorClientId === hostRoom.sessionId,
      7000,
    );
    const guestServeSnapshotPromise = waitForGameSnapshot(
      guestRoom,
      (message) => message.reason === "serve_plate" && message.actorClientId === hostRoom.sessionId,
      7000,
    );

    hostRoom.send("action_serve_plate");

    const hostServeSnapshot = await hostServeSnapshotPromise;
    const guestServeSnapshot = await guestServeSnapshotPromise;
    assert.equal(hostServeSnapshot.bagCount, guestServeSnapshot.bagCount);
    assert.equal(stagingTileCount(hostServeSnapshot) > 0, true);
    assert.equal(stagingTileCount(guestServeSnapshot), guestStagingBeforeServe + 1);

    const logs = server.logs();
    assert.equal(logs.includes("ERR_HTTP_HEADERS_SENT"), false, logs);
  } finally {
    if (guestRoom) {
      await guestRoom.leave().catch(() => {
        // Ignore teardown race conditions.
      });
    }

    if (lobbyRoom) {
      await lobbyRoom.leave().catch(() => {
        // Ignore teardown race conditions.
      });
    }

    await server.stop();
  }
});

test("multiplayer integration: late join contributes to shared bag burn on serve", { timeout: 60000 }, async () => {
  const port = await getRandomPort();
  const server = await startServer(port);

  const endpoint = `ws://localhost:${port}`;
  const hostClient = new ColyseusClient(endpoint);
  const guestClient = new ColyseusClient(endpoint);
  const lateClient = new ColyseusClient(endpoint);

  let hostRoom: Room | null = null;
  let guestRoom: Room | null = null;
  let lateRoom: Room | null = null;

  try {
    hostRoom = await hostClient.create("bisquits", { name: "Host" });
    guestRoom = await guestClient.joinById(hostRoom.roomId, { name: "Guest" });

    hostRoom.onMessage("*", () => {
      // Ignore unrelated room messages in this test.
    });
    guestRoom.onMessage("*", () => {
      // Ignore unrelated room messages in this test.
    });

    const startedPromise = waitForMessage<{ startedAt: number }>(hostRoom, "game_started", 7000);
    const hostStartSnapshotPromise = waitForGameSnapshot(
      hostRoom,
      (snapshot) => snapshot.reason === "start_game" && snapshot.gameState.status === "running",
      7000,
    );

    hostRoom.send("set_ready", { ready: true });
    guestRoom.send("set_ready", { ready: true });
    hostRoom.send("start_game");

    await startedPromise;
    let hostSnapshot = await hostStartSnapshotPromise;

    lateRoom = await lateClient.joinById(hostRoom.roomId, { name: "Late" });
    lateRoom.onMessage("*", () => {
      // Ignore unrelated room messages in this test.
    });

    const lateSyncSnapshot = await waitForGameSnapshot(
      lateRoom,
      (snapshot) => snapshot.reason === "sync" && snapshot.gameState.status === "running",
      7000,
    );
    const bagBeforeServe = hostSnapshot.bagCount ?? 0;
    assert.equal(lateSyncSnapshot.bagCount, bagBeforeServe);

    const idsToPlace = stagingTileIds(hostSnapshot);
    for (let i = 0; i < idsToPlace.length; i += 1) {
      const tileId = idsToPlace[i];
      const row = Math.floor((i + 1) / 16) + 1;
      const col = ((i + 1) % 16) + 1;
      const nextHostMovePromise = waitForGameSnapshot(
        hostRoom,
        (message) =>
          message.reason === "move_tile" &&
          message.actorClientId === hostRoom.sessionId &&
          tilePositionById(message, tileId)?.zone === "board",
        7000,
      );
      hostRoom.send("action_move_tile", { tileId, row, col });
      hostSnapshot = await nextHostMovePromise;
    }

    assert.equal(stagingTileCount(hostSnapshot), 0);

    const hostServeSnapshotPromise = waitForGameSnapshot(
      hostRoom,
      (message) => message.reason === "serve_plate" && message.actorClientId === hostRoom.sessionId,
      7000,
    );
    const guestServeSnapshotPromise = waitForGameSnapshot(
      guestRoom,
      (message) => message.reason === "serve_plate" && message.actorClientId === hostRoom.sessionId,
      7000,
    );
    const lateServeSnapshotPromise = waitForGameSnapshot(
      lateRoom,
      (message) => message.reason === "serve_plate" && message.actorClientId === hostRoom.sessionId,
      7000,
    );

    hostRoom.send("action_serve_plate");

    const hostServeSnapshot = await hostServeSnapshotPromise;
    const guestServeSnapshot = await guestServeSnapshotPromise;
    const lateServeSnapshot = await lateServeSnapshotPromise;

    assert.equal(hostServeSnapshot.bagCount, bagBeforeServe - 3);
    assert.equal(guestServeSnapshot.bagCount, hostServeSnapshot.bagCount);
    assert.equal(lateServeSnapshot.bagCount, hostServeSnapshot.bagCount);
  } finally {
    if (hostRoom) {
      await hostRoom.leave().catch(() => {
        // Ignore teardown race conditions.
      });
    }

    if (guestRoom) {
      await guestRoom.leave().catch(() => {
        // Ignore teardown race conditions.
      });
    }

    if (lateRoom) {
      await lateRoom.leave().catch(() => {
        // Ignore teardown race conditions.
      });
    }

    await server.stop();
  }
});

test("multiplayer integration: disconnected player can rejoin reserved seat and recover board", { timeout: 60000 }, async () => {
  const port = await getRandomPort();
  const server = await startServer(port);

  const endpoint = `ws://localhost:${port}`;
  const hostClient = new ColyseusClient(endpoint);
  const guestClient = new ColyseusClient(endpoint);
  const reclaimClient = new ColyseusClient(endpoint);

  let hostRoom: Room | null = null;
  let guestRoom: Room | null = null;
  let reclaimedRoom: Room | null = null;

  try {
    hostRoom = await hostClient.create("bisquits", { name: "Host" });
    guestRoom = await guestClient.joinById(hostRoom.roomId, { name: "Guest" });

    hostRoom.onMessage("*", () => {
      // Ignore unrelated room messages in this test.
    });
    guestRoom.onMessage("*", () => {
      // Ignore unrelated room messages in this test.
    });

    const tokenPromise = waitForMessage<{ token?: string }>(hostRoom, "seat_token", 7000);
    hostRoom.send("request_seat_token");
    const seatTokenPayload = await tokenPromise;
    const resumeToken = String(seatTokenPayload.token ?? "");
    assert.equal(resumeToken.length > 0, true);

    const startedPromise = waitForMessage<{ startedAt: number }>(hostRoom, "game_started", 7000);
    const hostStartSnapshotPromise = waitForGameSnapshot(
      hostRoom,
      (snapshot) => snapshot.reason === "start_game" && snapshot.gameState.status === "running",
      7000,
    );

    hostRoom.send("set_ready", { ready: true });
    guestRoom.send("set_ready", { ready: true });
    hostRoom.send("start_game");

    await startedPromise;
    await hostStartSnapshotPromise;

    const hostMoveSnapshotPromise = waitForGameSnapshot(
      hostRoom,
      (message) => message.reason === "move_tile" && message.actorClientId === hostRoom?.sessionId,
      7000,
    );
    hostRoom.send("action_move_tile", { tileId: "t1", row: 1, col: 1 });
    const hostMoveSnapshot = await hostMoveSnapshotPromise;
    assert.deepEqual(tilePositionById(hostMoveSnapshot, "t1"), {
      zone: "board",
      row: 1,
      col: 1,
    });

    const disconnectedStatePromise = waitForRoomState(
      guestRoom,
      (json) => {
        const players = Object.values((json.players as Record<string, unknown>) ?? {}) as Array<Record<string, unknown>>;
        return players.some((player) => player.name === "Host" && player.connected === false);
      },
      7000,
    );

    void hostRoom.leave(false);
    await disconnectedStatePromise;

    const stateWhileDisconnected = roomStateToJson(guestRoom);
    const hostEntryWhileDisconnected = Object.values(
      (stateWhileDisconnected.players as Record<string, unknown>) ?? {},
    ).find((value) => {
      if (!value || typeof value !== "object") {
        return false;
      }
      const candidate = value as Record<string, unknown>;
      return candidate.name === "Host";
    }) as Record<string, unknown> | undefined;
    assert.ok(hostEntryWhileDisconnected);
    const hostPlayerIdWhileDisconnected = String(hostEntryWhileDisconnected?.playerId ?? "");
    const hostBoardWhileDisconnected = roomBoardByPlayerId(stateWhileDisconnected, hostPlayerIdWhileDisconnected);
    assert.ok(hostBoardWhileDisconnected);
    const disconnectedBoardTiles = Array.isArray(hostBoardWhileDisconnected?.tiles) ? hostBoardWhileDisconnected.tiles : [];
    const t1WhileDisconnected = (disconnectedBoardTiles as Array<Record<string, unknown>>).find((tile) => tile.id === "t1");
    assert.equal(t1WhileDisconnected?.zone, "board");
    assert.equal(t1WhileDisconnected?.row, 1);
    assert.equal(t1WhileDisconnected?.col, 1);

    reclaimedRoom = await reclaimClient.joinById(hostRoom.roomId, {
      name: "Host",
      resumeToken,
    });

    const reclaimedSyncSnapshot = await waitForGameSnapshot(
      reclaimedRoom,
      (message) => message.reason === "sync" && message.gameState.status === "running",
      7000,
    );

    assert.deepEqual(tilePositionById(reclaimedSyncSnapshot, "t1"), {
      zone: "board",
      row: 1,
      col: 1,
    });
  } finally {
    await server.stop();
  }
});
