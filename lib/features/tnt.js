// Feature module "tnt": TNT block (46), primed TNT countdown, and the Explosion algorithm.
// Ported from the original a1.1.2 classes: q (BlockTNT), jd (EntityTNTPrimed) and je (Explosion).
//  - flint and steel / adjacent fire / another explosion / ignite() turn a TNT block into a primed TNT
//  - primed fuse: 80 ticks (a chain-reacted TNT: 10..29 ticks), then explosion of power 4
//  - explosion: 16x16x16 shell of rays, step 0.3, strength power*(0.7..1.3), each block costs (resistance+0.3)*0.3
//    and every step 0.225; blocks reached with strength left are destroyed (30% drop chance each)
// The client cannot spawn a primed TNT entity: its 0x17 handler (gy.a(kj)) only builds boats (type 1) and minecarts
// (10..12). So the primed TNT is shown with the block packet instead: the server removes the TNT block and keeps
// sending the client a flashing TNT / white wool block at the entity position (as the original entity flashes).
import { S } from "../protocol.js";
import { MOBS } from "../mobs.js";
import { SND, mobSound } from "../sounds.js";

const FLINT = 259, TNT = 46, FIRE = 51, WOOL = 35;
const FUSE = 80;                 // ticks (jd.a)
const POWER = 4;
const MAX_EXPLOSIONS = 3;        // explosions executed per tick; the rest wait in the queue
const MAX_PRIMED = 4000;         // beyond this a fuse is skipped and the TNT explodes at once (queued)
const MAX_QUEUE = 20000;
const CONTAINERS = new Set([54, 61, 62]);

// explosion resistance per block id (original: max(hardness * 5, b * 3) / 5), missing = 0
const RESIST = {
  1: 6, 2: 0.6, 3: 0.5, 4: 6, 5: 3, 7: 3600000, 8: 100, 9: 100, 11: 100, 12: 0.5, 13: 0.6, 14: 3, 15: 3, 16: 3, 17: 2,
  18: 0.2, 19: 0.6, 20: 0.3, 35: 0.8, 41: 6, 42: 6, 43: 6, 44: 6, 45: 6, 47: 1.5, 48: 6, 49: 1200, 52: 5, 53: 3, 54: 2.5,
  56: 3, 57: 6, 58: 2.5, 60: 0.6, 61: 3.5, 62: 3.5, 63: 1, 64: 3, 65: 0.4, 66: 0.7, 67: 6, 68: 1, 69: 0.5, 70: 0.5, 71: 5,
  72: 0.5, 73: 3, 74: 3, 77: 0.5, 78: 0.1, 79: 0.5, 80: 0.2, 81: 0.4, 82: 0.6, 84: 6, 85: 3,
};
const NOT_SOLID = new Set([0, 6, 8, 9, 10, 11, 37, 38, 39, 40, 50, 51, 55, 59, 63, 65, 66, 68, 69, 70, 72, 75, 76, 77, 78, 83]);

const st = (g) => (g.tnt ??= { primed: [], queue: [] });
const ckey = (x, z) => `${x >> 4},${z >> 4}`;
const rnd = () => Math.random();

/** Tell every player who has the chunk loaded that block (x,y,z) looks like id/meta (the world itself is untouched). */
function show(g, x, y, z, id, meta) {
  if (y < 0 || y > 127) return;
  const k = ckey(x, z);
  let pk = null;
  for (const p of g.players.values()) if (p.loaded.has(k)) p.send(pk ??= S.blockChange(x, y, z, id, meta));
}
const restore = (g, x, y, z) => { if (g.chunks.has(ckey(x, z))) show(g, x, y, z, g.block(x, y, z), g.meta(x, y, z)); };

function addPrimed(g, x, y, z, fuse) {
  const s = st(g);
  if (s.primed.length >= MAX_PRIMED) { if (s.queue.length < MAX_QUEUE) s.queue.push([x + 0.5, y + 0.5, z + 0.5, POWER]); return; }
  // [x, y(feet), z, vy, fuse, shown cell x, y, z, shown state]
  s.primed.push([x + 0.5, y, z + 0.5, 0, fuse, x, y, z, -1]);
}

/** Light the TNT block at x,y,z: it becomes a primed TNT with the full fuse. Returns true when it was a TNT block. */
export function ignite(g, x, y, z, fuse = FUSE) {
  if (g.block(x, y, z) !== TNT) return false;
  g.setBlock(x, y, z, 0, 0);
  addPrimed(g, x, y, z, fuse);
  if (fuse === FUSE) g.sound(SND.fuse, x + 0.5, y + 0.5, z + 0.5, 1, 1);
  return true;
}

