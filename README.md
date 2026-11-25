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

Caveats:
- The whole game lives in the memory of one server process. If the host starts several copies of the app,
  players on different copies won't see each other. If it puts the app to sleep, the world in memory is gone.
  Wasmer's Node.js runtime is still in beta and calls itself "serverless", so expect this to happen there.
  A host that keeps one `npm start` running (a VPS, Railway, Render, Fly...) doesn't have these problems.
- The world, players and skins are saved to `world-data/` (or `WORLD_DIR`) every 30 seconds **if the disk is
  writable**. Without a writable disk the world resets when the app restarts. The status page shows which one you got.

Settings (environment variables): `SEED` (world seed), `MAX_PLAYERS` (default 20), `WORLD_DIR`.

## What works

- Logging in (no minecraft.net account check), terrain streaming (generated hills, beaches, ores, trees)
- Seeing other players move, swing and hold items
- Breaking and placing blocks (torches, doors, stairs, furnaces, ladders, signs, redstone...), drops and pickups
- Inventory saved per player, chat, `/list /spawn /tp <player> /time day|night /me`
- Skins: the game uploads `.minecraft/skin.png` when it connects, other players download it from `/api/skin`

Not included: mobs, chests/furnaces that keep items, water/lava flow, redstone logic, sign text.

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
- `lib/game.js`: sessions, players, blocks, items, saving. Ticks run during polls, so no background timer is needed
- `app/api/mc/route.js`: the game's HTTP tunnel, `app/api/skin/route.js`: skins, `app/api/status/route.js`: status JSON

Companion client: the "Alpha-Modded" repo (the patched client is required to connect).
