// Block rules shared by the game logic. Orientation rules below were read out of the real a1.1.2 client
// bytecode (ItemDoor, BlockStairs, BlockFurnace, BlockStep) so the server places exactly what the client placed.

// what a broken block drops: id -> [item, count] (missing = drops itself, null = nothing)
export const DROPS = {
  1: [4, 1], 2: [3, 1], 7: null, 8: null, 9: null, 10: null, 11: null, 16: [263, 1], 20: null, 47: null, 51: null, 52: null,
  55: [331, 1], 56: [264, 1], 59: [295, 1], 60: [3, 1], 62: [61, 1], 63: [323, 1], 68: [323, 1], 64: [324, 1], 71: [330, 1],
  73: [331, 4], 74: [331, 4], 75: [76, 1], 78: null, 79: null, 80: [332, 4], 82: [337, 4], 83: [338, 1], 43: [44, 2], 28: [27, 1],
  90: null,
};
// blocks that pop off when the block under them goes away
export const NEEDS_FLOOR = new Set([6, 37, 38, 39, 40, 55, 59, 63, 64, 66, 70, 71, 72, 78, 81, 83, 27, 28]);
export const REPLACEABLE = new Set([0, 8, 9, 10, 11, 78, 51]);
export const TORCH_META = { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1 };
export const FACE = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
export const GRAVITY = new Set([12, 13]);                 // sand, gravel
export const FALL_THROUGH = new Set([0, 8, 9, 10, 11, 51]);

// full cubes: they block a player's head/feet (used to detect "stuck inside blocks")
export const FULL = new Set([1, 2, 3, 4, 5, 7, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 35, 41, 42, 43, 45, 46, 47, 48, 49,
  56, 57, 58, 61, 62, 73, 74, 79, 80, 82, 84, 86, 91]);
// opaque cubes (the game's "isOpaqueCube"): glass, leaves and ice are not
export const OPAQUE = new Set([...FULL].filter((i) => i !== 18 && i !== 20 && i !== 79));

export const isStairs = (id) => id === 53 || id === 67;

/** Stairs: BlockStairs.h(), turns towards stairs above / solid walls / stairs below. Returns meta or -1 (unchanged). */
export function stairMeta(blockAt, solid, x, y, z) {
  const st = (dx, dy, dz) => isStairs(blockAt(x + dx, y + dy, z + dz));
  const so = (dx, dz) => solid(blockAt(x + dx, y, z + dz));
  let m = -1;
  if (st(1, 1, 0)) m = 0;
  if (st(-1, 1, 0)) m = 1;
  if (st(0, 1, 1)) m = 2;
  if (st(0, 1, -1)) m = 3;
  if (m < 0) {
    if (so(1, 0) && !so(-1, 0)) m = 0;
    if (so(-1, 0) && !so(1, 0)) m = 1;
    if (so(0, 1) && !so(0, -1)) m = 2;
    if (so(0, -1) && !so(0, 1)) m = 3;
  }
  if (m < 0) {
    if (st(-1, -1, 0)) m = 0;
    if (st(1, -1, 0)) m = 1;
    if (st(0, -1, -1)) m = 2;
    if (st(0, -1, 1)) m = 3;
  }
  return m;
}

/** Furnace: faces away from opaque neighbours (BlockFurnace.h). */
export function furnaceMeta(blockAt, x, y, z) {
  const o = (dx, dz) => OPAQUE.has(blockAt(x + dx, y, z + dz));
  const n = o(0, -1), s = o(0, 1), w = o(-1, 0), e = o(1, 0);
  let m = 3;
  if (n && !s) m = 3;
  if (s && !n) m = 2;
  if (w && !e) m = 5;
  if (e && !w) m = 4;
  return m;
}

/** Door item: meta (with the hinge flip) exactly like ItemDoor.onItemUse. (x,y,z) = lower half position. */
export function doorMeta(blockAt, yaw, doorId, x, y, z) {
  let m = Math.floor(((Math.fround(yaw) + 180) * 4) / 360 - 0.5) & 3;
  let bx = 0, bz = 0;
  if (m === 0) bz = 1;
  if (m === 1) bx = -1;
  if (m === 2) bz = -1;
  if (m === 3) bx = 1;
  const N = (a, b, c) => (FULL.has(blockAt(a, b, c)) ? 1 : 0);
  const behind = N(x - bx, y, z - bz) + N(x - bx, y + 1, z - bz);
  const ahead = N(x + bx, y, z + bz) + N(x + bx, y + 1, z + bz);
  const doorBehind = blockAt(x - bx, y, z - bz) === doorId || blockAt(x - bx, y + 1, z - bz) === doorId;
  const doorAhead = blockAt(x + bx, y, z + bz) === doorId || blockAt(x + bx, y + 1, z + bz) === doorId;
  let flip = false;
  if (doorBehind && !doorAhead) flip = true;
  else if (ahead > behind) flip = true;
  if (flip) m = ((m - 1) & 3) + 4;
  return m;
}
