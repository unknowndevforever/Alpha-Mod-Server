// Feature module "redstone": a port of the a1.1.2 redstone logic, read from the original bytecode:
//   kf  BlockRedstoneWire (55)       meta = power 0..15, recursive decrement propagation, connection-shaped output
//   bg  BlockRedstoneTorch (75/76)   tick rate 2, inverts the block it is attached to, burns out after 8 toggles/100 ticks
//   no  BlockLever (69)              meta&7 = attachment (1..4 walls, 5/6 floor), meta&8 = on
//   hu  BlockButton (77)             like the lever, walls only (1..4), releases after 20 ticks
//   al  BlockPressurePlate (70/72)   stone: living entities, wood: every entity (items too), re-checked every 20 ticks
//   fw  BlockDoor (64/71)            follows power when a power-source neighbour changes (iron doors: power only)
//   q   BlockTNT (46)                ignites when a power-source neighbour changes and it is powered (tnt.js does the rest)
//   cn  World                        isBlockIndirectlyGettingPowered (o), getting strongly powered (n), the scheduled
//                                    update set (x,y,z,id keyed, 1000 per tick) and setBlockWithNotify / neighbour notify
// The game's neighbour notifications are emulated: every block change made by someone else (players, liquids, other
// features) notifies the 6 neighbours like World.setBlockWithNotify; the changes made here use the exact original calls.
// State in g (saved): g.rsQ (scheduled updates "x,y,z,id" -> due tick), g.rsBurn (torch burn-out records).
import { MOBS } from "../mobs.js";
import * as tnt from "./tnt.js";

const WIRE = 55, TORCH_OFF = 75, TORCH_ON = 76, LEVER = 69, BUTTON = 77, PLATE_STONE = 70, PLATE_WOOD = 72;
const DOOR_WOOD = 64, DOOR_IRON = 71, TNT = 46;
const TICK_RATE = { [TORCH_OFF]: 2, [TORCH_ON]: 2, [BUTTON]: 20, [PLATE_STONE]: 20, [PLATE_WOOD]: 20 };
const PROVIDERS = new Set([WIRE, LEVER, PLATE_STONE, PLATE_WOOD, TORCH_OFF, TORCH_ON, BUTTON]);   // Block.canProvidePower
const RELEVANT = new Set([...PROVIDERS, DOOR_WOOD, DOOR_IRON, TNT]);
// Block.isNormalCube (ly.b()) is false for these; everything else is a normal cube.
const NOT_NORMAL = new Set([0, 6, 8, 9, 10, 11, 18, 20, 37, 38, 39, 40, 44, 50, 51, 52, 53, 55, 59, 60, 63, 64, 65, 66, 67,
  68, 69, 70, 71, 72, 75, 76, 77, 78, 79, 81, 83, 85, 27, 28, 90]);
const MAX_SCHEDULED = 1000;      // the game's limit of scheduled updates run per tick
const MAX_QUEUE = 20000;
const MAX_DEPTH = 300;           // nested notifications deeper than this are deferred to the next tick
const MAX_OPS = 40000;           // block updates per tick, the rest is deferred
const BURN_MAX = 512;

// ---------------------------------------------------------------- world access
const loaded = (g, x, z) => g.chunks.has(`${x >> 4},${z >> 4}`);
const blk = (g, x, y, z) => (y < 0 || y > 127 || !loaded(g, x, z) ? 0 : g.block(x, y, z));
const met = (g, x, y, z) => (y < 0 || y > 127 || !loaded(g, x, z) ? 0 : g.meta(x, y, z));
const normal = (g, x, y, z) => !NOT_NORMAL.has(blk(g, x, y, z));
const key = (x, y, z) => `${x},${y},${z}`;

