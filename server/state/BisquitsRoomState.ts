import { ArraySchema, MapSchema, Schema, defineTypes } from "@colyseus/schema";

export type RoomPhase = "lobby" | "playing";

export class PlayerState extends Schema {
  declare playerId: string;
  declare clientId: string;
  declare name: string;
  declare connected: boolean;
  declare ready: boolean;
  declare joinedAt: number;
  declare wins: number;
  declare gamesPlayed: number;
  declare longestWord: string;

  constructor() {
    super();
    this.playerId = "";
    this.clientId = "";
    this.name = "";
    this.connected = true;
    this.ready = false;
    this.joinedAt = Date.now();
    this.wins = 0;
    this.gamesPlayed = 0;
    this.longestWord = "";
  }
}

defineTypes(PlayerState, {
  playerId: "string",
  clientId: "string",
  name: "string",
  connected: "boolean",
  ready: "boolean",
  joinedAt: "number",
  wins: "number",
  gamesPlayed: "number",
  longestWord: "string",
});

export class BoardTileState extends Schema {
  declare id: string;
  declare letter: string;
  declare zone: string;
  declare row: number;
  declare col: number;

  constructor() {
    super();
    this.id = "";
    this.letter = "";
    this.zone = "staging";
    this.row = -1;
    this.col = -1;
  }
}

defineTypes(BoardTileState, {
  id: "string",
  letter: "string",
  zone: "string",
  row: "number",
  col: "number",
});

export class PlayerBoardState extends Schema {
  declare playerId: string;
  declare status: string;
  declare turn: number;
  declare drawPileCount: number;
  declare rows: number;
  declare cols: number;
  declare players: number;
  declare lastAction: string;
  declare tiles: ArraySchema<BoardTileState>;

  constructor() {
    super();
    this.playerId = "";
    this.status = "running";
    this.turn = 0;
    this.drawPileCount = 0;
    this.rows = 0;
    this.cols = 0;
    this.players = 0;
    this.lastAction = "";
    this.tiles = new ArraySchema<BoardTileState>();
  }
}

defineTypes(PlayerBoardState, {
  playerId: "string",
  status: "string",
  turn: "number",
  drawPileCount: "number",
  rows: "number",
  cols: "number",
  players: "number",
  lastAction: "string",
  tiles: [BoardTileState],
});

export class BisquitsRoomState extends Schema {
  declare players: MapSchema<PlayerState>;
  declare boards: MapSchema<PlayerBoardState>;
  declare phase: RoomPhase;
  declare ownerClientId: string;
  declare lastWinnerName: string;
  declare lastLongestWord: string;
  declare roundsPlayed: number;
  declare createdAt: number;

  constructor() {
    super();
    this.players = new MapSchema<PlayerState>();
    this.boards = new MapSchema<PlayerBoardState>();
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
  boards: { map: PlayerBoardState },
  phase: "string",
  ownerClientId: "string",
  lastWinnerName: "string",
  lastLongestWord: "string",
  roundsPlayed: "number",
  createdAt: "number",
});
