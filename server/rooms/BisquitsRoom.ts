import { Client, Room } from "colyseus";
import { BisquitsRoomState, PlayerState } from "../state/BisquitsRoomState";
import { statsStore } from "../stats/StatsStore";

interface PlayerNameMessage {
  name?: string;
}

interface ReadyMessage {
  ready?: boolean;
}

interface FinishGameMessage {
  winnerClientId?: string;
  longestWord?: string;
}

type RoomNoticeLevel = "info" | "error";

function sanitizeName(input: unknown, fallback: string): string {
  const base = typeof input === "string" ? input.trim() : "";
  const collapsed = base.replace(/\s+/g, " ");
  const cleaned = collapsed.replace(/[^\w -]/g, "");
  return (cleaned.slice(0, 20) || fallback).trim();
}

function sanitizeWord(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }
  return input.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 24);
}

export class BisquitsRoom extends Room<{ state: BisquitsRoomState }> {
  maxClients = 4;

  onCreate(): void {
    this.setState(new BisquitsRoomState());
    this.setPrivate(false);
    this.autoDispose = true;
    this.patchRate = 50;

    this.onMessage("set_name", (client, message: PlayerNameMessage) => {
      this.renamePlayer(client, message.name);
    });

    this.onMessage("set_ready", (client, message: ReadyMessage) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || this.state.phase !== "lobby") {
        return;
      }
      player.ready = Boolean(message?.ready);
      this.updateRoomMetadata();
    });

    this.onMessage("start_game", (client) => {
      if (client.sessionId !== this.state.ownerClientId) {
        this.sendNotice(client, "error", "Only the host can start the game.");
        return;
      }
      if (this.clients.length < 2) {
        this.sendNotice(client, "error", "At least 2 players are required.");
        return;
      }
      this.state.phase = "playing";
      this.state.players.forEach((player: PlayerState) => {
        player.ready = false;
      });
      this.broadcast("game_started", { startedAt: Date.now() });
      this.updateRoomMetadata();
    });

    this.onMessage("finish_game", async (client, payload: FinishGameMessage) => {
      if (this.state.phase !== "playing") {
        this.sendNotice(client, "error", "No active game to finish.");
        return;
      }

      const winnerClientId = payload?.winnerClientId ?? client.sessionId;
      const winner = this.state.players.get(winnerClientId);
      if (!winner) {
        this.sendNotice(client, "error", "Winner must be in the room.");
        return;
      }

      const longestWord = sanitizeWord(payload?.longestWord);
      if (longestWord.length > winner.longestWord.length) {
        winner.longestWord = longestWord;
      }

      const playerNames: string[] = [];
      this.state.players.forEach((player: PlayerState) => {
        player.gamesPlayed += 1;
        playerNames.push(player.name);
      });

      winner.wins += 1;
      this.state.lastWinnerName = winner.name;
      this.state.lastLongestWord = longestWord;
      this.state.roundsPlayed += 1;
      this.state.phase = "lobby";

      const snapshot = await statsStore.recordMatch({
        roomId: this.roomId,
        winnerName: winner.name,
        longestWord,
        players: playerNames,
      });

      this.broadcast("stats_snapshot", snapshot);
      this.broadcast("game_finished", {
        winnerName: winner.name,
        longestWord,
      });
      this.updateRoomMetadata();
    });

    this.updateRoomMetadata();
  }

  async onJoin(client: Client, options: PlayerNameMessage): Promise<void> {
    const player = new PlayerState();
    player.clientId = client.sessionId;
    player.name = sanitizeName(options?.name, `Player ${this.clients.length}`);

    this.state.players.set(client.sessionId, player);
    if (!this.state.ownerClientId) {
      this.state.ownerClientId = client.sessionId;
    }

    this.sendNotice(client, "info", `Joined room ${this.roomId}.`);
    this.broadcast("room_notice", {
      level: "info",
      message: `${player.name} joined the room.`,
    });

    const stats = await statsStore.getSnapshot();
    client.send("stats_snapshot", stats);

    this.updateRoomMetadata();
  }

  onLeave(client: Client): void {
    const leavingPlayer = this.state.players.get(client.sessionId);
    const leavingName = leavingPlayer?.name ?? "Player";
    this.state.players.delete(client.sessionId);

    if (this.state.ownerClientId === client.sessionId) {
      this.state.ownerClientId = this.getFirstPlayerId();
    }

    if (this.state.players.size < 2 && this.state.phase === "playing") {
      this.state.phase = "lobby";
      this.broadcast("room_notice", {
        level: "info",
        message: "Game reset to lobby because player count dropped below 2.",
      });
    }

    this.broadcast("room_notice", {
      level: "info",
      message: `${leavingName} left the room.`,
    });
    this.updateRoomMetadata();
  }

  private renamePlayer(client: Client, proposedName: unknown): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) {
      return;
    }
    const previousName = player.name;
    player.name = sanitizeName(proposedName, previousName);
    this.broadcast("room_notice", {
      level: "info",
      message: `${previousName} is now ${player.name}.`,
    });
    this.updateRoomMetadata();
  }

  private sendNotice(client: Client, level: RoomNoticeLevel, message: string): void {
    client.send("room_notice", { level, message });
  }

  private getFirstPlayerId(): string {
    let firstPlayerId = "";
    this.state.players.forEach((_player: PlayerState, clientId: string) => {
      if (!firstPlayerId) {
        firstPlayerId = clientId;
      }
    });
    return firstPlayerId;
  }

  private updateRoomMetadata(): void {
    const ownerName = this.state.players.get(this.state.ownerClientId)?.name ?? "";
    this.setMetadata({
      phase: this.state.phase,
      ownerName,
      playerCount: this.clients.length,
      maxPlayers: this.maxClients,
      lastWinnerName: this.state.lastWinnerName,
      lastLongestWord: this.state.lastLongestWord,
      roundsPlayed: this.state.roundsPlayed,
      createdAt: this.state.createdAt,
    });
  }

}
