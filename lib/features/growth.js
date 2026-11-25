// Feature module "growth": the random-tick world behaviour of Alpha 1.1.2 (ported from the decompiled classes:
// my = grass, iz = leaves, dt = sapling, hd = wheat, mi = farmland, jm = reeds, hy = cactus, oa = tree generator).
//
// Like the original World.tick, every chunk near a player gets 80 random block picks per tick; a pick that lands on
// one of the blocks below runs that block's random-tick rule. Only chunks that are already loaded are touched
// (never generates or loads chunks), and at most MAX_CHUNKS chunks are processed per tick (round robin).
//
// Approximations: "light level" = skylight only (column above the block, leaves -1, water -3, minus the day/night
// skylight dimming of the original). Torches / block light are ignored. The 1/10 "big tree" of saplings is not
// ported (always the normal tree). Players do not trample farmland. Mushrooms/flowers/snow/ice are not handled.
// Nothing here needs saving: everything is derived from the world itself (caches live on g / chunk objects and are
// rebuilt on demand).
import { OPAQUE, FULL } from "../blocks.js";
import { isRaining, exposed } from "./weather.js";

const RADIUS = 5;            // chunk radius around each player that gets random ticks
const PICKS = 80;            // random block picks per chunk per tick (same as the original)
const MAX_CHUNKS = 160;      // bounded work per tick (round robin when more chunks are active)

const LEAVES = 18, LOG = 17, GRASS = 2, DIRT = 3, SAPLING = 6, WHEAT = 59, FARM = 60, CACTUS = 81, REEDS = 83;
const TICKABLE = new Uint8Array(256);
for (const id of [LEAVES, GRASS, SAPLING, WHEAT, FARM, CACTUS, REEDS]) TICKABLE[id] = 1;

// blocks skylight passes through freely (same list the chunk light packet uses, plus cactus is treated as solid there)
const CLEAR = new Uint8Array(256);
for (const id of [0, 6, 8, 9, 10, 11, 18, 20, 27, 28, 37, 38, 39, 40, 50, 51, 55, 59, 63, 64, 65, 66, 68, 69, 70, 71, 72, 75, 76, 77, 78, 79, 83, 85, 90]) CLEAR[id] = 1;

const rnd = (n) => Math.floor(Math.random() * n);

// ---------- chunk access that never loads/generates anything ----------
function chunkAt(g, x, z) { return g.chunks.get(`${x >> 4},${z >> 4}`); }
/** block id, or -1 when the chunk is not loaded / y out of range */
function peek(g, x, y, z) {
  if (y < 0 || y > 127) return -1;
  const c = g.chunks.get(`${x >> 4},${z >> 4}`);
  return c ? c.get(x & 15, y, z & 15) : -1;
}
function peekMeta(g, x, y, z) {
  const c = g.chunks.get(`${x >> 4},${z >> 4}`);
  return c && y >= 0 && y <= 127 ? c.getMeta(x & 15, y, z & 15) : 0;
}
/** meta write without broadcast (for state the client never renders) */
function quietMeta(g, x, y, z, id, meta) {
  const c = chunkAt(g, x, z);
  if (c) c.set(x & 15, y, z & 15, id, meta);
}

// ---------- light ----------
/** Skylight dimming of the original (cn.a(float)), 0 at noon .. 11 at midnight. */
function skySub(time) {
  let f = (time % 24000) / 24000 - 0.25;
  if (f < 0) f += 1;
  if (f > 1) f -= 1;
  const f1 = f;
  f = 1 - (Math.cos(f * Math.PI) + 1) / 2;
  f = f1 + (f - f1) / 3;
  let s = 1 - (Math.cos(f * Math.PI * 2) * 2 + 0.5);
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  return Math.floor(s * 11);
}
/** approximate light at (lx,y,lz) of chunk c: skylight coming down the column, 0 if the cell itself is not clear */
function light(c, lx, y, lz, sub) {
  if (y > 127) return Math.max(0, 15 - sub);
  let l = 15;
  for (let yy = y; yy < 128; yy++) {
    const id = c.get(lx, yy, lz);
    if (CLEAR[id]) { if (id === 18) l -= 1; else if (id === 8 || id === 9 || id === 79) l -= 3; }
    else return 0;
  }
  return Math.max(0, l - sub);
}

