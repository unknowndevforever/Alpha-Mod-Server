// Minecraft Alpha 1.1.2 (protocol 2) packets, big endian, strings are Java writeUTF.
// The client talks to us through HTTP polls (see app/api/mc/route.js), the bytes are the normal TCP stream.

export class Incomplete extends Error {}
const INCOMPLETE = new Incomplete("incomplete packet");

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Reader {
  constructor(u8) {
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.pos = 0;
  }
  need(n) { if (this.pos + n > this.u8.length) throw INCOMPLETE; }
  byte() { this.need(1); return this.dv.getInt8(this.pos++); }
  ubyte() { this.need(1); return this.u8[this.pos++]; }
  short() { this.need(2); const v = this.dv.getInt16(this.pos); this.pos += 2; return v; }
  int() { this.need(4); const v = this.dv.getInt32(this.pos); this.pos += 4; return v; }
  float() { this.need(4); const v = this.dv.getFloat32(this.pos); this.pos += 4; return v; }
  double() { this.need(8); const v = this.dv.getFloat64(this.pos); this.pos += 8; return v; }
  bool() { return this.ubyte() !== 0; }
  utf() {
    this.need(2);
    const len = this.dv.getUint16(this.pos);
    this.need(2 + len);
    const s = dec.decode(this.u8.subarray(this.pos + 2, this.pos + 2 + len));
    this.pos += 2 + len;
    return s;
  }
  skip(n) { this.need(n); this.pos += n; }
}

export class Writer {
  constructor(size = 64) { this.buf = new Uint8Array(size); this.dv = new DataView(this.buf.buffer); this.pos = 0; }
  room(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const b = new Uint8Array(size); b.set(this.buf.subarray(0, this.pos));
    this.buf = b; this.dv = new DataView(b.buffer);
  }
  byte(v) { this.room(1); this.dv.setInt8(this.pos++, ((v << 24) >> 24)); return this; }
  short(v) { this.room(2); this.dv.setInt16(this.pos, ((v << 16) >> 16)); this.pos += 2; return this; }
  int(v) { this.room(4); this.dv.setInt32(this.pos, v | 0); this.pos += 4; return this; }
  long(v) { this.room(8); this.dv.setBigInt64(this.pos, BigInt(Math.floor(v))); this.pos += 8; return this; }
  float(v) { this.room(4); this.dv.setFloat32(this.pos, v); this.pos += 4; return this; }
  double(v) { this.room(8); this.dv.setFloat64(this.pos, v); this.pos += 8; return this; }
  bool(v) { return this.byte(v ? 1 : 0); }
  utf(s) {
    const b = enc.encode(String(s).replace(/\0/g, ""));
    const n = Math.min(b.length, 65535);
    this.short(n); this.bytes(b.subarray(0, n)); return this;
  }
  bytes(b) { this.room(b.length); this.buf.set(b, this.pos); this.pos += b.length; return this; }
  done() { return this.buf.slice(0, this.pos); }
}

const pkt = (id) => new Writer().byte(id);

