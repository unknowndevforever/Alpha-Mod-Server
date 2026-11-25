// Mobs. The game client only understands "a mob of type T is at X,Y,Z" (spawn 0x18) and position updates, and its
// protocol has no attack / health packets, so everything else is decided here:
//   - movement, gravity, swimming and wandering / chasing are simulated on the server
//   - hits are detected from the player's arm swing (packet 0x12) + where they look, with the held item's damage
//   - a killed mob disappears and drops loot
// Hostile mobs chase players but cannot hurt them: the protocol has no way to tell the game to lower health.
import { S } from "./protocol.js";
import { SOLID_NOT, SEA } from "./world.js";

export const MOBS = {
  //        name        hp  speed  radius height hostile loot [item, max count]
  50: { name: "Creeper", hp: 20, speed: 0.12, r: 0.3, h: 1.7, hostile: true, loot: [289, 2] },
  51: { name: "Skeleton", hp: 20, speed: 0.1, r: 0.3, h: 1.8, hostile: true, loot: [262, 2] },
  52: { name: "Spider", hp: 16, speed: 0.15, r: 0.6, h: 0.9, hostile: true, loot: [287, 2] },
  54: { name: "Zombie", hp: 20, speed: 0.1, r: 0.3, h: 1.8, hostile: true, loot: [288, 2] },
  90: { name: "Pig", hp: 10, speed: 0.07, r: 0.45, h: 0.9, hostile: false, loot: [319, 2] },
  91: { name: "Sheep", hp: 8, speed: 0.07, r: 0.45, h: 1.3, hostile: false, loot: [35, 1, 1] },
  92: { name: "Cow", hp: 10, speed: 0.07, r: 0.45, h: 1.3, hostile: false, loot: [334, 2] },
  93: { name: "Chicken", hp: 4, speed: 0.06, r: 0.2, h: 0.7, hostile: false, loot: [288, 2] },
};
const ANIMALS = [90, 91, 92, 93], HOSTILES = [54, 54, 51, 52, 50];

const MAX_MOBS = 90;
const SEND_EVERY = 3;                    // ticks between position packets per mob
const SIM_RANGE = 96;                    // only mobs this close to a player are simulated
const MELEE = { 268: 4, 272: 5, 267: 6, 276: 7, 283: 4,           // swords
  270: 2, 274: 3, 257: 4, 278: 5, 285: 2,                           // pickaxes
  271: 3, 275: 4, 258: 5, 279: 6, 286: 3,                           // axes
  269: 1, 273: 2, 256: 3, 277: 4, 284: 1 };                         // shovels

const solid = (id) => id !== 0 && !SOLID_NOT.has(id);
const isLiq = (id) => id >= 8 && id <= 11;
const ckey = (x, z) => `${Math.floor(x) >> 4},${Math.floor(z) >> 4}`;
const rnd = (a, b) => a + Math.random() * (b - a);

function collide(g, x, y, z, r, h) {
  for (let bx = Math.floor(x - r); bx <= Math.floor(x + r); bx++)
    for (let bz = Math.floor(z - r); bz <= Math.floor(z + r); bz++)
      for (let by = Math.floor(y); by <= Math.floor(y + h - 0.001); by++) {
        if (by < 0) return true;
        if (solid(g.block(bx, by, bz))) return true;
      }
  return false;
}

export function spawnMob(g, type, x, y, z, sky = false) {
  const def = MOBS[type];
  const m = { eid: g.nextEid++, type, x, y, z, vy: 0, yaw: Math.random() * 360, hp: def.hp, tx: x, tz: z, timer: 0,
    og: false, kx: 0, kz: 0, last: -99, sx: NaN, sy: NaN, sz: NaN, syaw: NaN, sky };
  g.mobs.set(m.eid, m);
  return m;
}

function removeMob(g, m) {
  g.mobs.delete(m.eid);
  const pk = S.destroyEntity(m.eid);
  for (const p of g.players.values()) if (p.mobs.delete(m.eid)) p.send(pk);
}

