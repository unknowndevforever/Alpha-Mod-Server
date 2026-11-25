# Feature modules

Each file default-exports `{ name, ...hooks }`; all hooks are optional. `g` is the Game (lib/game.js).
The server may run as several instances sharing one database, so ALL state must live in `g` and survive
`save`/`load` below (plain JSON only). Never keep state in module-level variables. Never call Math.random-based
logic at import time. Game logic runs inside one locked batch at a time, so there are no races.

- `onSetBlock(g, x, y, z, id, meta, oldId)`  after ANY block change (players, flow, other features). Cheap!
  Schedule work instead of doing it inline when a change can cascade. Avoid infinite recursion.
- `tick(g)`            once per game tick (20/s); `g.time` is the tick counter. Budget your work (cap per tick).
- `onUse(g, p, {x, y, z, face, item}, touched)`  a player right-clicked block (x,y,z) holding `item`. Return true if
  you handled it (then nothing else happens). Push every position you changed into `touched` (it is re-sent to the
  player so their predicted screen gets corrected).
- `onLogin(g, p)`      a player finished logging in (all login packets queued, player is in g.players). Send them your state here.
- `save(g)` -> JSON-able state, `load(g, state)` (state is undefined for a clean start; reset your state then).

Useful Game API: g.block(x,y,z), g.meta(x,y,z), g.setBlock(x,y,z,id,meta) (broadcasts + notifies features),
g.pop(x,y,z,drop) (remove block like a player did, with drops/dependents), g.dropFor(id,x,y,z), g.spawnItem(...),
g.players (Map name->Player with x,y,z), g.mobs (Map, see lib/mobs.js), g.broadcast(packet), g.chunks (Map of loaded
chunks; use g.chunks.has(`${x>>4},${z>>4}`) to avoid generating chunks), g.surface(x,z), g.time, g.kick.
Packets: lib/protocol.js (S.*). Only packets the game client registers work: see the server README / mobs.js header.

Sounds: `g.sound(name, x, y, z, vol=1, pitch=1)` sends packet 0x3e to players within 16*vol blocks (vol 4 = 64). All sound names live in
`lib/sounds.js` (table `SND`, per-mob `MOB_SND`, helper `mobSound(g, mob, 'idle'|'hurt'|'death')`). Player damage: `p.send(S.hurt(n))`
(the client owns the health). Weather helpers (features/weather.js): `isRaining(g)`, `exposed(g,x,y,z)` (open sky above), `setWeather(g, raining)`.
