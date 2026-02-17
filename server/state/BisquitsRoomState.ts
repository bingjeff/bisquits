import { MapSchema, Schema, defineTypes } from "@colyseus/schema";

export type RoomPhase = "lobby" | "playing";

export class PlayerState extends Schema {
  declare clientId: string;
  declare name: string;
  declare ready: boolean;
  declare joinedAt: number;
  declare wins: number;
  declare gamesPlayed: number;
  declare longestWord: string;

  constructor() {
    super();
    this.clientId = "";
    this.name = "";
    this.ready = false;
    this.joinedAt = Date.now();
    this.wins = 0;
    this.gamesPlayed = 0;
    this.longestWord = "";
  }
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
  declare players: MapSchema<PlayerState>;
  declare phase: RoomPhase;
  declare ownerClientId: string;
  declare lastWinnerName: string;
  declare lastLongestWord: string;
  declare roundsPlayed: number;
  declare createdAt: number;

  constructor() {
    super();
    this.players = new MapSchema<PlayerState>();
    this.phase = "lobby";
    this.ownerClientId = "";
    this.lastWinnerName = "";
    this.lastLongestWord = "";
    this.roundsPlayed = 0;
    this.createdAt = Date.now();
  }
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