// ---------- leaves (iz): meta = support value, 0 = not computed yet, 1 = decaying ----------
const solidBelow = (id) => id !== LEAVES && FULL.has(id);
function leafSupport(g, x, y, z, cur) {
  const id = peek(g, x, y, z);
  if (id === LOG) return 16;
  if (id === LEAVES) { const m = peekMeta(g, x, y, z); if (m !== 0 && m > cur) return m; }
  return cur;
}
function leafNeighbour(g, x, y, z, old, st) {
  if (peek(g, x, y, z) !== LEAVES) return;
  const m = peekMeta(g, x, y, z);
  if (m !== 0 && m === old - 1) leafUpdate(g, x, y, z, st);
}
/** iz.h: recompute this leaf's value from its neighbours (not the one above) and tell neighbours when it changed */
function leafUpdate(g, x, y, z, st) {
  if (st.n++ >= 100) return;
  if (peek(g, x, y, z) !== LEAVES) return;
  let v = solidBelow(peek(g, x, y - 1, z)) ? 16 : 0;
  let m = peekMeta(g, x, y, z);
  if (m === 0) { m = 1; quietMeta(g, x, y, z, LEAVES, 1); }
  v = leafSupport(g, x, y - 1, z, v);
  v = leafSupport(g, x, y, z - 1, v);
  v = leafSupport(g, x, y, z + 1, v);
  v = leafSupport(g, x - 1, y, z, v);
  v = leafSupport(g, x + 1, y, z, v);
  let n = v - 1;
  if (n < 10) n = 1;
  if (n !== m) {
    quietMeta(g, x, y, z, LEAVES, n);
    leafNeighbour(g, x, y - 1, z, m, st);
    leafNeighbour(g, x, y + 1, z, m, st);
    leafNeighbour(g, x, y, z - 1, m, st);
    leafNeighbour(g, x, y, z + 1, m, st);
    leafNeighbour(g, x - 1, y, z, m, st);
    leafNeighbour(g, x + 1, y, z, m, st);
  }
}
function leafTick(g, x, y, z) {
  const m = peekMeta(g, x, y, z);
  if (m === 0) leafUpdate(g, x, y, z, { n: 0 });
  else if (m === 1) { g.dropFor(LEAVES, x, y, z); g.setBlock(x, y, z, 0, 0); }   // dropFor: 1/20 sapling, like iz.a(Random)
  else if (rnd(10) === 0) leafUpdate(g, x, y, z, { n: 0 });
}

// ---------- tree (oa) ----------
function growTree(g, x, y, z) {
  const h = rnd(3) + 4;
  if (y < 1 || y + h + 1 > 128) return false;
  // all chunks the tree touches must be loaded
  for (let dx = -2; dx <= 2; dx += 2) for (let dz = -2; dz <= 2; dz += 2) if (!chunkAt(g, x + dx, z + dz)) return false;
  for (let yy = y; yy <= y + 1 + h; yy++) {
    let r = 1;
    if (yy === y) r = 0;
    if (yy >= y + 1 + h - 2) r = 2;
    for (let xx = x - r; xx <= x + r; xx++) for (let zz = z - r; zz <= z + r; zz++) {
      if (yy < 0 || yy >= 128) return false;
      const id = peek(g, xx, yy, zz);
      if (id !== 0 && id !== LEAVES && !(xx === x && zz === z && yy === y)) return false;
    }
  }
  const below = peek(g, x, y - 1, z);
  if ((below !== GRASS && below !== DIRT) || y >= 128 - h - 1) return false;
  g.setBlock(x, y - 1, z, DIRT, 0);
  for (let yy = y - 3 + h; yy <= y + h; yy++) {
    const dy = yy - (y + h), r = 1 - Math.trunc(dy / 2);
    for (let xx = x - r; xx <= x + r; xx++) for (let zz = z - r; zz <= z + r; zz++) {
      const ax = Math.abs(xx - x), az = Math.abs(zz - z);
      if (ax === r && az === r && (rnd(2) === 0 || dy === 0)) continue;
      const id = peek(g, xx, yy, zz);
      if (id === 0 || id === LEAVES) { if (id === 0) g.setBlock(xx, yy, zz, LEAVES, 0); }
    }
  }
  for (let i = 0; i < h; i++) {
    const id = peek(g, x, y + i, z);
    if (id === 0 || id === LEAVES) g.setBlock(x, y + i, z, LOG, 0);
  }
  return true;
}