/** Change a block without any notification (World.setBlockMetadata / setBlock "quiet"), still sent to the players. */
function setQuiet(g, x, y, z, id, meta) {
  if (y < 0 || y > 127 || !loaded(g, x, z)) return;
  const prev = g.rsSkip;
  g.rsSkip = key(x, y, z);
  try { g.setBlock(x, y, z, id, meta); } finally { g.rsSkip = prev; }
}
/** World.setBlockAndMetadataWithNotify: onBlockRemoval(old), onBlockAdded(new), then the 6 neighbours are told. */
function setNotify(g, x, y, z, id, meta) {
  if (y < 0 || y > 127 || !loaded(g, x, z)) return;
  const oldId = g.block(x, y, z), oldMeta = g.meta(x, y, z);
  setQuiet(g, x, y, z, id, meta);
  if (oldId !== id) { removed(g, x, y, z, oldId, oldMeta); added(g, x, y, z, id); }
  notifyAround(g, x, y, z, id);
}

/** World.notifyBlocksOfNeighborChange(x,y,z,id): the 6 neighbours get onNeighborBlockChange(id). */
function notifyAround(g, x, y, z, id) {
  neighbor(g, x - 1, y, z, id); neighbor(g, x + 1, y, z, id);
  neighbor(g, x, y - 1, z, id); neighbor(g, x, y + 1, z, id);
  neighbor(g, x, y, z - 1, id); neighbor(g, x, y, z + 1, id);
}
/** notifyAround for every neighbour of (x,y,z) (what torches / wire do on add and removal). */
function notifyAround6(g, x, y, z, id) {
  notifyAround(g, x, y - 1, z, id); notifyAround(g, x, y + 1, z, id);
  notifyAround(g, x - 1, y, z, id); notifyAround(g, x + 1, y, z, id);
  notifyAround(g, x, y, z - 1, id); notifyAround(g, x, y, z + 1, id);
}

/** World.scheduleBlockUpdate: one pending update per (x,y,z,id), the first one wins. */
function schedule(g, x, y, z, id, delay) {
  const k = `${x},${y},${z},${id}`;
  if (g.rsQ.has(k) || g.rsQ.size >= MAX_QUEUE) return;
  g.rsQ.set(k, g.time + delay);
}
/** Too much work in one go: do this neighbour update on the next tick instead. */
function defer(g, x, y, z, id) {
  const k = `${x},${y},${z},n${id}`;
  if (g.rsQ.has(k) || g.rsQ.size >= MAX_QUEUE) return;
  g.rsQ.set(k, g.time + 1);
}

// ---------------------------------------------------------------- power queries (World + Block.isPoweringTo)
const attached = (m) => {          // lever / button / torch: offset to the block it hangs on
  switch (m & 7) { case 1: return [-1, 0, 0]; case 2: return [1, 0, 0]; case 3: return [0, 0, -1]; case 4: return [0, 0, 1]; default: return [0, -1, 0]; }
};
const canConnect = (g, x, y, z) => PROVIDERS.has(blk(g, x, y, z));   // kf.b(nm,x,y,z): wire or a power source