function nearestPlayer(g, x, z) {
  let best = null, bd = Infinity;
  for (const p of g.players.values()) {
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return [best, Math.sqrt(bd)];
}

export function tickMobs(g) {
  if (!g.mobs.size && !g.players.size) return;
  if (g.time % 100 === 0) for (let i = 0; i < 5; i++) spawnAnimals(g);        // a few random spots, most get rejected
  if (g.time % 40 === 20) for (let i = 0; i < 8; i++) spawnHostiles(g);
  if (g.time % 100 === 50) despawn(g);
  for (const m of g.mobs.values()) {
    const [pl, dist] = nearestPlayer(g, m.x, m.z);
    if (!pl || dist > SIM_RANGE || !g.chunks.has(ckey(m.x, m.z))) continue;
    step(g, m, pl, dist);
  }
}

function step(g, m, pl, dist) {
  const def = MOBS[m.type];
  let dx = 0, dz = 0, speed = def.speed;
  if (def.hostile && dist < 20 && Math.abs(pl.y - m.y) < 12) {            // chase
    m.tx = pl.x; m.tz = pl.z; m.timer = 10;
    if (dist < (m.type === 51 ? 4 : 1.3)) speed = 0;
  } else if (--m.timer <= 0) {                                              // wander / idle
    if (Math.random() < 0.4) { m.tx = m.x; m.tz = m.z; m.timer = (20 + Math.random() * 40) | 0; }
    else { const a = Math.random() * Math.PI * 2, d = rnd(3, 8); m.tx = m.x + Math.cos(a) * d; m.tz = m.z + Math.sin(a) * d; m.timer = (60 + Math.random() * 100) | 0; }
  }
  const vx = m.tx - m.x, vz = m.tz - m.z, len = Math.hypot(vx, vz);
  if (len > 0.4 && speed > 0) {
    dx = (vx / len) * speed; dz = (vz / len) * speed;
    m.yaw = (Math.atan2(-vx, vz) * 180) / Math.PI;
    if (!def.hostile) {                                                      // animals keep out of water
      const nb = g.block(Math.floor(m.x + dx * 6), Math.floor(m.y), Math.floor(m.z + dz * 6));
      if (isLiq(nb)) { dx = dz = 0; m.timer = 0; }
    }
  }
  dx += m.kx; dz += m.kz; m.kx *= 0.6; m.kz *= 0.6;
  if (Math.abs(m.kx) < 0.01) m.kx = 0;
  if (Math.abs(m.kz) < 0.01) m.kz = 0;

  if (collide(g, m.x, m.y, m.z, def.r, def.h)) { m.y += 1; m.vy = 0; if (m.y > 126) m.y = 126; }   // stuck in a block: pop up
  const mx = m.x + dx;
  if (dx && !collide(g, mx, m.y, m.z, def.r, def.h)) m.x = mx; else if (dx && m.og) m.vy = 0.42;
  const mz = m.z + dz;
  if (dz && !collide(g, m.x, m.y, mz, def.r, def.h)) m.z = mz; else if (dz && m.og) m.vy = 0.42;

  const wet = isLiq(g.block(Math.floor(m.x), Math.floor(m.y + 0.3), Math.floor(m.z)));
  if (wet) m.vy = Math.min(m.vy + 0.05, 0.12); else m.vy = (m.vy - 0.08) * 0.98;
  const ny = m.y + m.vy;
  if (collide(g, m.x, ny, m.z, def.r, def.h)) {
    if (m.vy < 0) { const top = Math.floor(ny) + 1; if (!collide(g, m.x, top, m.z, def.r, def.h)) m.y = top; m.og = true; } else m.og = false;
    m.vy = 0;
  } else { m.y = ny; m.og = false; }
  if (m.y < -5) removeMob(g, m);
}

// ---------- spawning ----------
const night = (g) => { const t = g.time % 24000; return t > 13000 && t < 23000; };

function spot(g, pl, minD, maxD) {
  const a = Math.random() * Math.PI * 2, d = rnd(minD, maxD);
  const x = Math.floor(pl.x + Math.cos(a) * d), z = Math.floor(pl.z + Math.sin(a) * d);
  if (!g.chunks.has(ckey(x, z))) return null;
  for (const o of g.players.values()) if (Math.hypot(o.x - x, o.z - z) < minD * 0.7) return null;
  return [x, z];
}

function count(g, hostile) { let n = 0; for (const m of g.mobs.values()) if (MOBS[m.type].hostile === hostile) n++; return n; }

function spawnAnimals(g) {
  const players = [...g.players.values()];
  if (!players.length || g.mobs.size >= MAX_MOBS) return;
  if (count(g, false) >= Math.min(40, 10 + 6 * players.length)) return;
  const pl = players[(Math.random() * players.length) | 0];
  const s = spot(g, pl, 14, 40);
  if (!s) return;
  const [y, id] = g.surface(s[0], s[1]);
  if (id !== 2 || y < SEA) return;                                          // animals spawn on grass above sea level
  const type = ANIMALS[(Math.random() * ANIMALS.length) | 0], n = 1 + ((Math.random() * 3) | 0);
  for (let i = 0; i < n; i++) spawnMob(g, type, s[0] + 0.5 + rnd(-2, 2), y + 1, s[1] + 0.5 + rnd(-2, 2));
}

function spawnHostiles(g) {
  const players = [...g.players.values()];
  if (!players.length || g.mobs.size >= MAX_MOBS) return;
  if (count(g, true) >= Math.min(24, 6 + 4 * players.length)) return;
  const pl = players[(Math.random() * players.length) | 0];
  const s = spot(g, pl, 16, 36);
  if (!s) return;
  const [x, z] = s, [sy, sid] = g.surface(x, z);
  let y = -1, sky = false;
  if (night(g) && Math.random() < 0.6 && sid !== 9 && sid !== 18) { y = sy + 1; sky = true; }          // outside at night
  else {                                                                       // underground, any time
    const cy = 8 + ((Math.random() * 45) | 0);
    if (cy + 4 < sy && !solid(g.block(x, cy, z)) && !solid(g.block(x, cy + 1, z)) && solid(g.block(x, cy - 1, z)) && !isLiq(g.block(x, cy, z))) y = cy;
  }
  if (y < 1) return;
  spawnMob(g, HOSTILES[(Math.random() * HOSTILES.length) | 0], x + 0.5, y, z + 0.5, sky);
}

function despawn(g) {
  for (const m of [...g.mobs.values()]) {
    const [pl, dist] = nearestPlayer(g, m.x, m.z);
    const def = MOBS[m.type];
    if (!pl || dist > 110) { if (!pl || Math.random() < 0.5) removeMob(g, m); continue; }
    if (def.hostile && m.sky && !night(g) && Math.random() < 0.3) removeMob(g, m);       // sunrise
  }
}

// ---------- telling the players ----------
/** Spawn mobs on the screens of players who now have their chunk loaded, move them, and remove them from far players. */
export function syncMobs(g) {
  for (const p of g.players.values()) {
    for (const m of g.mobs.values()) {
      const visible = p.loaded.has(ckey(m.x, m.z));
      const seen = p.mobs.has(m.eid);
      if (visible && !seen) { p.mobs.add(m.eid); p.send(S.mobSpawn(m.eid, m.type, m.x, m.y, m.z, m.yaw, 0)); }
      else if (!visible && seen) { p.mobs.delete(m.eid); p.send(S.destroyEntity(m.eid)); }
      else if (visible && g.time - m.last >= SEND_EVERY && (m.x !== m.sx || m.y !== m.sy || m.z !== m.sz || m.yaw !== m.syaw)) {
        p.send(S.teleport(m.eid, m.x, m.y, m.z, m.yaw, 0));
      }
    }
    for (const eid of p.mobs) if (!g.mobs.has(eid)) { p.mobs.delete(eid); p.send(S.destroyEntity(eid)); }
  }
  for (const m of g.mobs.values()) {
    if (g.time - m.last >= SEND_EVERY && (m.x !== m.sx || m.y !== m.sy || m.z !== m.sz || m.yaw !== m.syaw)) {
      m.last = g.time; m.sx = m.x; m.sy = m.y; m.sz = m.z; m.syaw = m.yaw;
    }
  }
}

// ---------- fighting ----------
/** The player swung their arm: if a mob is in reach and in front of them, hit it. */
export function swing(g, p) {
  const now = Date.now();
  if (now - (p.lastHit || 0) < 450) return;
  const yaw = (p.yaw * Math.PI) / 180, pitch = (p.pitch * Math.PI) / 180;
  const lx = -Math.sin(yaw) * Math.cos(pitch), ly = -Math.sin(pitch), lz = Math.cos(yaw) * Math.cos(pitch);
  const ex = p.x, ey = p.y + 1.62, ez = p.z;
  let best = null, bd = 9;                                                     // 3 blocks of reach
  for (const m of g.mobs.values()) {
    const def = MOBS[m.type];
    const dx = m.x - ex, dy = m.y + def.h / 2 - ey, dz = m.z - ez, d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2);
    if (d2 > bd || d < 0.01) continue;
    if ((dx * lx + dy * ly + dz * lz) / d < 0.82 - Math.min(0.2, def.r / d)) continue;     // not looking at it
    best = m; bd = d2;
  }
  if (!best) return;
  p.lastHit = now;
  const dmg = MELEE[p.held] || 1, def = MOBS[best.type];
  best.hp -= dmg;
  const dx = best.x - p.x, dz = best.z - p.z, l = Math.hypot(dx, dz) || 1;
  best.kx = (dx / l) * 0.3; best.kz = (dz / l) * 0.3; best.vy = 0.3; best.og = false;
  if (best.hp > 0) return;
  removeMob(g, best);
  const [item, max, min = 0] = def.loot, n = min + ((Math.random() * (max - min + 1)) | 0);
  if (n > 0) g.spawnItem(item, n, best.x, best.y + 0.4, best.z, rnd(-0.1, 0.1), 0.2, rnd(-0.1, 0.1), 10);
}
