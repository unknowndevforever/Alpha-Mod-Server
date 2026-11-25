// ONE table with every sound name the server sends (packet 0x3e). All names exist in the patched client (see README.txt).
import { S } from "./protocol.js";

export const SND = {
  explode: "random.explode", click: "random.click", pop: "random.pop", fizz: "random.fizz",
  doorOpen: "random.door_open", doorClose: "random.door_close", bow: "random.bow", fuse: "random.fuse",
  splash: "liquid.splash", lavapop: "liquid.lavapop",
};

// per mob type id: idle / hurt / death sound names (a missing key = silent)
export const MOB_SND = {
  54: { idle: "mob.zombie", hurt: "mob.zombiehurt", death: "mob.zombiedeath" },
  51: { idle: "mob.skeleton", hurt: "mob.skeletonhurt", death: "mob.skeletonhurt" },
  52: { idle: "mob.spider", hurt: "mob.spider", death: "mob.spiderdeath" },
  50: { idle: null, hurt: "mob.creeper", death: "mob.creeperdeath" },
  90: { idle: "mob.pig", hurt: "mob.pig", death: "mob.pigdeath" },
  91: { idle: "mob.sheep", hurt: "mob.sheep", death: "mob.sheep" },
  92: { idle: "mob.cow", hurt: "mob.cowhurt", death: "mob.cowhurt" },
  93: { idle: "mob.chicken", hurt: "mob.chickenhurt", death: "mob.chickenhurt" },
};

/** Send a sound to every player within range (16 blocks; louder than vol 1 carries vol*16). */
export function playSound(g, name, x, y, z, vol = 1, pitch = 1) {
  if (!name || !g.players.size) return;
  const r = 16 * Math.max(1, vol), r2 = r * r;
  let pk = null;
  for (const p of g.players.values()) {
    const dx = p.x - x, dy = p.y - y, dz = p.z - z;
    if (dx * dx + dy * dy + dz * dz <= r2) p.send(pk ??= S.sound(name, x, y, z, vol, pitch));
  }
}

/** kind = "idle" | "hurt" | "death" */
export function mobSound(g, m, kind) {
  const n = MOB_SND[m.type]?.[kind];
  if (n) playSound(g, n, m.x, m.y + 0.5, m.z, 1, 0.9 + Math.random() * 0.2);
}