/** Block.isPoweringTo (weak power), side = direction from the asking block to this one (0 down .. 5 +x). */
function weak(g, x, y, z, side) {
  const id = blk(g, x, y, z);
  switch (id) {
    case WIRE: return wireWeak(g, x, y, z, side);
    case TORCH_ON: {
      const m = met(g, x, y, z);
      if ((m === 5 && side === 1) || (m === 3 && side === 3) || (m === 4 && side === 2) || (m === 1 && side === 5) || (m === 2 && side === 4)) return false;
      return true;
    }
    case LEVER: case BUTTON: return (met(g, x, y, z) & 8) !== 0;
    case PLATE_STONE: case PLATE_WOOD: return met(g, x, y, z) > 0;
    default: return false;
  }
}
/** Block.isIndirectlyPoweringTo (strong power through the block it touches). */
function strong(g, x, y, z, side) {
  const id = blk(g, x, y, z);
  switch (id) {
    case WIRE: return wireWeak(g, x, y, z, side);
    case TORCH_ON: return side === 0 && weak(g, x, y, z, side);
    case LEVER: case BUTTON: {
      const m = met(g, x, y, z);
      if (!(m & 8)) return false;
      const a = m & 7;
      return (a === 5 && side === 1) || (a === 4 && side === 2) || (a === 3 && side === 3) || (a === 2 && side === 4) || (a === 1 && side === 5);
    }
    case PLATE_STONE: case PLATE_WOOD: return met(g, x, y, z) !== 0 && side === 1;
    default: return false;
  }
}
function wireWeak(g, x, y, z, side) {
  if (g.rsNoWire) return false;
  if (met(g, x, y, z) === 0) return false;
  if (side === 1) return true;
  const dir = (dx, dz) => canConnect(g, x + dx, y, z + dz) || (!normal(g, x + dx, y, z + dz) && canConnect(g, x + dx, y - 1, z + dz));
  let w = dir(-1, 0), e = dir(1, 0), n = dir(0, -1), s = dir(0, 1);
  if (!normal(g, x, y + 1, z)) {
    if (normal(g, x - 1, y, z) && canConnect(g, x - 1, y + 1, z)) w = true;
    if (normal(g, x + 1, y, z) && canConnect(g, x + 1, y + 1, z)) e = true;
    if (normal(g, x, y, z - 1) && canConnect(g, x, y + 1, z - 1)) n = true;
    if (normal(g, x, y, z + 1) && canConnect(g, x, y + 1, z + 1)) s = true;
  }
  if (!n && !e && !w && !s && side >= 2 && side <= 5) return true;
  if (side === 2 && n && !w && !e) return true;
  if (side === 3 && s && !w && !e) return true;
  if (side === 4 && w && !n && !s) return true;
  if (side === 5 && e && !n && !s) return true;
  return false;
}
/** World.isBlockGettingPowered (n): a neighbour powers this block strongly. */
function stronglyPowered(g, x, y, z) {
  return strong(g, x, y - 1, z, 0) || strong(g, x, y + 1, z, 1) || strong(g, x, y, z - 1, 2) || strong(g, x, y, z + 1, 3) ||
    strong(g, x - 1, y, z, 4) || strong(g, x + 1, y, z, 5);
}
/** World.isBlockIndirectlyProvidingPowerTo (k). */
function provides(g, x, y, z, side) {
  return normal(g, x, y, z) ? stronglyPowered(g, x, y, z) : weak(g, x, y, z, side);
}
/** World.isBlockIndirectlyGettingPowered (o): is the block at (x,y,z) powered? (doors, TNT, wire input, ...) */
export function isBlockPowered(g, x, y, z) {
  return provides(g, x, y - 1, z, 0) || provides(g, x, y + 1, z, 1) || provides(g, x, y, z - 1, 2) || provides(g, x, y, z + 1, 3) ||
    provides(g, x - 1, y, z, 4) || provides(g, x + 1, y, z, 5);
}
const powered = isBlockPowered;

