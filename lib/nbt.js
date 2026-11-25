import { inflate } from "pako";

// Just enough NBT to read the "Items" of a chest / furnace (the game sends tile entities as gzipped NBT).
const dec = new TextDecoder();

export function parseNbt(gz) {
  const u = inflate(gz);                       // pako.inflate auto-detects gzip
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let p = 0;
  const str = () => { const n = dv.getUint16(p); p += 2; const s = dec.decode(u.subarray(p, p + n)); p += n; return s; };
  const payload = (t) => {
    switch (t) {
      case 1: return dv.getInt8(p++);
      case 2: { const v = dv.getInt16(p); p += 2; return v; }
      case 3: { const v = dv.getInt32(p); p += 4; return v; }
      case 4: { const v = Number(dv.getBigInt64(p)); p += 8; return v; }
      case 5: { const v = dv.getFloat32(p); p += 4; return v; }
      case 6: { const v = dv.getFloat64(p); p += 8; return v; }
      case 7: { const n = dv.getInt32(p); p += 4 + n; return null; }
      case 8: return str();
      case 9: { const et = dv.getInt8(p++), n = dv.getInt32(p); p += 4; const a = []; for (let i = 0; i < n; i++) a.push(payload(et)); return a; }
      case 10: { const o = {}; for (;;) { const t2 = dv.getInt8(p++); if (t2 === 0) return o; const k = str(); o[k] = payload(t2); } }
      default: throw new Error("bad nbt tag " + t);
    }
  };
  const t = dv.getInt8(p++); if (t !== 10) throw new Error("nbt root");
  str();
  return payload(10);
}

/** Items stored in a tile entity: [{slot, id, count, damage}] (empty on anything unreadable). */
export function tileItems(gz) {
  try {
    const items = parseNbt(gz).Items;
    if (!Array.isArray(items)) return [];
    return items.filter((i) => i && i.id > 0 && i.Count > 0).map((i) => ({ slot: i.Slot, id: i.id, count: i.Count, damage: i.Damage || 0 }));
  } catch { return []; }
}
