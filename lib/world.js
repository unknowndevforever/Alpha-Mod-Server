import { deflate } from "pako";

// Chunk layout is the same as the game's: 16x128x16, index = x << 11 | z << 7 | y, meta = 4 bits per block.
export const SEA = 64;
const OPAQUE_NOT = new Set([0, 6, 8, 9, 10, 11, 18, 20, 27, 28, 37, 38, 39, 40, 50, 51, 55, 59, 63, 64, 65, 66, 68, 69, 70, 71, 72, 75, 76, 77, 78, 79, 83, 85, 90]);
export const SOLID_NOT = new Set([0, 6, 8, 9, 10, 11, 27, 28, 37, 38, 39, 40, 50, 51, 55, 59, 63, 65, 66, 68, 69, 70, 72, 75, 76, 77, 78, 83, 90]);

function hash(seed, x, z, salt = 0) {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(salt, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function smooth(t) { return t * t * (3 - 2 * t); }
function noise(seed, x, z, salt) {
  const x0 = Math.floor(x), z0 = Math.floor(z), fx = smooth(x - x0), fz = smooth(z - z0);
  const a = hash(seed, x0, z0, salt), b = hash(seed, x0 + 1, z0, salt);
  const c = hash(seed, x0, z0 + 1, salt), d = hash(seed, x0 + 1, z0 + 1, salt);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fz;
}
function fbm(seed, x, z, salt, oct) {
  let v = 0, amp = 1, sum = 0, f = 1;
  for (let i = 0; i < oct; i++) { v += noise(seed, x * f, z * f, salt + i) * amp; sum += amp; amp *= 0.5; f *= 2; }
  return v / sum;
}

export class Chunk {
  constructor(cx, cz, blocks, meta) {
    this.cx = cx; this.cz = cz;
    this.blocks = blocks || new Uint8Array(32768);
    this.meta = meta || new Uint8Array(16384);
    this.dirty = false;      // needs saving
    this.packet = null;      // cached compressed map chunk
    this.tiles = new Map();  // "x,y,z" (world coords) -> gzipped NBT the game sent for a chest / furnace / sign
  }
  get(x, y, z) { return this.blocks[(x << 11) | (z << 7) | y]; }
  getMeta(x, y, z) {
    const i = (x << 11) | (z << 7) | y, b = this.meta[i >> 1];
    return i & 1 ? b >> 4 : b & 15;
  }
  set(x, y, z, id, meta = 0) {
    const i = (x << 11) | (z << 7) | y;
    this.blocks[i] = id;
    const j = i >> 1;
    this.meta[j] = i & 1 ? (this.meta[j] & 0x0f) | (meta << 4) : (this.meta[j] & 0xf0) | (meta & 15);
    this.dirty = true;
    this.packet = null;
  }
  /** Compressed blocks + meta + block light + sky light, as packet 0x33 wants it. */
  compressed() {
    if (this.packet) return this.packet;
    const data = new Uint8Array(32768 * 5 / 2);
    data.set(this.blocks, 0);
    data.set(this.meta, 32768);
    const block = data.subarray(32768 + 16384, 32768 + 16384 * 2);
    const sky = data.subarray(32768 + 16384 * 2);
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      let light = 15;
      for (let y = 127; y >= 0; y--) {
        const i = (x << 11) | (z << 7) | y, id = this.blocks[i];
        if (!OPAQUE_NOT.has(id)) light = 0;
        else if (id === 18 || id === 8 || id === 9 || id === 79) light = Math.max(0, light - (id === 18 ? 1 : 3));
        const bl = id === 50 || id === 10 || id === 11 || id === 51 || id === 91 || id === 89 ? 15 : id === 76 ? 7 : 0;
        if (i & 1) { sky[i >> 1] |= light << 4; block[i >> 1] |= bl << 4; } else { sky[i >> 1] |= light; block[i >> 1] |= bl; }
      }
    }
    this.packet = deflate(data);
    return this.packet;
  }
}

export function generate(seed, cx, cz) {
  const c = new Chunk(cx, cz);
  const heights = new Int32Array(256);
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    const wx = cx * 16 + x, wz = cz * 16 + z;
    const hills = fbm(seed, wx / 96, wz / 96, 10, 4);
    const rough = fbm(seed, wx / 24, wz / 24, 20, 3);
    const mountains = Math.max(0, fbm(seed, wx / 200, wz / 200, 30, 2) - 0.55) * 120;
    const h = Math.max(4, Math.min(120, Math.floor(SEA - 8 + hills * 22 + rough * 6 + mountains)));
    heights[x * 16 + z] = h;
    const beach = h >= SEA - 2 && h <= SEA;
    for (let y = 0; y <= Math.max(h, SEA - 1); y++) {
      let id;
      if (y === 0 || (y < 3 && hash(seed, wx, wz, 100 + y) < 0.5)) id = 7;
      else if (y > h) id = 9;                                   // still water up to sea level
      else if (y < h - 3) id = ore(seed, wx, y, wz);
      else if (y < h) id = beach || h < SEA - 1 ? 12 : 3;
      else id = beach || h < SEA ? 12 : 2;
      c.set(x, y, z, id);
    }
  }
  // trees and flowers, kept away from the chunk edges so they never need a neighbour chunk
  for (let x = 2; x < 14; x++) for (let z = 2; z < 14; z++) {
    const wx = cx * 16 + x, wz = cz * 16 + z, h = heights[x * 16 + z];
    if (c.get(x, h, z) !== 2) continue;
    const forest = fbm(seed, wx / 64, wz / 64, 40, 2);
    const r = hash(seed, wx, wz, 50);
    if (r < 0.012 + Math.max(0, forest - 0.5) * 0.12 && h < 118) tree(c, x, h + 1, z, 4 + Math.floor(hash(seed, wx, wz, 51) * 3));
    else if (r > 0.985) c.set(x, h + 1, z, r > 0.993 ? 38 : 37);
  }
  c.dirty = false;
  return c;
}

