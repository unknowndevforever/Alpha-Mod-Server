---
title: recreatecraft server
emoji: ⛏️
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# recreatecraft server

A Minecraft **Alpha 1.1.2** multiplayer server written as a Next.js app, so it can be hosted on
[Wasmer Edge](https://wasmer.io) (`yourname.wasmer.app`) or anywhere else that runs Next.js.

Wasmer apps only get HTTP, not the raw TCP the game normally uses. The patched recreatecraft client
(`dist/recreatecraft_patched.jar`) sends the normal game protocol through HTTP requests (`HttpSocket.java`),
so **only the patched jar can connect**, not vanilla clients.

## Connecting

Multiplayer, then type the address:

| Server                    | Type in the game         |
|---------------------------|--------------------------|
| Wasmer                    | `yourapp.wasmer.app`     |
| Running on your own PC    | `localhost:3000`         |
| Any other HTTPS host      | `example.com:443`        |

How the client picks: `*.wasmer.app` or port 443 means HTTPS, ports 80/3000/8080 mean HTTP, anything else
is a normal TCP Minecraft server.

## Run it locally

```
npm install
npm run build
npm start          # http://localhost:3000 shows who's online
```

`npm run dev` works too.

## Deploy to Wasmer

1. Put this `server` folder in a GitHub repo (as the repo root, or pick it as the root directory when importing).
2. Go to https://wasmer.io/new, connect the repo and pick the Next.js preset. Wasmer builds and deploys it.
3. Open `https://yourapp.wasmer.app` to check it's up, then connect from the game with `yourapp.wasmer.app`.

Multiple copies / sleeping (Wasmer):
- Wasmer may run several copies of the app and send each request to any of them. With a **database** (see
  `app.yaml.example`; `DB_HOST` etc. are injected automatically) the server keeps *all* state in Postgres: world,
  players, sessions, items and time. Every request runs in a short batch under a database lock, so all copies act as
  one server, and an instance that wakes up or restarts just continues where the others left off.
  **Use the database on Wasmer, otherwise each copy is its own separate world.**
- Without a database the whole game lives in one process's memory (fine for `npm start` on a PC/VPS, Railway,
  Render, Fly...). The world is then saved to `world-data/` (or `WORLD_DIR`) every 15 seconds if the disk is writable.
  The status page shows which storage you got.

Settings (environment variables): `SEED` (world seed), `MAX_PLAYERS` (default 20), `WORLD_DIR`.

## What works

- Logging in (no minecraft.net account check), terrain streaming (generated hills, beaches, ores, trees)
- Seeing other players move, swing and hold items
- Breaking and placing blocks (torches, doors, stairs, furnaces, ladders, signs, redstone...), drops and pickups
- Inventory saved per player, chat, `/list /spawn /tp <player> /time day|night /me`
- Skins: the game uploads `.minecraft/skin.png` when it connects, other players download it from `/api/skin`

- Chests, furnaces and signs keep their contents/text. The game's own screens run on the client and send the block's
  data (packet 0x3B) whenever it changes; the server stores it with the chunk (shared through the database), sends it to
  everyone who loads or is near that chunk, and spills a broken chest/furnace's items. A furnace only smelts while a
  player has it loaded (the game ticks it client-side).

Not included: mobs, water/lava flow, redstone logic.

## Block sync (how placed blocks stay placed)

The client predicts block changes, so the server now treats itself as the authority: after every place or break it
sends the acting player the real state of every block the action touched. A placement the server refuses (too far,
occupied, no floor) is undone on your screen immediately instead of vanishing later when the chunk reloads.
Placement rules follow the client's own: slab on slab makes a double slab, stairs/furnaces turn by their neighbours,
iron doors don't open by hand, torches/ladders/signs pop when their block is broken, sand and gravel fall.
Players saved inside blocks are lifted out on login and `/tp`.

## Files

- `lib/protocol.js`: packet reading/writing (protocol 2)
- `lib/blocks.js`: block rules (drops, orientation, doors, stairs) copied from the client's behaviour
- `lib/world.js`: terrain generator and chunk encoding
- `lib/game.js`: sessions, players, blocks, items, saving, plus the shared-database batching (`run`, `cycle`). Ticks run during polls, so no background timer is needed
- `app/api/mc/route.js`: the game's HTTP tunnel, `app/api/skin/route.js`: skins, `app/api/status/route.js`: status JSON
