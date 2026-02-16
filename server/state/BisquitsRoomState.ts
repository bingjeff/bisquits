import { MapSchema, Schema, defineTypes } from "@colyseus/schema";

export type RoomPhase = "lobby" | "playing";

export class PlayerState extends Schema {
  clientId = "";
  name = "";
  ready = false;
  joinedAt = Date.now();
  wins = 0;
  gamesPlayed = 0;
  longestWord = "";
}

defineTypes(PlayerState, {
  clientId: "string",
  name: "string",
  ready: "boolean",
  joinedAt: "number",
  wins: "number",
  gamesPlayed: "number",
  longestWord: "string",
});

export class BisquitsRoomState extends Schema {
  players = new MapSchema<PlayerState>();
  phase: RoomPhase = "lobby";
  ownerClientId = "";
  lastWinnerName = "";
  lastLongestWord = "";
  roundsPlayed = 0;
  createdAt = Date.now();
}

defineTypes(BisquitsRoomState, {
  players: { map: PlayerState },
  phase: "string",
  ownerClientId: "string",
  lastWinnerName: "string",
  lastLongestWord: "string",
  roundsPlayed: "number",
  createdAt: "number",
});
