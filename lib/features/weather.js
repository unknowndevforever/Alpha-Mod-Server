// Feature module "weather": global rain on/off. State g.weather = { raining, until } (until = game tick of the next change,
// null = not scheduled yet), saved with the game so every instance sees the same weather.
//  - clear lasts 12000-30000 ticks (10-25 min), rain 3600-10800 ticks (3-9 min)
//  - every player is sent S.weather(state) on a change and when they log in (onLogin hook)
//  - helpers used by other features: isRaining(g), exposed(g, x, y, z) (open sky above the block at x,y,z)
import { S } from "../protocol.js";
import { SOLID_NOT } from "../world.js";

const rndRange = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const duration = (raining) => (raining ? rndRange(3600, 10800) : rndRange(12000, 30000));

export const isRaining = (g) => !!g.weather?.raining;

/** Is the sky open above (x,y,z)? Scans the column upwards in loaded chunks only (at most 127 reads). */
export function exposed(g, x, y, z) {
  const c = g.chunks.get(`${x >> 4},${z >> 4}`);
  if (!c) return false;
  const lx = x & 15, lz = z & 15;
  for (let yy = Math.max(0, y + 1); yy < 128; yy++) { const id = c.get(lx, yy, lz); if (!SOLID_NOT.has(id) || (id >= 8 && id <= 11)) return false; }
  return true;
}

/** Change the weather now (rain true/false) with a fresh random duration, and tell everybody. */
export function setWeather(g, raining, ticks) {
  const w = (g.weather ??= { raining: false, until: null });
  const changed = w.raining !== !!raining;
  w.raining = !!raining;
  w.until = g.time + (ticks ?? duration(w.raining));
  if (changed) g.broadcast(S.weather(w.raining));
}

export default {
  name: "weather",

  tick(g) {
    const w = (g.weather ??= { raining: false, until: null });
    if (w.until == null) w.until = g.time + duration(w.raining);
    else if (g.time >= w.until) setWeather(g, !w.raining);
  },

  onLogin(g, p) { p.send(S.weather(isRaining(g))); },

  save(g) { return { raining: !!g.weather?.raining, until: g.weather?.until ?? null }; },
  load(g, state) {
    g.weather = { raining: !!state?.raining, until: Number.isFinite(state?.until) ? state.until : null };
  },
};
