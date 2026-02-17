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
      if (output.includes(`listening on ws://localhost:${port}`)) {
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
    const snapshotPromise = waitForMessage<{
      reason: string;
      nextPressureAt: number;
      gameState: { status: string; tiles: unknown[] };
    }>(hostRoom, "game_snapshot", 7000);

    hostRoom.send("set_ready", { ready: true });
    guestRoom.send("set_ready", { ready: true });
    hostRoom.send("start_game");

    await startedPromise;
    const snapshot = await snapshotPromise;

    assert.equal(snapshot.reason, "start_game");
    assert.equal(snapshot.nextPressureAt, 0);
    assert.equal(snapshot.gameState.status, "running");
    assert.ok(Array.isArray(snapshot.gameState.tiles));
    assert.ok(snapshot.gameState.tiles.length > 0);

    const logs = server.logs();
    assert.equal(logs.includes("ERR_HTTP_HEADERS_SENT"), false, logs);
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

    if (lobbyRoom) {
      await lobbyRoom.leave().catch(() => {
        // Ignore teardown race conditions.
      });
    }

    await server.stop();
  }
});
