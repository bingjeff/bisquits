import { createServer } from "node:http";
import { LobbyRoom, Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { BisquitsRoom } from "./rooms/BisquitsRoom";
import { statsStore } from "./stats/StatsStore";

const port = Number(process.env.COLYSEUS_PORT ?? 2567);
const host = process.env.COLYSEUS_HOST ?? "0.0.0.0";

const httpServer = createServer();

const gameServer = new Server({
  transport: new WebSocketTransport({
    server: httpServer,
  }),
});

gameServer.define("lobby", LobbyRoom);
gameServer.define("bisquits", BisquitsRoom).enableRealtimeListing();

await statsStore.init();
await gameServer.listen(port, host);
const hostLabel = host === "0.0.0.0" ? "0.0.0.0 (all interfaces)" : host;
console.log(`[colyseus] listening on ws://${hostLabel}:${port}`);

let isShuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`[colyseus] ${signal} received, shutting down`);
  try {
    await gameServer.gracefullyShutdown();
  } catch {
    // Ignore shutdown races (for example when process manager sends repeated signals).
  }
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
