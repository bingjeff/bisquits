import { createServer } from "node:http";
import { LobbyRoom, Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { BisquitsRoom } from "./rooms/BisquitsRoom";
import { statsStore } from "./stats/StatsStore";

const port = Number(process.env.COLYSEUS_PORT ?? 2567);

const httpServer = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

const gameServer = new Server({
  transport: new WebSocketTransport({
    server: httpServer,
  }),
});

gameServer.define("lobby", LobbyRoom);
gameServer.define("bisquits", BisquitsRoom).enableRealtimeListing();

await statsStore.init();
await gameServer.listen(port);
console.log(`[colyseus] listening on ws://localhost:${port}`);

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