// ---------- wheat (hd) ----------
function wheatRate(g, x, y, z) {
  let f = 1;
  const id = (a, b, c) => peek(g, a, b, c);
  const sx = id(x - 1, y, z) === WHEAT || id(x + 1, y, z) === WHEAT;
  const sz = id(x, y, z - 1) === WHEAT || id(x, y, z + 1) === WHEAT;
  const diag = id(x - 1, y, z - 1) === WHEAT || id(x + 1, y, z - 1) === WHEAT || id(x + 1, y, z + 1) === WHEAT || id(x - 1, y, z + 1) === WHEAT;
  for (let xx = x - 1; xx <= x + 1; xx++) for (let zz = z - 1; zz <= z + 1; zz++) {
    let q = 0;
    if (peek(g, xx, y - 1, zz) === FARM) { q = 1; if (peekMeta(g, xx, y - 1, zz) > 0) q = 3; }
    if (xx !== x || zz !== z) q /= 4;
    f += q;
  }
  if (diag || (sx && sz)) f /= 2;
  return f;
}
function wheatTick(g, c, x, y, z, sub) {
  const lx = x & 15, lz = z & 15;
  const m = c.getMeta(lx, y, lz);
  (c._wheat ??= new Map()).set((lx << 11) | (lz << 7) | y, m);
  if (y >= 127 || light(c, lx, y + 1, lz, sub) < 9 || m >= 7) return;
  if (peek(g, x, y - 1, z) !== FARM) return;
  const f = wheatRate(g, x, y, z);
  if (rnd(Math.trunc(100 / f)) === 0) g.setBlock(x, y, z, WHEAT, m + 1);
}

// ---------- farmland (mi) ----------
function farmTick(g, x, y, z) {
  if (rnd(5) !== 0) return;
  let wet = isRaining(g) && exposed(g, x, y, z);                   // rain falling on it
  for (let xx = x - 4; xx <= x + 4 && !wet; xx++) for (let yy = y; yy <= y + 1 && !wet; yy++) for (let zz = z - 4; zz <= z + 4; zz++) {
    const id = peek(g, xx, yy, zz);
    if (id === 8 || id === 9) { wet = true; break; }
  }
  const m = peekMeta(g, x, y, z);
  if (wet) { if (m !== 7) g.setBlock(x, y, z, FARM, 7); }
  else if (m > 0) g.setBlock(x, y, z, FARM, m - 1);
  else if (peek(g, x, y + 1, z) !== WHEAT) g.setBlock(x, y, z, DIRT, 0);
}

// ---------- grass (my) ----------
function grassTick(g, c, x, y, z, sub) {
  const lx = x & 15, lz = z & 15;
  if (y >= 127) return;
  const above = c.get(lx, y + 1, lz);
  if (light(c, lx, y + 1, lz, sub) < 4 && OPAQUE.has(above)) {
    if (rnd(4) === 0) g.setBlock(x, y, z, DIRT, 0);
    return;
  }
  if (light(c, lx, y + 1, lz, sub) >= 9) {
    const tx = x + rnd(3) - 1, ty = y + rnd(5) - 3, tz = z + rnd(3) - 1;
    if (peek(g, tx, ty, tz) !== DIRT || ty >= 127) return;
    const tc = chunkAt(g, tx, tz);
    if (!tc) return;
    const a = tc.get(tx & 15, ty + 1, tz & 15);
    if (light(tc, tx & 15, ty + 1, tz & 15, sub) >= 4 && !OPAQUE.has(a)) g.setBlock(tx, ty, tz, GRASS, 0);
  }
}

// ---------- sapling (dt) ----------
function saplingTick(g, c, x, y, z, sub) {
  const lx = x & 15, lz = z & 15;
  if (y >= 127 || light(c, lx, y + 1, lz, sub) < 9 || rnd(5) !== 0) return;
  const m = c.getMeta(lx, y, lz);
  if (m < 15) { quietMeta(g, x, y, z, SAPLING, m + 1); return; }
  g.setBlock(x, y, z, 0, 0);
  if (!growTree(g, x, y, z)) g.setBlock(x, y, z, SAPLING, 0);
}

