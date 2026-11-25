// Feature module "combat": what hostile mobs do to players. The client owns the player's health, so the server only
// sends damage that comes from outside (packet 0x08, S.hurt): mobs and explosions (explosions: see tnt.js explode()).
//  - zombie: melee 5, spider: melee 3, only when the player is within 1.5 blocks horizontally and 2 vertically;
//    one hit per second per mob (m.cd = tick of the next allowed attack)
//  - skeleton: shoots an "arrow" every 2 s at a player within 8 blocks with a clear line: 2-4 damage + bow sound
//    (approximation: no flying entity, the arrow always hits)
//  - creeper: a player within 3 blocks starts a 30 tick fuse (m.fuse, hiss, the creeper stands still); the fuse is cancelled
//    when the player gets farther than 7 blocks, otherwise the creeper dies in a power 3 explosion (tnt.js)
//  - idle sounds of every mob (rare, only when a player is within 16 blocks)
// Per mob state lives on the mob object (fields cd, fuse), which is saved with the game.
import { S } from "../protocol.js";
import { MOBS, removeMob } from "../mobs.js";
import { SND, mobSound } from "../sounds.js";
import { explode } from "./tnt.js";

const MELEE = { 54: 5, 52: 3 };
const MELEE_COOLDOWN = 20, ARROW_COOLDOWN = 40, FUSE = 30, CREEPER_POWER = 3;
const NOT_SOLID = new Set([0, 6, 8, 9, 10, 11, 18, 20, 27, 28, 37, 38, 39, 40, 50, 51, 55, 59, 63, 65, 66, 68, 69, 70, 72, 75, 76, 77, 78, 83, 90]);

/** Is the straight line between two points free of solid blocks (loaded chunks only, about 2 samples per block)? */
function clear(g, x1, y1, z1, x2, y2, z2) {
  const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1, n = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) * 2));
  for (let i = 1; i < n; i++) {
    const bx = Math.floor(x1 + dx * i / n), by = Math.floor(y1 + dy * i / n), bz = Math.floor(z1 + dz * i / n);
    if (by < 0 || by > 127 || !g.chunks.has(`${bx >> 4},${bz >> 4}`)) return false;
    if (!NOT_SOLID.has(g.block(bx, by, bz))) return false;
  }
  return true;
}

export default {
  name: "combat",

  tick(g) {
    if (!g.players.size || !g.mobs.size) return;
    for (const m of [...g.mobs.values()]) {
      const def = MOBS[m.type];
      if (!def) continue;
      // nearest player within 24 blocks
      let pl = null, bh = 24;
      for (const p of g.players.values()) {
        const h = Math.hypot(p.x - m.x, p.z - m.z);
        if (h < bh) { bh = h; pl = p; }
      }
      if (!pl) continue;
      if (Math.random() < 0.003 && bh < 16) mobSound(g, m, "idle");
      if (!def.hostile) continue;
      const dy = pl.y - m.y;

      if (m.type === 54 || m.type === 52) {
        if (bh < 1.5 && dy > -2 && dy < 2 && g.time >= (m.cd || 0)) {
          m.cd = g.time + MELEE_COOLDOWN;
          pl.send(S.hurt(MELEE[m.type]));
        }
      } else if (m.type === 51) {
        if (bh <= 8 && Math.abs(dy) < 5 && g.time >= (m.cd || 0) && clear(g, m.x, m.y + 1.5, m.z, pl.x, pl.y + 1.2, pl.z)) {
          m.cd = g.time + ARROW_COOLDOWN;
          g.sound(SND.bow, m.x, m.y + 1.2, m.z, 1, 1 / (Math.random() * 0.4 + 0.8));
          pl.send(S.hurt(2 + Math.floor(Math.random() * 3)));
        }
      } else if (m.type === 50) {
        if (!(m.fuse > 0)) {
          if (bh < 3 && Math.abs(dy) < 3) { m.fuse = 1; g.sound(SND.fuse, m.x, m.y + 0.5, m.z, 1, 0.5); }
        } else if (bh > 7) m.fuse = 0;
        else if (++m.fuse >= FUSE) {
          removeMob(g, m);
          explode(g, m.x, m.y + 0.5, m.z, CREEPER_POWER);
        }
      }
    }
  },
};
