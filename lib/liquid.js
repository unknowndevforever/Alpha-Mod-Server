// Water and lava flow. A port of the game's own BlockFlowing / BlockStationary / BlockFluid logic
// (read from the a1.1.2 bytecode: classes hv, hn, jp), driven by a queue of scheduled block updates.
//   id 8 flowing water, 9 still water, 10 flowing lava, 11 still lava; metadata 0 = source, 1-7 = distance,
//   +8 = falling (water coming from above).
import { SOLID_NOT } from "./world.js";

const WATER_TICK = 5, LAVA_TICK = 30;
const MAX_QUEUE = 6000, PER_TICK = 250;
const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

const isLiquid = (id) => id >= 8 && id <= 11;

/** The game's blockBlocksFlow: doors, signs, ladders, reeds and every solid material. */
export function blocksFlow(id) {
  if (id === 64 || id === 71 || id === 63 || id === 68 || id === 65 || id === 83) return true;
  if (id === 0) return false;
  return !SOLID_NOT.has(id);
}

function loaded(g, x, z) { return g.chunks.has(`${x >> 4},${z >> 4}`); }
/** Block lookup that never generates new chunks and treats the void as solid, so liquid stays inside the loaded world. */
function blk(g, x, y, z) {
  if (y < 0) return 7;
  if (y > 127) return 0;
  return loaded(g, x, z) ? g.block(x, y, z) : 7;
}

export function liquidSchedule(g, x, y, z, delay) {
  const q = g.liquidQ, k = `${x},${y},${z}`;
  if (q.has(k)) return;
  if (q.size >= MAX_QUEUE) return;
  q.set(k, g.time + delay);
}

/** Quietly swap a block's id (no neighbour notification), but still tell the players. */
function quiet(g, x, y, z, id, meta) {
  g.liqQuiet = true;
  try { g.setBlock(x, y, z, id, meta); } finally { g.liqQuiet = false; }
}

/** The block at (x,y,z) just changed: wake the liquids around it (BlockFluid / BlockStationary onNeighborBlockChange). */
export function liquidNotify(g, x, y, z) {
  const spots = [[x, y, z], [x - 1, y, z], [x + 1, y, z], [x, y - 1, z], [x, y + 1, z], [x, y, z - 1], [x, y, z + 1]];
  for (const [a, b, c] of spots) {
    if (b < 0 || b > 127 || !loaded(g, a, c)) continue;
    let id = g.block(a, b, c);
    if (!isLiquid(id)) continue;
    if (id === 9 || id === 11) {                                  // still -> flowing again, it has somewhere to go now
      quiet(g, a, b, c, id - 1, g.meta(a, b, c));
      id -= 1;
    }
    if (id === 10 && harden(g, a, b, c)) continue;
    liquidSchedule(g, a, b, c, id === 8 ? WATER_TICK : LAVA_TICK);
  }
}

/** Lava touching water turns into obsidian (source) or cobblestone (flowing). */
function harden(g, x, y, z) {
  if (g.block(x, y, z) !== 10) return false;
  const near = [[x, y, z - 1], [x, y, z + 1], [x - 1, y, z], [x + 1, y, z], [x, y + 1, z]];
  if (!near.some(([a, b, c]) => { const i = blk(g, a, b, c); return i === 8 || i === 9; })) return false;
  const m = g.meta(x, y, z);
  if (m === 0) { g.setBlock(x, y, z, 49, 0); return true; }
  if (m <= 4) { g.setBlock(x, y, z, 4, 0); return true; }
  return false;
}

export function tickLiquids(g) {
  const q = g.liquidQ;
  if (!q.size) return;
  let n = 0;
  for (const [k, due] of q) {
    if (due > g.time) continue;
    q.delete(k);
    const [x, y, z] = k.split(",").map(Number);
    flow(g, x, y, z);
    if (++n >= PER_TICK) break;
  }
}