// ---------------------------------------------------------------- redstone wire (kf)
const wireMax = (g, x, y, z, cur) => { if (blk(g, x, y, z) !== WIRE) return cur; const m = met(g, x, y, z); return m > cur ? m : cur; };
const DIRS4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/** kf.h: recompute the power of the wire at (x,y,z) and spread the change (recursive, like the game). */
function wireUpdate(g, x, y, z) {
  if (blk(g, x, y, z) !== WIRE) return;
  if (g.rsDepth > MAX_DEPTH * 4 || g.rsOps > MAX_OPS) { defer(g, x, y, z, WIRE); return; }
  g.rsOps++; g.rsDepth++;
  try {
    const old = met(g, x, y, z);
    let p = 0;
    g.rsNoWire = true;
    let src;
    try { src = powered(g, x, y, z); } finally { g.rsNoWire = false; }
    if (src) p = 15;
    else {
      for (const [dx, dz] of DIRS4) {
        const a = x + dx, c = z + dz;
        p = wireMax(g, a, y, c, p);
        if (normal(g, a, y, c) && !normal(g, x, y + 1, z)) p = wireMax(g, a, y + 1, c, p);
        else if (!normal(g, a, y, c)) p = wireMax(g, a, y - 1, c, p);
      }
      p = p > 0 ? p - 1 : 0;
    }
    if (old === p) return;
    setQuiet(g, x, y, z, WIRE, p);
    const q = p > 0 ? p - 1 : p;
    for (const [dx, dz] of DIRS4) {
      const a = x + dx, c = z + dz;
      const yy = normal(g, a, y, c) ? y + 1 : y - 1;
      if (blk(g, a, y, c) === WIRE && met(g, a, y, c) !== q) wireUpdate(g, a, y, c);
      if (blk(g, a, yy, c) === WIRE && met(g, a, yy, c) !== q) wireUpdate(g, a, yy, c);
    }
    if (old === 0 || q === 0) {
      notifyAround(g, x, y, z, WIRE);
      notifyAround(g, x - 1, y, z, WIRE); notifyAround(g, x + 1, y, z, WIRE);
      notifyAround(g, x, y, z - 1, WIRE); notifyAround(g, x, y, z + 1, WIRE);
      notifyAround(g, x, y - 1, z, WIRE); notifyAround(g, x, y + 1, z, WIRE);
    }
  } finally { g.rsDepth--; }
}
/** kf.i: a wire at (x,y,z) tells everything around it. */
function wireTell(g, x, y, z) {
  if (blk(g, x, y, z) !== WIRE) return;
  notifyAround(g, x, y, z, WIRE);
  notifyAround6(g, x, y, z, WIRE);
}
/** What kf.e (added) and kf.b (removed) do after their own update: tell the wires around, also one step up/down. */
function wireTellAround(g, x, y, z) {
  notifyAround(g, x, y + 1, z, WIRE);
  notifyAround(g, x, y - 1, z, WIRE);
  for (const [dx, dz] of DIRS4) wireTell(g, x + dx, y, z + dz);
  for (const [dx, dz] of DIRS4) {
    const a = x + dx, c = z + dz;
    wireTell(g, a, normal(g, a, y, c) ? y + 1 : y - 1, c);
  }
}

// ---------------------------------------------------------------- block add / remove / neighbour change
function added(g, x, y, z, id) {
  if (id === WIRE) { wireUpdate(g, x, y, z); wireTellAround(g, x, y, z); }
  else if (id === TORCH_ON) notifyAround6(g, x, y, z, TORCH_ON);
}
/** onBlockRemoval of the block that was there. oldMeta === null: unknown (changed by someone else). */
function removed(g, x, y, z, id, oldMeta) {
  switch (id) {
    case WIRE:
      for (const [dx, dz] of DIRS4) {
        const a = x + dx, c = z + dz;
        wireUpdate(g, a, y, c);
        wireUpdate(g, a, normal(g, a, y, c) ? y + 1 : y - 1, c);
      }
      wireTellAround(g, x, y, z);
      break;
    case TORCH_ON: notifyAround6(g, x, y, z, TORCH_ON); break;
    case LEVER: case BUTTON:
      if (oldMeta === null) { notifyAround(g, x, y, z, id); notifyAround6(g, x, y, z, id); }
      else if (oldMeta & 8) { notifyAround(g, x, y, z, id); const [a, b, c] = attached(oldMeta); notifyAround(g, x + a, y + b, z + c, id); }
      break;
    case PLATE_STONE: case PLATE_WOOD:
      if (oldMeta === null || oldMeta > 0) { notifyAround(g, x, y, z, id); notifyAround(g, x, y - 1, z, id); }
      break;
  }
}
/** Drop the block as an item and remove it (Block.dropBlockAsItem + World.setBlockWithNotify(0)). */
function breakOff(g, x, y, z, id) {
  g.dropFor(id, x, y, z);
  setNotify(g, x, y, z, 0, 0);
}