const chainFuse = () => ((rnd() * (FUSE / 4)) | 0) + FUSE / 8;     // jd: random.nextInt(80/4) + 80/8

const NEIGH = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

function blocked(g, x1, y1, z1, x2, y2, z2) {       // is there a solid block between the two points?
  const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1, n = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) * 2));
  for (let i = 1; i < n; i++) {
    const bx = Math.floor(x1 + dx * i / n), by = Math.floor(y1 + dy * i / n), bz = Math.floor(z1 + dz * i / n);
    if (!g.chunks.has(ckey(bx, bz))) return true;
    if (!NOT_SOLID.has(g.block(bx, by, bz))) return true;
  }
  return false;
}

function removeMob(g, m) {
  g.mobs.delete(m.eid);
  const pk = S.destroyEntity(m.eid);
  for (const p of g.players.values()) if (p.mobs.delete(m.eid)) p.send(pk);
  const def = MOBS[m.type];
  if (def?.loot) {
    const [item, max, min = 0] = def.loot, n = min + ((rnd() * (max - min + 1)) | 0);
    if (n > 0) g.spawnItem(item, n, m.x, m.y + 0.4, m.z, (rnd() - 0.5) * 0.2, 0.2, (rnd() - 0.5) * 0.2, 10);
  }
}

/** The original explosion (je.a). Runs at once; blocks, items and mobs near (cx,cy,cz) are affected. */
export function explode(g, cx, cy, cz, power = POWER) {
  const hit = new Map();                                  // "x,y,z" -> [x,y,z]
  const N = 16;
  let lastKey = null, loaded = false;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
    if (!(i === 0 || i === N - 1 || j === 0 || j === N - 1 || k === 0 || k === N - 1)) continue;
    let dx = (i / (N - 1)) * 2 - 1, dy = (j / (N - 1)) * 2 - 1, dz = (k / (N - 1)) * 2 - 1;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    dx /= len; dy /= len; dz /= len;
    let strength = power * (0.7 + rnd() * 0.6);
    let x = cx, y = cy, z = cz;
    for (; strength > 0; strength -= 0.225) {
      const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
      if (by < 0 || by > 127) { if (by < 0 || by > 140) break; }
      else {
        const ck = ckey(bx, bz);
        if (ck !== lastKey) { lastKey = ck; loaded = g.chunks.has(ck); }
        if (!loaded) break;                                // never generate chunks for an explosion
        const id = g.block(bx, by, bz);
        if (id > 0) strength -= ((RESIST[id] ?? 0) + 0.3) * 0.3;
        if (strength > 0) { const hk = `${bx},${by},${bz}`; if (!hit.has(hk)) hit.set(hk, [bx, by, bz, id]); }
      }
      x += dx * 0.3; y += dy * 0.3; z += dz * 0.3;
    }
  }

  // ---- entities (dropped items and mobs) ----
  const R = power * 2;
  const impactOf = (ex, ey, ez, hy) => {
    const d = Math.hypot(ex - cx, ey - cy, ez - cz) / R;
    if (d > 1) return null;
    let seen = 0;
    for (const oy of [0.1, hy / 2, hy - 0.1]) if (!blocked(g, cx, cy, cz, ex, ey - (hy / 2) + oy, ez)) seen++;
    const impact = (1 - d) * (seen / 3);
    if (impact <= 0) return null;
    const dl = Math.hypot(ex - cx, ey - cy, ez - cz) || 1;
    return { impact, dmg: Math.floor(((impact * impact + impact) / 2) * 8 * R + 1), dx: (ex - cx) / dl, dy: (ey - cy) / dl, dz: (ez - cz) / dl };
  };
  for (const it of [...g.items.values()]) {
    if (Math.abs(it.x - cx) > R + 1 || Math.abs(it.y - cy) > R + 1 || Math.abs(it.z - cz) > R + 1) continue;
    const r = impactOf(it.x, it.y + 0.125, it.z, 0.25);
    if (!r) continue;
    if (r.dmg >= 5) { g.items.delete(it.eid); g.broadcast(S.destroyEntity(it.eid)); continue; }   // dropped items have 5 health
    it.vx += r.dx * r.impact; it.vy += r.dy * r.impact; it.vz += r.dz * r.impact;
  }
  for (const m of [...g.mobs.values()]) {
    if (Math.abs(m.x - cx) > R + 1 || Math.abs(m.y - cy) > R + 1 || Math.abs(m.z - cz) > R + 1) continue;
    const h = MOBS[m.type]?.h ?? 1;
    const r = impactOf(m.x, m.y + h / 2, m.z, h);
    if (!r) continue;
    m.hp -= r.dmg;
    if (m.hp <= 0) { mobSound(g, m, "death"); removeMob(g, m); continue; }
    mobSound(g, m, "hurt");
    m.kx = (m.kx || 0) + r.dx * r.impact * 0.6; m.kz = (m.kz || 0) + r.dz * r.impact * 0.6;
    m.vy = Math.max(m.vy || 0, r.dy * r.impact * 0.8 + 0.1); m.og = false;
  }

  // ---- players: damage by the original formula, sent as a HURT packet (the client owns the health) ----
  for (const p of g.players.values()) {
    if (Math.abs(p.x - cx) > R + 1 || Math.abs(p.y - cy) > R + 1 || Math.abs(p.z - cz) > R + 1) continue;
    const r = impactOf(p.x, p.y + 0.9, p.z, 1.8);
    if (r && r.dmg > 0) p.send(S.hurt(r.dmg));
  }
  g.sound(SND.explode, cx, cy, cz, 4, (1 + (rnd() - rnd()) * 0.2) * 0.7);

  // ---- blocks (the original walks its list backwards) ----
  const list = [...hit.values()];
  for (let i = list.length - 1; i >= 0; i--) {
    const [x, y, z, id] = list[i];
    const now = g.block(x, y, z);
    if (now === 0 || now !== id) continue;                // already gone (a dependent block popped off)
    if (id === TNT) { g.setBlock(x, y, z, 0, 0); addPrimed(g, x, y, z, chainFuse()); continue; }
    if (CONTAINERS.has(id)) g.dropContents?.(x, y, z);
    const doDrop = rnd() < 0.3 && !CONTAINERS.has(id);
    if (doDrop) g.dropFor(id, x, y, z);
    g.pop(x, y, z, false);
  }
}