function flow(g, x, y, z) {
  const id = blk(g, x, y, z);
  if (id !== 8 && id !== 10) return;
  const lava = id === 10, rate = lava ? LAVA_TICK : WATER_TICK, decay = lava ? 2 : 1;
  const same = (b) => b === id || b === id + 1;
  const decayAt = (a, b, c) => (same(blk(g, a, b, c)) ? g.meta(a, b, c) : -1);
  let srcs = 0;
  const smallest = (a, b, c, cur) => {
    let d = decayAt(a, b, c);
    if (d < 0) return cur;
    if (d === 0) srcs++;
    if (d >= 8) d = 0;
    return cur < 0 || d < cur ? d : cur;
  };
  const toStill = () => quiet(g, x, y, z, id + 1, g.meta(x, y, z));

  let l = decayAt(x, y, z), keep = true;
  if (l > 0) {
    let low = -100;
    for (const [dx, dz] of DIRS) low = smallest(x + dx, y, z + dz, low);
    let next = low + decay;
    if (next >= 8 || low < 0) next = -1;
    const up = decayAt(x, y + 1, z);
    if (up >= 0) next = up >= 8 ? up : up + 8;
    if (srcs >= 2 && !lava) {                                     // two sources next to it: it becomes a source (infinite water)
      if (blocksFlow(blk(g, x, y - 1, z))) next = 0;
      else if (same(blk(g, x, y - 1, z)) && g.meta(x, y - 1, z) === 0) next = 0;
    }
    if (lava && l < 8 && next < 8 && next > l && Math.random() >= 0.25) { next = l; keep = false; }   // lava spreads slowly
    if (next !== l) {
      l = next;
      if (l < 0) g.setBlock(x, y, z, 0, 0);
      else { g.setBlock(x, y, z, id, l); liquidSchedule(g, x, y, z, rate); }
    } else if (keep) toStill();
  } else toStill();
  if (l < 0) return;

  const canSpread = (a, b, c) => {
    if (b < 0) return false;
    const t = blk(g, a, b, c);
    if (same(t)) return false;
    if (id === 8 || id === 9) { if (t === 10 || t === 11) return false; }
    else if (t === 8 || t === 9) { /* lava runs into water, it will harden */ }
    return !blocksFlow(t);
  };
  const into = (a, b, c, m) => {
    if (!canSpread(a, b, c)) return;
    const t = blk(g, a, b, c);
    if (t > 0 && !lava && !isLiquid(t)) g.dropFor(t, a, b, c);
    g.setBlock(a, b, c, id, m);
    liquidSchedule(g, a, b, c, rate);
  };

  if (canSpread(x, y - 1, z)) {                                   // straight down first
    into(x, y - 1, z, l >= 8 ? l : l + 8);
  } else if (l === 0 || blocksFlow(blk(g, x, y - 1, z))) {        // then sideways, towards the nearest drop
    const dirs = optimalDirs(g, x, y, z, id, blocksFlow, same);
    let k = l + decay;
    if (l >= 8) k = 1;
    if (k >= 8) return;
    DIRS.forEach(([dx, dz], i) => { if (dirs[i]) into(x + dx, y, z + dz, k); });
  }
}

/** Which of the four directions lead to the closest edge to fall off (search depth 4), like BlockFlowing.getOptimalFlowDirections. */
function optimalDirs(g, x, y, z, id, bf, same) {
  const cost = [1000, 1000, 1000, 1000];
  const open = (a, b, c) => !bf(blk(g, a, b, c)) && !(same(blk(g, a, b, c)) && g.meta(a, b, c) === 0);
  const search = (a, b, c, depth, from) => {
    let best = 1000;
    for (let k = 0; k < 4; k++) {
      if ((k === 0 && from === 1) || (k === 1 && from === 0) || (k === 2 && from === 3) || (k === 3 && from === 2)) continue;
      const na = a + DIRS[k][0], nc = c + DIRS[k][1];
      if (open(na, b, nc)) {
        if (!bf(blk(g, na, b - 1, nc))) return depth;
        if (depth < 4) { const v = search(na, b, nc, depth + 1, k); if (v < best) best = v; }
      }
    }
    return best;
  };
  for (let i = 0; i < 4; i++) {
    const a = x + DIRS[i][0], c = z + DIRS[i][1];
    if (open(a, y, c)) cost[i] = !bf(blk(g, a, y - 1, c)) ? 0 : search(a, y, c, 1, i);
  }
  const min = Math.min(...cost);
  return cost.map((v) => v === min);
}