/** Block.onNeighborBlockChange for the block at (x,y,z); id = the block that changed next to it. */
function neighbor(g, x, y, z, id) {
  if (y < 0 || y > 127 || !loaded(g, x, z)) return;
  const b = g.block(x, y, z);
  if (!RELEVANT.has(b)) return;
  if (g.rsDepth > MAX_DEPTH || g.rsOps > MAX_OPS) { defer(g, x, y, z, id); return; }
  g.rsOps++; g.rsDepth++;
  try {
    switch (b) {
      case WIRE:
        if (!normal(g, x, y - 1, z)) breakOff(g, x, y, z, WIRE);
        else wireUpdate(g, x, y, z);
        break;
      case TORCH_OFF: case TORCH_ON: {
        const [a, bb, c] = attached(g.meta(x, y, z));
        if (!normal(g, x + a, y + bb, z + c)) { breakOff(g, x, y, z, b); break; }
        schedule(g, x, y, z, b, 2);
        break;
      }
      case LEVER: {
        const m = g.meta(x, y, z) & 7;
        if ((m === 1 && !normal(g, x - 1, y, z)) || (m === 2 && !normal(g, x + 1, y, z)) || (m === 3 && !normal(g, x, y, z - 1)) ||
          (m === 4 && !normal(g, x, y, z + 1)) || (m === 5 && !normal(g, x, y - 1, z))) breakOff(g, x, y, z, LEVER);
        break;
      }
      case BUTTON: {
        const m = g.meta(x, y, z) & 7;
        if ((m === 1 && !normal(g, x - 1, y, z)) || (m === 2 && !normal(g, x + 1, y, z)) || (m === 3 && !normal(g, x, y, z - 1)) ||
          (m === 4 && !normal(g, x, y, z + 1))) breakOff(g, x, y, z, BUTTON);
        break;
      }
      case PLATE_STONE: case PLATE_WOOD:
        if (!normal(g, x, y - 1, z)) breakOff(g, x, y, z, b);
        break;
      case DOOR_WOOD: case DOOR_IRON: doorNeighbor(g, x, y, z, b, id); break;
      case TNT:
        if (id > 0 && PROVIDERS.has(id) && powered(g, x, y, z) && typeof tnt.ignite === "function") tnt.ignite(g, x, y, z);
        break;
    }
  } finally { g.rsDepth--; }
}

// ---------------------------------------------------------------- doors (fw), power part only (breaking is game.js)
function doorNeighbor(g, x, y, z, door, id) {
  if (!(id > 0 && PROVIDERS.has(id))) return;
  const m = g.meta(x, y, z);
  if (m & 8) {                                     // top half: the bottom half decides
    if (blk(g, x, y - 1, z) === door) doorNeighbor(g, x, y - 1, z, door, id);
    return;
  }
  if (blk(g, x, y + 1, z) !== door) return;        // half a door: game.js removes it
  setDoor(g, x, y, z, door, powered(g, x, y, z) || powered(g, x, y + 1, z));
}
/** fw.a(cn,x,y,z,boolean): open (meta&4) follows the power. */
function setDoor(g, x, y, z, door, on) {
  const m = g.meta(x, y, z);
  if (m & 8) { if (blk(g, x, y - 1, z) === door) setDoor(g, x, y - 1, z, door, on); return; }
  if (((m & 4) !== 0) === on) return;
  if (blk(g, x, y + 1, z) === door) setQuiet(g, x, y + 1, z, door, (m ^ 4) + 8);
  setQuiet(g, x, y, z, door, m ^ 4);
}

// ---------------------------------------------------------------- scheduled updates (Block.updateTick)
function updateTick(g, x, y, z, id) {
  switch (id) {
    case TORCH_OFF: case TORCH_ON: torchTick(g, x, y, z, id); break;
    case BUTTON: {
      const m = g.meta(x, y, z);
      if (!(m & 8)) return;
      setQuiet(g, x, y, z, BUTTON, m & 7);
      notifyAround(g, x, y, z, BUTTON);
      const [a, b, c] = attached(m);
      notifyAround(g, x + a, y + b, z + c, BUTTON);
      break;
    }
    case PLATE_STONE: case PLATE_WOOD:
      if (g.meta(x, y, z) !== 0) plateCheck(g, x, y, z, id);
      break;
  }
}