// ---------- reeds (jm) and cactus (hy): identical rule ----------
function stackTick(g, c, x, y, z, id) {
  if (y >= 127) return;
  const lx = x & 15, lz = z & 15;
  if (c.get(lx, y + 1, lz) !== 0) return;
  let h = 1;
  while (y - h >= 0 && c.get(lx, y - h, lz) === id) h++;
  if (h >= 3) return;
  const m = c.getMeta(lx, y, lz);
  if (m === 15) { g.setBlock(x, y + 1, z, id, 0); quietMeta(g, x, y, z, id, 0); }
  else quietMeta(g, x, y, z, id, m + 1);
}

function tickChunk(g, c, sub) {
  const bx = c.cx << 4, bz = c.cz << 4, blocks = c.blocks;
  for (let i = 0; i < PICKS; i++) {
    const idx = rnd(32768), id = blocks[idx];
    if (!TICKABLE[id]) continue;
    const y = idx & 127, lz = (idx >> 7) & 15, lx = idx >> 11, x = bx + lx, z = bz + lz;
    switch (id) {
      case LEAVES: leafTick(g, x, y, z); break;
      case GRASS: grassTick(g, c, x, y, z, sub); break;
      case SAPLING: saplingTick(g, c, x, y, z, sub); break;
      case WHEAT: wheatTick(g, c, x, y, z, sub); break;
      case FARM: farmTick(g, x, y, z); break;
      case CACTUS: case REEDS: stackTick(g, c, x, y, z, id); break;
    }
  }
}

export default {
  name: "growth",

  tick(g) {
    if (!g.players.size) return;
    const st = (g._growth ??= { cursor: 0 });
    const active = new Set();
    for (const p of g.players.values()) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      const pcx = Math.floor(p.x) >> 4, pcz = Math.floor(p.z) >> 4;
      for (let dx = -RADIUS; dx <= RADIUS; dx++) for (let dz = -RADIUS; dz <= RADIUS; dz++) {
        const c = g.chunks.get(`${pcx + dx},${pcz + dz}`);
        if (c) active.add(c);
      }
    }
    if (!active.size) return;
    const list = [...active], n = list.length, sub = skySub(g.time);
    const count = Math.min(n, MAX_CHUNKS), start = st.cursor % n;
    for (let i = 0; i < count; i++) tickChunk(g, list[(start + i) % n], sub);
    st.cursor = (start + count) % n;
  },

  onSetBlock(g, x, y, z, id, meta, oldId) {
    // leaves reconsider their support when a log / leaf next to them appears or disappears
    if ((oldId === LOG || oldId === LEAVES || id === LOG || id === LEAVES) && !(oldId === LEAVES && id === LEAVES)) {
      const s = { n: 0 };
      for (const [dx, dy, dz] of [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]) {
        if (peek(g, x + dx, y + dy, z + dz) === LEAVES) leafUpdate(g, x + dx, y + dy, z + dz, s);
      }
    }
    // wheat: remember its stage (the removed block's meta is gone by the time we hear about it) and add the original's drops
    if (id === WHEAT) {
      const c = chunkAt(g, x, z);
      if (c) (c._wheat ??= new Map()).set(((x & 15) << 11) | ((z & 15) << 7) | y, meta);
    } else if (oldId === WHEAT) {
      const c = chunkAt(g, x, z), key = ((x & 15) << 11) | ((z & 15) << 7) | y, m = c?._wheat?.get(key);
      c?._wheat?.delete(key);
      if (id === 0 && m !== undefined) {
        for (let i = 0; i < 3; i++) if (rnd(15) <= m) g.spawnItem(295, 1, x + 0.5, y + 0.3, z + 0.5, (Math.random() - 0.5) * 0.2, 0.2, (Math.random() - 0.5) * 0.2, 10);
        if (m === 7) g.spawnItem(296, 1, x + 0.5, y + 0.3, z + 0.5, (Math.random() - 0.5) * 0.2, 0.2, (Math.random() - 0.5) * 0.2, 10);
      }
    }
    // farmland: something solid built on top turns it back into dirt; losing the farmland breaks the crop on it
    if (id !== 0 && id !== WHEAT && FULL.has(id) && peek(g, x, y - 1, z) === FARM) g.setBlock(x, y - 1, z, DIRT, 0);
    if (oldId === FARM && id !== FARM && peek(g, x, y + 1, z) === WHEAT) g.pop(x, y + 1, z, true);
  },
};