function ore(seed, x, y, z) {
  const r = hash(seed, x * 31 + y, z, 200 + y);
  if (y < 16 && r < 0.0012) return 56;          // diamond
  if (y < 16 && r < 0.008) return 73;           // redstone
  if (y < 32 && r < 0.012) return 14;           // gold
  if (y < 64 && r < 0.03) return 15;            // iron
  if (r < 0.05) return 16;                      // coal
  if (r > 0.985) return 13;                     // gravel pocket
  return 1;
}

function tree(c, x, y, z, h) {
  for (let ly = y + h - 3; ly <= y + h; ly++) {
    const rad = ly >= y + h - 1 ? 1 : 2;
    for (let dx = -rad; dx <= rad; dx++) for (let dz = -rad; dz <= rad; dz++) {
      if (Math.abs(dx) === rad && Math.abs(dz) === rad && (ly === y + h || ((x + dx + z + dz + ly) & 1))) continue;
      if (c.get(x + dx, ly, z + dz) === 0) c.set(x + dx, ly, z + dz, 18);
    }
  }
  for (let i = 0; i < h; i++) c.set(x, y + i, z, 17);
  c.set(x, y - 1, z, 3);
}

/** Chunk <-> bytes for saving: blocks (32768) + meta (16384) + tile entities [int x, int y, int z, ushort len, bytes]... */
export function encodeChunk(c) {
  let n = 32768 + 16384;
  const tiles = [...c.tiles];
  for (const [, d] of tiles) n += 14 + d.length;
  const out = new Uint8Array(n), dv = new DataView(out.buffer);
  out.set(c.blocks, 0); out.set(c.meta, 32768);
  let p = 32768 + 16384;
  for (const [k, d] of tiles) {
    const [x, y, z] = k.split(",").map(Number);
    dv.setInt32(p, x); dv.setInt32(p + 4, y); dv.setInt32(p + 8, z); dv.setUint16(p + 12, d.length);
    out.set(d, p + 14); p += 14 + d.length;
  }
  return out;
}
export function decodeChunk(cx, cz, u) {
  if (u.length < 32768 + 16384) return null;
  const c = new Chunk(cx, cz, u.slice(0, 32768), u.slice(32768, 32768 + 16384));
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let p = 32768 + 16384;
  while (p + 14 <= u.length) {
    const x = dv.getInt32(p), y = dv.getInt32(p + 4), z = dv.getInt32(p + 8), len = dv.getUint16(p + 12);
    if (p + 14 + len > u.length) break;
    c.tiles.set(`${x},${y},${z}`, u.slice(p + 14, p + 14 + len));
    p += 14 + len;
  }
  return c;
}