/** bg.h: is the block this torch hangs on powered? */
function torchPowered(g, x, y, z) {
  const m = g.meta(x, y, z);
  if (m === 5 && provides(g, x, y - 1, z, 0)) return true;
  if (m === 3 && provides(g, x, y, z - 1, 2)) return true;
  if (m === 4 && provides(g, x, y, z + 1, 3)) return true;
  if (m === 1 && provides(g, x - 1, y, z, 4)) return true;
  if (m === 2 && provides(g, x + 1, y, z, 5)) return true;
  return false;
}
/** bg.a(cn,x,y,z,boolean): remember a toggle; 8 toggles of the same torch within 100 ticks = burnt out. */
function burnedOut(g, x, y, z, add) {
  if (add) { g.rsBurn.push([x, y, z, g.time]); if (g.rsBurn.length > BURN_MAX) g.rsBurn.shift(); }
  let n = 0;
  for (const r of g.rsBurn) if (r[0] === x && r[1] === y && r[2] === z && ++n >= 8) return true;
  return false;
}
function torchTick(g, x, y, z, id) {
  const on = torchPowered(g, x, y, z);
  while (g.rsBurn.length && g.time - g.rsBurn[0][3] > 100) g.rsBurn.shift();
  const m = g.meta(x, y, z);
  if (id === TORCH_ON) {
    if (on) {
      setNotify(g, x, y, z, TORCH_OFF, m);
      burnedOut(g, x, y, z, true);          // (the game only plays the fizz sound + smoke when it burns out)
    }
  } else if (!on && !burnedOut(g, x, y, z, false)) setNotify(g, x, y, z, TORCH_ON, m);
}

// ---------------------------------------------------------------- pressure plates (al)
function* entitiesFor(g, wood) {
  for (const p of g.players.values()) yield [p.x, p.y, p.z, 0.3, 1.8];
  for (const m of g.mobs.values()) { const d = MOBS[m.type]; if (d) yield [m.x, m.y, m.z, d.r, d.h]; }
  if (wood) for (const it of g.items.values()) yield [it.x, it.y, it.z, 0.125, 0.25];
}
/** Something inside the plate's trigger box (x+1/8 .. x+7/8, y .. y+1/4, z+1/8 .. z+7/8)? */
function plateOccupied(g, x, y, z, wood) {
  const x0 = x + 0.125, x1 = x + 0.875, y0 = y, y1 = y + 0.25, z0 = z + 0.125, z1 = z + 0.875;
  for (const [ex, ey, ez, r, h] of entitiesFor(g, wood)) {
    if (!Number.isFinite(ex) || !Number.isFinite(ey) || !Number.isFinite(ez)) continue;
    if (ex + r > x0 && ex - r < x1 && ey + h > y0 && ey < y1 && ez + r > z0 && ez - r < z1) return true;
  }
  return false;
}
/** al.h: press / release the plate and keep re-checking every 20 ticks while something is on it. */
function plateCheck(g, x, y, z, id) {
  const was = g.meta(x, y, z) === 1;
  const now = plateOccupied(g, x, y, z, id === PLATE_WOOD);
  if (now && !was) {
    setQuiet(g, x, y, z, id, 1);
    notifyAround(g, x, y, z, id); notifyAround(g, x, y - 1, z, id);
  }
  if (!now && was) {
    setQuiet(g, x, y, z, id, 0);
    notifyAround(g, x, y, z, id); notifyAround(g, x, y - 1, z, id);
  }
  if (now) schedule(g, x, y, z, id, TICK_RATE[id]);
}
/** Entity collision with a plate (al.b(cn,x,y,z,kh) runs when an entity touches a released plate). */
function plateCollisions(g) {
  const touch = (ex, ey, ez, r, living) => {
    if (!Number.isFinite(ex) || !Number.isFinite(ey) || !Number.isFinite(ez)) return;
    const by = Math.floor(ey);
    if (by < 0 || by > 127) return;
    for (let bx = Math.floor(ex - r); bx <= Math.floor(ex + r); bx++)
      for (let bz = Math.floor(ez - r); bz <= Math.floor(ez + r); bz++) {
        if (!loaded(g, bx, bz)) continue;
        const id = g.block(bx, by, bz);
        if ((id === PLATE_WOOD || (id === PLATE_STONE && living)) && g.meta(bx, by, bz) !== 1) plateCheck(g, bx, by, bz, id);
      }
  };
  for (const p of g.players.values()) touch(p.x, p.y, p.z, 0.3, true);
  for (const m of g.mobs.values()) { const d = MOBS[m.type]; if (d) touch(m.x, m.y, m.z, d.r, true); }
  for (const it of g.items.values()) touch(it.x, it.y, it.z, 0.125, false);
}

