# Multiplayer Roadmap

## Current Slice (implemented)

- Colyseus server with:
  - `lobby` room registration
  - `bisquits` room (max 4 players)
  - name updates, ready state, start signal
  - finish signal and persisted stats snapshot
- Client multiplayer panel with:
  - create/join room
  - player name input
  - ready/start controls
  - room roster rendering
  - global "last game" stats summary

## Game Logic Migration (next slices)

### 1. Move game simulation to server authority

- Host game state on `BisquitsRoom` instead of browser-only.
- Receive actions from clients:
  - `move_tile`
  - `trade_tile`
  - `serve_plate`
- Validate actions server-side and reject invalid updates.
- Broadcast only authoritative state patches to clients.

### 2. Support per-player private boards

- Keep one room-level match state and one board state per player.
- Preserve hidden information by sending each client only their own private board + shared match metadata.
- Keep room-level events public:
  - player joined
  - player served
  - winner + longest word

### 3. Add deterministic turn/timer model

- Replace browser-local pressure timer with room-controlled timers.
- Include turn ownership and timeout behavior in server state.
- Persist turn and timer events for reconnect safety.

### 4. Expand stats model

- Persist:
  - winner
  - longest word
  - rounds played
  - per-player totals (wins, games, longest word)
- Add lightweight room history endpoint/message for match recap.