// ---- server -> client ----
export const S = {
  keepAlive: () => pkt(0x00).done(),
  login: (eid) => pkt(0x01).int(eid).utf("").utf("").done(),
  handshake: (hash) => pkt(0x02).utf(hash).done(),
  chat: (msg) => pkt(0x03).utf(msg.slice(0, 119)).done(),
  time: (t) => pkt(0x04).long(t).done(),
  inventory: (type, items) => {
    const w = pkt(0x05).int(type).short(items.length);
    for (const it of items) {
      if (!it) w.short(-1);
      else w.short(it.id).byte(it.count).short(it.damage);
    }
    return w.done();
  },
  spawnPos: (x, y, z) => pkt(0x06).int(x).int(y).int(z).done(),
  // y = eye height, stance = feet (the client swaps them back)
  posLook: (x, y, stance, z, yaw, pitch) => pkt(0x0d).double(x).double(y).double(stance).double(z).float(yaw).float(pitch).bool(false).done(),
  heldItem: (eid, item) => pkt(0x10).int(eid).short(item).done(),
  addToInventory: (id, count, damage) => pkt(0x11).short(id).byte(count).short(damage).done(),
  animation: (eid, anim) => pkt(0x12).int(eid).byte(anim).done(),
  namedEntity: (eid, name, x, y, z, yaw, pitch, item) =>
    pkt(0x14).int(eid).utf(name).int(fix(x)).int(fix(y)).int(fix(z)).byte(angle(yaw)).byte(angle(pitch)).short(item).done(),
  pickupSpawn: (eid, id, count, x, y, z, vx, vy, vz) =>
    pkt(0x15).int(eid).short(id).byte(count).int(fix(x)).int(fix(y)).int(fix(z)).byte(vel(vx)).byte(vel(vy)).byte(vel(vz)).done(),
  collect: (item, collector) => pkt(0x16).int(item).int(collector).done(),
  destroyEntity: (eid) => pkt(0x1d).int(eid).done(),
  teleport: (eid, x, y, z, yaw, pitch) => pkt(0x22).int(eid).int(fix(x)).int(fix(y)).int(fix(z)).byte(angle(yaw)).byte(angle(pitch)).done(),
  preChunk: (cx, cz, load) => pkt(0x32).int(cx).int(cz).bool(load).done(),
  mapChunk: (x, y, z, sx, sy, sz, compressed) =>
    pkt(0x33).int(x).short(y).int(z).byte(sx - 1).byte(sy - 1).byte(sz - 1).int(compressed.length).bytes(compressed).done(),
  tile: (x, y, z, data) => pkt(0x3b).int(x).short(y).int(z).short(data.length).bytes(data).done(),
  blockChange: (x, y, z, type, meta) => pkt(0x35).int(x).byte(y).int(z).byte(type).byte(meta).done(),
  kick: (reason) => pkt(0xff).utf(reason).done(),
};

function fix(v) { return Math.floor(v * 32); }
function angle(deg) { return Math.floor((deg * 256) / 360) & 255; }
function vel(v) { return Math.max(-128, Math.min(127, Math.round(v * 128))); }

// ---- client -> server: returns {id, ...fields} or throws Incomplete ----
export function readPacket(r) {
  const id = r.ubyte();
  switch (id) {
    case 0x00: return { id };
    case 0x01: return { id, protocol: r.int(), name: r.utf(), password: r.utf() };
    case 0x02: return { id, name: r.utf() };
    case 0x03: return { id, message: r.utf() };
    case 0x05: {
      const type = r.int(), n = r.short(), items = [];
      for (let i = 0; i < n; i++) {
        const itemId = r.short();
        if (itemId < 0) { items.push(null); continue; }
        items.push({ id: itemId, count: r.byte(), damage: r.short() });
      }
      return { id, type, items };
    }
    case 0x0a: return { id, onGround: r.bool() };
    case 0x0b: return { id, x: r.double(), y: r.double(), stance: r.double(), z: r.double(), onGround: r.bool() };
    case 0x0c: return { id, yaw: r.float(), pitch: r.float(), onGround: r.bool() };
    case 0x0d: return { id, x: r.double(), y: r.double(), stance: r.double(), z: r.double(), yaw: r.float(), pitch: r.float(), onGround: r.bool() };
    case 0x0e: return { id, status: r.ubyte(), x: r.int(), y: r.ubyte(), z: r.int(), face: r.ubyte() };
    case 0x0f: return { id, item: r.short(), x: r.int(), y: r.ubyte(), z: r.int(), face: r.ubyte() };
    case 0x10: return { id, eid: r.int(), item: r.short() };
    case 0x12: return { id, eid: r.int(), anim: r.byte() };
    case 0x15: return {
      id, eid: r.int(), item: r.short(), count: r.byte(),
      x: r.int() / 32, y: r.int() / 32, z: r.int() / 32, vx: r.byte() / 128, vy: r.byte() / 128, vz: r.byte() / 128,
    };
    case 0x3b: { const x = r.int(), y = r.short(), z = r.int(), n = r.short() & 0xffff; const s = r.pos; r.skip(n); return { id, x, y, z, data: r.u8.slice(s, s + n) }; }
    case 0xff: return { id, reason: r.utf() };
    default: return { id, unknown: true };
  }
}
