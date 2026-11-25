// Fire (block 51, metadata = age 0-15). A port of the game's own BlockFire (class og in the a1.1.2 bytecode),
// driven by a queue of scheduled ticks (tick rate 10) like lib/liquid.js.
//   - flint and steel (item 259) lights the block next to the clicked face (TNT is left to the tnt feature)
//   - each tick: age+1; no fuel and no solid floor (or age > 3) -> goes out; age 15 on non-flammable ground burns out 1 in 4
//   - even age > 2: burns the 6 neighbours (chances 300/300/200/250/300/300 against their flammability) and
//     lights air blocks around/above it (encouragement of the neighbours)
//   - lava randomly lights air above it that touches something flammable (BlockFluid random tick)
//   - water flowing onto fire simply replaces it (liquid.js); fire without support is removed when a neighbour changes
// Not ported: rain, and the age is kept in the chunk metadata WITHOUT broadcasting (the client never needs it).
import { OPAQUE } from "../blocks.js";
import { SOLID_NOT } from "../world.js";

const FIRE = 51, TNT = 46, RATE = 10;
const MAX_QUEUE = 3000, PER_TICK = 120, LAVA_SAMPLES = 24;
// id -> [encouragement (chance for fire to appear next to it), flammability (chance it burns away)]
const FLAM = { 5: [5, 20], 17: [5, 5], 18: [30, 60], 35: [30, 60], 46: [15, 100], 47: [30, 20] };
// materials the game calls flammable (lava ignition): wood, cloth, leaves, tnt
const LAVA_FUEL = new Set([5, 17, 18, 35, 46, 47, 53, 54, 58, 63, 64, 68, 84]);
const N6 = [[1, 0, 0], [-1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
const rnd = (n) => Math.floor(Math.random() * n);

const loaded = (g, x, z) => g.chunks.has(`${x >> 4},${z >> 4}`);
/** Block lookup that never generates chunks: the unloaded world and anything off the map is "nothing". */
function blk(g, x, y, z) {
  if (y < 0 || y > 127 || !loaded(g, x, z)) return 0;
  return g.block(x, y, z);
}
const flammable = (id) => id in FLAM && FLAM[id][0] > 0;

function schedule(g, x, y, z, delay = RATE) {
  const q = g.fire.q, k = `${x},${y},${z}`;
  if (q.has(k) || q.size >= MAX_QUEUE) return;
  q.set(k, g.time + delay);
}

const hasFuelAround = (g, x, y, z) => N6.some(([a, b, c]) => flammable(blk(g, x + a, y + b, z + c)));
function canStay(g, x, y, z) {
  if (y > 0 && (!loaded(g, x, z) || OPAQUE.has(blk(g, x, y - 1, z)))) return true;
  return hasFuelAround(g, x, y, z);
}

/** Fire takes the place of whatever burned (dependants of the old block pop without drops). */
function ignite(g, x, y, z) {
  if (y < 1 || y > 127 || !loaded(g, x, z)) return;
  if (g.block(x, y, z) !== 0) g.pop(x, y, z, false);
  g.setBlock(x, y, z, FIRE, 0);
}

/** BlockFire.a(world,x,y,z,chance): the neighbour may burn away (or be replaced by fire). TNT is left for the tnt feature. */
function tryBurn(g, x, y, z, chance) {
  const id = blk(g, x, y, z), f = FLAM[id];
  if (!f || id === TNT) return;
  if (rnd(chance) >= f[1]) return;
  if (rnd(2) === 0) ignite(g, x, y, z);
  else g.pop(x, y, z, false);
}

/** BlockFire.i: how strongly the neighbours of an AIR block encourage fire (0 when the block is not air). */
function encourage(g, x, y, z) {
  if (blk(g, x, y, z) !== 0) return 0;
  let e = 0;
  for (const [a, b, c] of N6) { const f = FLAM[blk(g, x + a, y + b, z + c)]; if (f && f[0] > e) e = f[0]; }
  return e;
}

function fireTick(g, x, y, z) {
  if (!loaded(g, x, z)) return schedule(g, x, y, z);
  if (g.block(x, y, z) !== FIRE) return;
  const ch = g.chunk(x >> 4, z >> 4), m = g.meta(x, y, z);
  if (m < 15) { ch.set(x & 15, y, z & 15, FIRE, m + 1); }
  schedule(g, x, y, z);                                           // (the original stops at age 15; we keep rolling the burn-out)
  if (!hasFuelAround(g, x, y, z)) {
    if (y < 1 || !OPAQUE.has(blk(g, x, y - 1, z)) || m > 3) g.setBlock(x, y, z, 0, 0);
    return;
  }
  if (!flammable(blk(g, x, y - 1, z)) && m === 15 && rnd(4) === 0) { g.setBlock(x, y, z, 0, 0); return; }
  if (m % 2 === 0 && m > 2) {
    tryBurn(g, x + 1, y, z, 300); tryBurn(g, x - 1, y, z, 300);
    tryBurn(g, x, y - 1, z, 200); tryBurn(g, x, y + 1, z, 250);
    tryBurn(g, x, y, z - 1, 300); tryBurn(g, x, y, z + 1, 300);
    for (let a = x - 1; a <= x + 1; a++) for (let c = z - 1; c <= z + 1; c++) for (let b = y - 1; b <= y + 4; b++) {
      if (a === x && b === y && c === z) continue;
      let base = 100;
      if (b > y + 1) base += (b - (y + 1)) * 100;
      const e = encourage(g, a, b, c);
      if (e > 0 && rnd(base) <= e) ignite(g, a, b, c);
    }
  }
}

/** BlockFluid random tick of lava: up to 2 hops upwards, lights air that touches fuel. */
function lavaTick(g, x, y, z) {
  const n = rnd(3);
  for (let i = 0; i < n; i++) {
    x += rnd(3) - 1; y++; z += rnd(3) - 1;
    if (y > 127 || !loaded(g, x, z)) return;
    const id = g.block(x, y, z);
    if (id === 0) {
      if (N6.some(([a, b, c]) => LAVA_FUEL.has(blk(g, x + a, y + b, z + c)))) ignite(g, x, y, z);
      return;
    }
    if (!SOLID_NOT.has(id)) return;                                // something solid: the heat stops there
  }
}

export default {
  name: "fire",

  onSetBlock(g, x, y, z, id, meta, oldId) {
    if (!g.fire) return;
    if (id === FIRE) {
      if (oldId !== FIRE) {
        if (!canStay(g, x, y, z)) { g.setBlock(x, y, z, 0, 0); return; }
        schedule(g, x, y, z);
      }
      return;
    }
    if (oldId === FIRE) g.fire.q.delete(`${x},${y},${z}`);
    if (id === oldId) return;
    for (const [a, b, c] of N6) {                                   // a neighbour changed: fire may have lost its support
      const nx = x + a, ny = y + b, nz = z + c;
      if (ny < 0 || ny > 127 || !loaded(g, nx, nz) || g.block(nx, ny, nz) !== FIRE) continue;
      if (!canStay(g, nx, ny, nz)) g.setBlock(nx, ny, nz, 0, 0);
    }
  },

  tick(g) {
    if (!g.fire) return;
    const q = g.fire.q;
    let n = 0;
    if (q.size) for (const [k, due] of q) {
      if (due > g.time) continue;
      q.delete(k);
      const [x, y, z] = k.split(",").map(Number);
      fireTick(g, x, y, z);
      if (++n >= PER_TICK) break;
    }
    for (const p of g.players.values()) {                           // random ticks of lava around the players
      const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);
      for (let i = 0; i < LAVA_SAMPLES; i++) {
        const x = px + rnd(33) - 16, z = pz + rnd(33) - 16, y = py + rnd(33) - 16;
        if (y < 1 || y > 126 || !loaded(g, x, z)) continue;
        const id = g.block(x, y, z);
        if (id === 10 || id === 11) lavaTick(g, x, y, z);
      }
    }
  },

  onUse(g, p, { x, y, z, face, item }, touched) {
    if (item !== 259) return false;
    if (g.block(x, y, z) === TNT) return false;                     // the tnt feature lights it
    if (face > 5) return false;
    const [dx, dy, dz] = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][face];
    const tx = x + dx, ty = y + dy, tz = z + dz;
    if (ty < 1 || ty > 127) return true;
    if (g.block(tx, ty, tz) === 0 && canStay(g, tx, ty, tz)) g.setBlock(tx, ty, tz, FIRE, 0);
    touched.push([tx, ty, tz]);
    return true;
  },

  save(g) { return g.fire ? { q: [...g.fire.q] } : { q: [] }; },
  load(g, state) {
    g.fire = { q: new Map(state?.q || []) };
  },
};
