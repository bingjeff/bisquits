import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { LobbyRoom, Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { BisquitsRoom } from "./rooms/BisquitsRoom";
import { statsStore } from "./stats/StatsStore";

const port = Number(process.env.PORT ?? process.env.COLYSEUS_PORT ?? 2567);
const host = process.env.COLYSEUS_HOST ?? "0.0.0.0";
const clientDistRoot = join(process.cwd(), "dist", "client");

const mimeByExt: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function isUnderRoot(root: string, candidate: string): boolean {
  const normalizedRoot = normalize(root + "/");
  const normalizedCandidate = normalize(candidate);
  return normalizedCandidate.startsWith(normalizedRoot);
}

async function tryServeFile(res: ServerResponse, absolutePath: string, method: string): Promise<boolean> {
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      return false;
    }

    const ext = extname(absolutePath).toLowerCase();
    const contentType = mimeByExt[ext] ?? "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable");
    res.statusCode = 200;
    if (method === "HEAD") {
      res.end();
      return true;
    }
    const content = await readFile(absolutePath);
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (res.headersSent || res.writableEnded) {
    return;
  }

  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    return;
  }

  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(requestUrl.pathname);

  if (pathname === "/healthz") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("ok");
    return;
  }

  if (pathname.startsWith("/matchmake")) {
    return;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const requestedFilePath = join(clientDistRoot, relativePath);
  if (!isUnderRoot(clientDistRoot, requestedFilePath)) {
    res.statusCode = 400;
    res.end("Bad request");
    return;
  }

  const servedFile = await tryServeFile(res, requestedFilePath, method);
  if (servedFile) {
    return;
  }

  // SPA fallback: only for extensionless paths.
  if (!relativePath.includes(".")) {
    const fallbackPath = join(clientDistRoot, "index.html");
    const servedFallback = await tryServeFile(res, fallbackPath, method);
    if (servedFallback) {
      return;
    }
  }

  if (!res.headersSent && !res.writableEnded) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found");
  }
}

const httpServer = createServer((req, res) => {
  void handleHttpRequest(req, res);
});

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
