import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const MAX_RECENT_MATCHES = 25;

export interface MatchRecord {
  roomId: string;
  winnerName: string;
  longestWord: string;
  players: string[];
  playedAt: string;
}

export interface PlayerAggregate {
  name: string;
  gamesPlayed: number;
  wins: number;
  longestWord: string;
  updatedAt: string;
}

export interface StatsSnapshot {
  totalMatches: number;
  recentMatches: MatchRecord[];
  players: Record<string, PlayerAggregate>;
}

interface RecordMatchInput {
  roomId: string;
  winnerName: string;
  longestWord: string;
  players: string[];
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function cloneSnapshot(snapshot: StatsSnapshot): StatsSnapshot {
  return {
    totalMatches: snapshot.totalMatches,
    recentMatches: snapshot.recentMatches.map((match) => ({ ...match, players: [...match.players] })),
    players: Object.fromEntries(
      Object.entries(snapshot.players).map(([key, player]) => [key, { ...player }]),
    ),
  };
}

function emptySnapshot(): StatsSnapshot {
  return {
    totalMatches: 0,
    recentMatches: [],
    players: {},
  };
}

export class StatsStore {
  private readonly filePath: string;
  private snapshot: StatsSnapshot = emptySnapshot();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath = resolve(process.cwd(), "server/data/stats.json")) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StatsSnapshot;
      this.snapshot = {
        totalMatches: Number(parsed.totalMatches) || 0,
        recentMatches: Array.isArray(parsed.recentMatches) ? parsed.recentMatches.slice(0, MAX_RECENT_MATCHES) : [],
        players: typeof parsed.players === "object" && parsed.players ? parsed.players : {},
      };
    } catch {
      this.snapshot = emptySnapshot();
      await this.persist();
    }
  }

  async getSnapshot(): Promise<StatsSnapshot> {
    return cloneSnapshot(this.snapshot);
  }

  async recordMatch(input: RecordMatchInput): Promise<StatsSnapshot> {
    const playedAt = new Date().toISOString();
    const matchRecord: MatchRecord = {
      roomId: input.roomId,
      winnerName: input.winnerName,
      longestWord: input.longestWord,
      players: [...input.players],
      playedAt,
    };

    this.snapshot.totalMatches += 1;
    this.snapshot.recentMatches = [matchRecord, ...this.snapshot.recentMatches].slice(0, MAX_RECENT_MATCHES);

    for (const playerName of input.players) {
      const key = normalizeName(playerName);
      const existing = this.snapshot.players[key] ?? {
        name: playerName,
        gamesPlayed: 0,
        wins: 0,
        longestWord: "",
        updatedAt: playedAt,
      };
      existing.gamesPlayed += 1;
      existing.updatedAt = playedAt;
      this.snapshot.players[key] = existing;
    }

    const winnerKey = normalizeName(input.winnerName);
    const winner = this.snapshot.players[winnerKey];
    if (winner) {
      winner.wins += 1;
      if (input.longestWord.length > winner.longestWord.length) {
        winner.longestWord = input.longestWord;
      }
      winner.updatedAt = playedAt;
    }

    await this.persist();
    return cloneSnapshot(this.snapshot);
  }

  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await writeFile(this.filePath, `${JSON.stringify(this.snapshot, null, 2)}\n`, "utf8");
    });
    await this.writeQueue;
  }
}

export const statsStore = new StatsStore();