// ---------------------------------------------------------------- feature hooks
function ensure(g) {
  if (!g.rsQ) g.rsQ = new Map();
  if (!g.rsBurn) g.rsBurn = [];
  if (g.rsDepth === undefined) { g.rsDepth = 0; g.rsOps = 0; g.rsNoWire = false; g.rsSkip = null; }
}

export default {
  name: "redstone",

  onSetBlock(g, x, y, z, id, meta, oldId) {
    ensure(g);
    if (g.rsSkip === key(x, y, z)) return;          // our own change: already handled where it was made
    if (oldId === id) return;                       // a meta-only change by someone else (doors, crops...): quiet
    if (RELEVANT.has(oldId)) removed(g, x, y, z, oldId, null);
    if (RELEVANT.has(id)) added(g, x, y, z, id);
    notifyAround(g, x, y, z, id);
  },

  onUse(g, p, { x, y, z }, touched) {
    ensure(g);
    if (y < 0 || y > 127) return false;
    const id = g.block(x, y, z);
    if (id === LEVER) {                             // no.a(cn,x,y,z,dm)
      const m = g.meta(x, y, z), nm = (m & 7) + (8 - (m & 8));
      setQuiet(g, x, y, z, LEVER, nm);
      touched.push([x, y, z]);
      notifyAround(g, x, y, z, LEVER);
      const [a, b, c] = attached(m);
      notifyAround(g, x + a, y + b, z + c, LEVER);
      return true;
    }
    if (id === BUTTON) {                            // hu.a(cn,x,y,z,dm)
      touched.push([x, y, z]);
      const m = g.meta(x, y, z);
      if (m & 8) return true;
      setQuiet(g, x, y, z, BUTTON, (m & 7) + 8);
      notifyAround(g, x, y, z, BUTTON);
      const [a, b, c] = attached(m);
      notifyAround(g, x + a, y + b, z + c, BUTTON);
      schedule(g, x, y, z, BUTTON, TICK_RATE[BUTTON]);
      return true;
    }
    return false;
  },

  tick(g) {
    ensure(g);
    g.rsOps = 0; g.rsDepth = 0;
    if (g.rsQ.size) {
      const due = [];
      for (const [k, t] of g.rsQ) if (t <= g.time) due.push([t, k]);
      if (due.length) {
        due.sort((a, b) => a[0] - b[0]);            // stable: same tick keeps the scheduling order
        let n = 0;
        for (const [, k] of due) {
          if (n++ >= MAX_SCHEDULED) break;
          g.rsQ.delete(k);
          const parts = k.split(",");
          const x = +parts[0], y = +parts[1], z = +parts[2], tag = parts[3];
          if (!loaded(g, x, z)) continue;
          if (tag[0] === "n") neighbor(g, x, y, z, +tag.slice(1));        // a deferred neighbour update
          else if (g.block(x, y, z) === +tag) updateTick(g, x, y, z, +tag);
        }
      }
    }
    plateCollisions(g);
  },

  save(g) {
    ensure(g);
    return { q: [...g.rsQ], b: g.rsBurn };
  },
  load(g, state) {
    g.rsQ = new Map(Array.isArray(state?.q) ? state.q : []);
    g.rsBurn = Array.isArray(state?.b) ? state.b : [];
    g.rsDepth = 0; g.rsOps = 0; g.rsNoWire = false; g.rsSkip = null;
  },
};