export default {
  name: "tnt",

  onSetBlock(g, x, y, z, id) {
    if (id === FIRE) {
      for (const [a, b, c] of NEIGH) if (g.block(x + a, y + b, z + c) === TNT) ignite(g, x + a, y + b, z + c);
    } else if (id === TNT) {
      for (const [a, b, c] of NEIGH) if (g.block(x + a, y + b, z + c) === FIRE) { ignite(g, x, y, z); return; }
    }
  },

  onUse(g, p, { x, y, z, item }, touched) {
    if (item !== FLINT || g.block(x, y, z) !== TNT) return false;
    ignite(g, x, y, z);
    touched.push([x, y, z]);
    return true;
  },

  tick(g) {
    const s = st(g);
    // primed TNT: fuse, falling, flashing
    if (s.primed.length) {
      const keep = [];
      for (const e of s.primed) {
        let [x, y, z, vy, fuse] = e;
        fuse--;
        const bx = Math.floor(x), bz = Math.floor(z);
        if (g.chunks.has(ckey(bx, bz))) {                  // gravity (jd.e_), landing on solid blocks
          vy = (vy - 0.04) * 0.98;
          const ny = y + vy;
          if (vy < 0 && !NOT_SOLID.has(g.block(bx, Math.floor(ny), bz))) { y = Math.floor(ny) + 1; vy = 0; }
          else if (ny > 1) y = ny;
        }
        e[1] = y; e[3] = vy; e[4] = fuse;
        const cell = [bx, Math.floor(y + 0.5), bz];
        if (fuse <= 0) {
          restore(g, e[5], e[6], e[7]);
          if (s.queue.length < MAX_QUEUE) s.queue.push([x, y + 0.49, z, POWER]);
          continue;
        }
        const white = Math.floor(fuse / 5) % 2 === 0 ? 1 : 0;
        const moved = cell[0] !== e[5] || cell[1] !== e[6] || cell[2] !== e[7];
        if (moved) { restore(g, e[5], e[6], e[7]); e[5] = cell[0]; e[6] = cell[1]; e[7] = cell[2]; e[8] = -1; }
        // resend every 5 ticks (also covers players who arrive mid-fuse) and on change
        if (e[8] !== white || fuse % 5 === 0) {
          show(g, e[5], e[6], e[7], white ? WOOL : TNT, 0);
          e[8] = white;
        }
        keep.push(e);
      }
      s.primed = keep;
    }
    // explosions waiting to go off (bounded per tick)
    for (let n = 0; n < MAX_EXPLOSIONS && s.queue.length; n++) {
      const [x, y, z, power] = s.queue.shift();
      explode(g, x, y, z, power);
    }
  },

  save(g) { const s = st(g); return { primed: s.primed, queue: s.queue }; },
  load(g, state) {
    g.tnt = { primed: Array.isArray(state?.primed) ? state.primed : [], queue: Array.isArray(state?.queue) ? state.queue : [] };
  },
};
