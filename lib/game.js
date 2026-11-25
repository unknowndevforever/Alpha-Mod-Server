import { Reader, Incomplete, S, readPacket } from "./protocol.js";
import { Chunk, generate, encodeChunk, decodeChunk, SEA, SOLID_NOT } from "./world.js";
import { tileItems } from "./nbt.js";
import { dbConfigured, openDb } from "./db.js";
import { DROPS, NEEDS_FLOOR, REPLACEABLE, TORCH_META, FACE, GRAVITY, FALL_THROUGH, FULL, stairMeta, furnaceMeta, doorMeta } from "./blocks.js";

const VIEW = 5;                  // chunk radius sent around each player
const TICK_MS = 50;
const TIMEOUT_MS = 30000;        // no poll for this long = disconnected
const MAX_POLL_BYTES = 512 * 1024;
const MAX_PLAYERS = Number(globalThis.process?.env?.MAX_PLAYERS || 20);

const concat = (parts) => {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const randomId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
const key = (cx, cz) => `${cx},${cz}`;
const REACH2 = 11 * 11;           // squared reach (a little over vanilla, to forgive lag)
const LIQUID = new Set([8, 9, 10, 11]);
const TILE_BLOCKS = new Set([54, 61, 62, 63, 68]);   // chest, furnace (off/on), sign post, wall sign
const CONTAINERS = new Set([54, 61, 62]);
const MAX_TILE = 16 * 1024;
const yawDir = (yaw) => Math.floor((yaw * 4) / 360 + 0.5) & 3;   // 0 south, 1 west, 2 north, 3 east

class Session {
  constructor(sid) {
    this.sid = sid;
    this.inBuf = new Uint8Array(0);
    this.out = []; this.outBytes = 0;
    this.lastSeen = Date.now();
    this.state = "handshake";
    this.player = null;
    this.closing = false;      // flush what's queued (a kick), then end
    this.closed = false;
  }
  send(bytes) { if (this.closed) return; this.out.push(bytes); this.outBytes += bytes.length; }
}

class Player {
  constructor(eid, name, session) {
    this.eid = eid; this.name = name; this.session = session;
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0; this.pitch = 0;
    this.held = 0; this.moved = false;
    this.inv = { main: null, craft: null, armor: null };
    this.loaded = new Set();
  }
  send(b) { this.session.send(b); }
}

const b64 = (u8) => Buffer.from(u8).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const LOCK = 727274;
const CHUNK_ROW = /^chunk\/(-?\d+)\/(-?\d+)$/;

export class Game {
  constructor() {
    this.sessions = new Map();
    this.players = new Map();        // name -> Player (online)
    this.chunks = new Map();
    this.items = new Map();          // eid -> dropped item
    this.skins = new Map();
    this.saved = {};                 // name -> saved player data
    this.nextEid = 1000;
    this.time = 0;
    this.seed = 0;
    this.spawn = [0, SEA + 1, 0];
    this.lastTick = Date.now();
    this.lastSave = Date.now();
    this.fs = null;
    this.db = null;                  // PostgreSQL: when present ALL state is shared through it (see run)
    this.pending = []; this.cycling = false;
    this.ver = -1; this.verSaved = -1; this.logSeq = -1;   // what this instance last saw in the database
    this.savedDirty = false; this.extraKv = new Map(); this.lastPrune = 0; this.lastRemember = 0;
    this.dir = globalThis.process?.env?.WORLD_DIR || "world-data";
    this.ready = this.init();
  }

  // ---------- persistence ----------
  async init() {
    if (dbConfigured()) {
      try { this.db = await openDb(); console.log("recreatecraft: using the shared database"); return; }
      catch (e) { this.db = null; console.log("recreatecraft: database unavailable, falling back:", e.message); }
    }
    try {
      this.fs = await import("node:fs");
      this.fs.mkdirSync(`${this.dir}/chunks`, { recursive: true });
      this.fs.mkdirSync(`${this.dir}/skins`, { recursive: true });
    } catch (e) { this.fs = null; console.log("recreatecraft: no writable disk, world is kept in memory only"); }
    const level = this.readJson("level.json");
    const envSeed = globalThis.process?.env?.SEED;
    this.seed = level?.seed ?? (envSeed ? hashString(envSeed) : (Math.random() * 2 ** 31) | 0);
    this.time = level?.time ?? 0;
    this.saved = this.readJson("players.json") || {};
    this.spawn = this.findSpawn();
    console.log(`recreatecraft server ready, seed ${this.seed}, spawn ${this.spawn.join(" ")}`);
  }
  readJson(name) {
    try { return this.fs ? JSON.parse(this.fs.readFileSync(`${this.dir}/${name}`, "utf8")) : null; } catch { return null; }
  }
  save() {
    if (this.db) return;                          // shared mode saves at the end of every batch
    for (const p of this.players.values()) this.remember(p);
    if (!this.fs) return;
    try {
      this.fs.writeFileSync(`${this.dir}/level.json`, JSON.stringify({ seed: this.seed, time: this.time }));
      this.fs.writeFileSync(`${this.dir}/players.json`, JSON.stringify(this.saved));
      for (const c of this.chunks.values()) {
        if (!c.dirty) continue;
        this.fs.writeFileSync(`${this.dir}/chunks/c.${c.cx}.${c.cz}.bin`, encodeChunk(c));
        c.dirty = false;
      }
    } catch (e) { console.log("save failed:", e.message); }
  }
  remember(p) {
    this.saved[p.name] = { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, inv: p.inv };
    this.savedDirty = true;
  }

  // ---------- shared mode (database) ----------
  // Every request is a closure that runs inside a batch: one transaction holding a global advisory lock. The batch
  // loads whatever changed in the database since this instance last looked, runs all the queued closures against
  // the in-memory game (so game logic is unchanged), and writes the result back before releasing the lock.
  // Result: any number of instances behave like one server, and a client's polls may land on any of them.
  /** Run fn with the up-to-date game state. Without a database it just runs fn. */
  async run(fn, readonly = false) {
    await this.ready;
    if (!this.db) return fn();
    return new Promise((resolve, reject) => {
      this.pending.push({ fn, resolve, reject, readonly });
      if (!this.cycling) { this.cycling = true; this.loop(); }
    });
  }
  async loop() {
    try {
      while (this.pending.length) {
        const batch = this.pending.splice(0);
        try { await this.cycle(batch); }
        catch (e) {
          console.log("shared batch failed:", e.message);
          this.ver = -1; this.verSaved = -1; this.logSeq = -1;            // forget the cache, reload next time
          for (const b of batch) b.reject(e);
        }
      }
    } finally { this.cycling = false; }
  }
  async cycle(batch) {
    const client = await this.db.pool.connect();
    let broken = false;
    try {
      const cold = this.logSeq < 0;
      const res = await client.query(
        `begin; select pg_advisory_xact_lock(${LOCK});` +
        `select id, ver, pruned, case when (id = 1 and ver <> ${this.ver}) or (id = 2 and ver <> ${this.verSaved}) then v end as v from rc_hot where id in (1, 2) order by id;` +
        `select coalesce(max(seq), 0) as m from rc_log;` +
        (cold ? "" : `select distinct k from rc_log where seq > ${this.logSeq};`));
      const [, , hotRes, maxRes, logRes] = res;
      const hot = hotRes.rows[0], sav = hotRes.rows[1], maxSeq = Number(maxRes.rows[0].m);
      let level = null;
      if (cold || Number(hot.pruned) > this.logSeq) {                          // first run, or we missed pruned log rows
        this.chunks.clear();
        const all = await client.query("select k, v from rc_kv where k like 'chunk/%' or k = 'level.json'");
        for (const row of all.rows) {
          const m = CHUNK_ROW.exec(row.k);
          if (m) this.loadChunkRow(+m[1], +m[2], row.v);
          else level = parseJson(row.v);
        }
        this.logSeq = maxSeq;
      } else if (logRes.rows.length) {
        const keys = logRes.rows.map((r) => r.k);
        const rows = await client.query("select k, v from rc_kv where k = any($1)", [keys]);
        for (const row of rows.rows) { const m = CHUNK_ROW.exec(row.k); if (m) this.loadChunkRow(+m[1], +m[2], row.v); }
        this.logSeq = maxSeq;
      }
      if (!this.worldReady) this.setupWorld(level);
      if (sav.v != null) { this.saved = parseJson(sav.v) || {}; }
      else if (sav.v === null && this.verSaved < 0) {                          // first start: import the old players.json if any
        const old = await client.query("select v from rc_kv where k = 'players.json'");
        this.saved = old.rows.length ? parseJson(old.rows[0].v) || {} : {};
        if (old.rows.length) this.savedDirty = true;
      }
      this.verSaved = Number(sav.ver);
      if (hot.v != null) this.hydrate(JSON.parse(hot.v));
      else if (this.ver < 0) this.hydrate(null);
      this.ver = Number(hot.ver);

      // run every queued request, in order
      let mutated = false;
      const results = batch.map((b) => {
        try { const v = b.fn(); if (!b.readonly) mutated = true; return { ok: true, v }; } catch (e) { return { ok: false, e }; }
      });

      // write back
      const now = Date.now();
      if (mutated && now - this.lastRemember > 15000) { this.lastRemember = now; for (const p of this.players.values()) this.remember(p); }
      if (mutated) {
        const dirty = [...this.chunks.values()].filter((c) => c.dirty);
        for (const c of dirty) await client.query("insert into rc_kv (k, v) values ($1, $2) on conflict (k) do update set v = excluded.v", [`chunk/${c.cx}/${c.cz}`, Buffer.from(encodeChunk(c))]);
        for (const [k, v] of this.extraKv) await client.query("insert into rc_kv (k, v) values ($1, $2) on conflict (k) do update set v = excluded.v", [k, Buffer.from(v)]);
        if (dirty.length) {
          const r = await client.query("insert into rc_log (k) select unnest($1::text[]) returning seq", [dirty.map((c) => `chunk/${c.cx}/${c.cz}`)]);
          this.logSeq = Math.max(this.logSeq, ...r.rows.map((x) => Number(x.seq)));
        }
        await client.query("update rc_hot set ver = ver + 1, v = $1 where id = 1", [JSON.stringify(this.serialize())]);
        if (this.savedDirty) await client.query("update rc_hot set ver = ver + 1, v = $1 where id = 2", [JSON.stringify(this.saved)]);
        if (now - this.lastPrune > 300000) {
          this.lastPrune = now;
          await client.query("with d as (delete from rc_log where ts < now() - interval '1 hour' returning seq) update rc_hot set pruned = greatest(pruned, coalesce((select max(seq) from d), 0)) where id = 1");
        }
      }
      await client.query("commit");
      if (mutated) {
        for (const c of this.chunks.values()) c.dirty = false;
        this.extraKv.clear();
        this.ver += 1;
        if (this.savedDirty) { this.verSaved += 1; this.savedDirty = false; }
      } else { for (const c of this.chunks.values()) c.dirty = false; }
      batch.forEach((b, i) => (results[i].ok ? b.resolve(results[i].v) : b.reject(results[i].e)));
    } catch (e) {
      broken = true;
      await client.query("rollback").catch(() => {});
      throw e;
    } finally { client.release(broken ? true : undefined); }
  }
  loadChunkRow(cx, cz, v) {
    const c = decodeChunk(cx, cz, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    if (c) this.chunks.set(key(cx, cz), c);
  }
  /** Seed and spawn are decided once, by whichever instance gets there first, and then shared. */
  setupWorld(level) {
    if (level && Number.isFinite(level.seed) && level.spawn) {
      this.seed = level.seed; this.spawn = level.spawn; this.worldReady = true; return;
    }
    const envSeed = globalThis.process?.env?.SEED;
    this.seed = level?.seed ?? (envSeed ? hashString(envSeed) : (Math.random() * 2 ** 31) | 0);
    this.spawn = this.findSpawn();
    this.worldReady = true;
    this.extraKv.set("level.json", new TextEncoder().encode(JSON.stringify({ seed: this.seed, spawn: this.spawn })));
    console.log(`recreatecraft world created, seed ${this.seed}, spawn ${this.spawn.join(" ")}`);
  }
  serialize() {
    return {
      time: this.time, nextEid: this.nextEid, lastTick: this.lastTick,
      sessions: [...this.sessions.values()].map((s) => ({
        sid: s.sid, inBuf: b64(s.inBuf), out: s.out.map(b64), lastSeen: s.lastSeen, state: s.state,
        closing: s.closing, closed: s.closed, player: s.player ? s.player.name : null,
      })),
      players: [...this.players.values()].map((p) => ({
        eid: p.eid, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, held: p.held, moved: p.moved,
        inv: p.inv, loaded: [...p.loaded], sid: p.session.sid,
      })),
      items: [...this.items.values()],
    };
  }
  hydrate(h) {
    this.sessions.clear(); this.players.clear(); this.items.clear();
    if (!h) { this.lastTick = Date.now(); return; }
    this.time = h.time; this.nextEid = h.nextEid; this.lastTick = h.lastTick;
    for (const d of h.sessions) {
      const s = new Session(d.sid);
      s.inBuf = unb64(d.inBuf); s.out = d.out.map(unb64); s.outBytes = s.out.reduce((n, b) => n + b.length, 0);
      s.lastSeen = d.lastSeen; s.state = d.state; s.closing = d.closing; s.closed = d.closed;
      this.sessions.set(s.sid, s);
    }
    for (const d of h.players) {
      const s = this.sessions.get(d.sid);
      if (!s) continue;
      const p = new Player(d.eid, d.name, s);
      Object.assign(p, { x: d.x, y: d.y, z: d.z, yaw: d.yaw, pitch: d.pitch, held: d.held, moved: d.moved, inv: d.inv });
      p.loaded = new Set(d.loaded);
      s.player = p;
      this.players.set(p.name, p);
    }
    for (const it of h.items) this.items.set(it.eid, it);
  }

  // ---------- world ----------
  chunk(cx, cz) {
    const k = key(cx, cz);
    let c = this.chunks.get(k);
    if (c) return c;
    if (this.fs) {
      try {
        const b = this.fs.readFileSync(`${this.dir}/chunks/c.${cx}.${cz}.bin`);
        const u = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        c = decodeChunk(cx, cz, u);
      } catch { }
    }
    if (!c) c = generate(this.seed, cx, cz);
    this.chunks.set(k, c);
    return c;
  }
  block(x, y, z) { return y < 0 || y > 127 ? 0 : this.chunk(x >> 4, z >> 4).get(x & 15, y, z & 15); }
  meta(x, y, z) { return y < 0 || y > 127 ? 0 : this.chunk(x >> 4, z >> 4).getMeta(x & 15, y, z & 15); }
  /** Change a block and tell everyone who has that chunk, except `except` (who already did it on their side). */
  setBlock(x, y, z, id, meta = 0, except = null) {
    if (y < 0 || y > 127) return;
    const ch = this.chunk(x >> 4, z >> 4);
    if (ch.tiles.size) {
      const tk = `${x},${y},${z}`;
      if (ch.tiles.has(tk) && !TILE_BLOCKS.has(id)) { ch.tiles.delete(tk); ch.dirty = true; }
    }
    ch.set(x & 15, y, z & 15, id, meta);
    const pk = S.blockChange(x, y, z, id, meta), k = key(x >> 4, z >> 4);
    for (const p of this.players.values()) if (p !== except && p.loaded.has(k)) p.send(pk);
  }
  surface(x, z) {
    for (let y = 127; y > 0; y--) { const id = this.block(x, y, z); if (id !== 0 && !SOLID_NOT.has(id) || id === 9) return [y, id]; }
    return [SEA, 0];
  }
  findSpawn() {
    for (let r = 0; r < 200; r += 4) for (let i = 0; i < 8; i++) {
      const x = Math.round(Math.cos(i * Math.PI / 4) * r), z = Math.round(Math.sin(i * Math.PI / 4) * r);
      const [y, id] = this.surface(x, z);
      if (id !== 9 && id !== 18 && y >= SEA) return [x, y + 1, z];
      if (r === 0) break;
    }
    return [0, SEA + 1, 0];
  }

  // ---------- HTTP side ----------
  open() {
    if (this.sessions.size >= MAX_PLAYERS * 2) return null;
    const s = new Session(randomId());
    this.sessions.set(s.sid, s);
    return s.sid;
  }
  /** One poll: bytes from the client in, queued bytes out. null = no such session (client sees end of stream). */
  poll(sid, bytes) {
    this.tickUntilNow();
    const s = this.sessions.get(sid);
    if (!s || s.closed) return null;
    s.lastSeen = Date.now();
    if (bytes.length) this.receive(s, bytes);
    return this.flush(s);
  }
  close(sid) {
    const s = this.sessions.get(sid);
    if (s) this.drop(s, "left the game");
  }
  flush(s) {
    const parts = []; let n = 0;
    while (s.out.length && (n === 0 || n + s.out[0].length <= MAX_POLL_BYTES)) { const b = s.out.shift(); parts.push(b); n += b.length; }
    s.outBytes -= n;
    if (s.closing && !s.out.length) { s.closed = true; this.sessions.delete(s.sid); }
    return concat(parts);
  }

  receive(s, bytes) {
    let buf = s.inBuf.length ? concat([s.inBuf, bytes]) : bytes;
    const r = new Reader(buf);
    let start = 0;
    try {
      while (r.pos < buf.length && !s.closing) {
        start = r.pos;
        const pk = readPacket(r);
        this.handle(s, pk);
      }
      start = r.pos;
    } catch (e) {
      if (!(e instanceof Incomplete)) { console.log("bad packet:", e); this.kick(s, "Bad packet"); return; }
    }
    s.inBuf = buf.slice(start);
    if (s.inBuf.length > 1 << 20) this.kick(s, "Too much data");
  }

  kick(s, reason) {
    s.send(S.kick(reason));
    this.drop(s, "was kicked: " + reason);
  }
  /** Remove the session's player from the world; the session ends once its queue is flushed. */
  drop(s, why) {
    s.closing = true;
    const p = s.player;
    if (!p) { if (!s.out.length) { s.closed = true; this.sessions.delete(s.sid); } return; }
    s.player = null;
    this.remember(p);
    this.players.delete(p.name);
    this.broadcast(S.destroyEntity(p.eid));
    this.broadcast(S.chat(`${p.name} ${why}`));
    if (!s.out.length) { s.closed = true; this.sessions.delete(s.sid); }
    this.save();
  }
  broadcast(pk, except = null) { for (const p of this.players.values()) if (p !== except) p.send(pk); }

  // ---------- packets ----------
  handle(s, pk) {
    const p = s.player;
    if (pk.unknown) return this.kick(s, `Unknown packet ${pk.id}`);
    if (pk.id === 0x00) return;
    if (pk.id === 0xff) return this.drop(s, "left the game");
    if (s.state === "handshake") {
      if (pk.id !== 0x02) return this.kick(s, "Expected handshake");
      s.state = "login";
      return s.send(S.handshake("-"));          // "-" = no minecraft.net login check
    }
    if (s.state === "login") {
      if (pk.id !== 0x01) return this.kick(s, "Expected login");
      return this.login(s, pk);
    }
    switch (pk.id) {
      case 0x03: return this.chat(p, pk.message);
      case 0x05:
        if (pk.type === -1) p.inv.main = pk.items; else if (pk.type === -2) p.inv.craft = pk.items; else if (pk.type === -3) p.inv.armor = pk.items;
        return;
      case 0x0a: return;
      case 0x3b: return this.tile(p, pk);
      case 0x0b: case 0x0d: case 0x0c: return this.move(p, pk);
      case 0x0e: if (pk.status === 3) this.dig(p, pk.x, pk.y, pk.z); return;
      case 0x0f: return this.place(p, pk);
      case 0x10: p.held = pk.item > 0 ? pk.item : 0; return this.broadcast(S.heldItem(p.eid, p.held), p);
      case 0x12: return this.broadcast(S.animation(p.eid, pk.anim), p);
      case 0x15:
        if (pk.item > 0 && pk.count > 0) this.spawnItem(pk.item, pk.count, pk.x, pk.y, pk.z, pk.vx, pk.vy, pk.vz, 40);
        return;
    }
  }

  login(s, pk) {
    const name = pk.name;
    if (pk.protocol !== 2) return this.kick(s, pk.protocol > 2 ? "Outdated server!" : "Outdated client!");
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return this.kick(s, "Bad username");
    const old = this.players.get(name);
    if (old) this.kick(old.session, "You logged in from another location");
    if (this.players.size >= MAX_PLAYERS) return this.kick(s, "The server is full!");

    const p = new Player(this.nextEid++, name, s);
    const saved = this.saved[name];
    if (saved && Number.isFinite(saved.y)) Object.assign(p, { x: saved.x, y: saved.y, z: saved.z, yaw: saved.yaw, pitch: saved.pitch });
    else { p.x = this.spawn[0] + 0.5; p.y = this.spawn[1]; p.z = this.spawn[2] + 0.5; }
    if (saved?.inv) p.inv = saved.inv;
    this.unstuck(p);
    s.player = p; s.state = "play";

    p.send(S.login(p.eid));
    p.send(S.spawnPos(this.spawn[0], this.spawn[1], this.spawn[2]));
    p.send(S.time(this.time));
    if (p.inv.main) p.send(S.inventory(-1, p.inv.main));
    if (p.inv.craft) p.send(S.inventory(-2, p.inv.craft));
    if (p.inv.armor) p.send(S.inventory(-3, p.inv.armor));
    this.sendChunks(p, 2, 1000);             // the ground under the player first...
    p.send(S.posLook(p.x, p.y + 1.62, p.y, p.z, p.yaw, p.pitch));   // ...then the position closes "Downloading terrain"

    for (const o of this.players.values()) {
      p.send(S.namedEntity(o.eid, o.name, o.x, o.y, o.z, o.yaw, o.pitch, o.held));
      o.send(S.namedEntity(p.eid, p.name, p.x, p.y, p.z, p.yaw, p.pitch, 0));
    }
    for (const it of this.items.values()) p.send(S.pickupSpawn(it.eid, it.id, it.count, it.x, it.y, it.z, 0, 0, 0));
    this.players.set(name, p);
    this.broadcast(S.chat(`${name} joined the game`));
  }

  move(p, pk) {
    if (pk.x !== undefined) {
      if (![pk.x, pk.y, pk.z].every(Number.isFinite) || Math.abs(pk.x) > 3.2e7 || Math.abs(pk.z) > 3.2e7) return;
      p.x = pk.x; p.y = pk.y; p.z = pk.z;
    }
    if (pk.yaw !== undefined) { p.yaw = pk.yaw; p.pitch = pk.pitch; }
    p.moved = true;
  }

  chat(p, msg) {
    msg = msg.trim();
    if (!msg) return;
    if (!msg.startsWith("/")) { console.log(`<${p.name}> ${msg}`); return this.broadcast(S.chat(`<${p.name}> ${msg}`)); }
    const [cmd, ...args] = msg.slice(1).split(/\s+/);
    const say = (m) => p.send(S.chat(m));
    switch (cmd.toLowerCase()) {
      case "help": return say("Commands: /list /spawn /tp <player> /time day|night /me <action>");
      case "list": return say(`Online (${this.players.size}): ${[...this.players.keys()].join(", ")}`);
      case "spawn": return this.teleport(p, this.spawn[0] + 0.5, this.spawn[1], this.spawn[2] + 0.5);
      case "tp": {
        const t = this.players.get(args[0]) || [...this.players.values()].find((o) => o.name.toLowerCase() === (args[0] || "").toLowerCase());
        if (!t) return say("No such player online");
        return this.teleport(p, t.x, t.y, t.z);
      }
      case "time": {
        const day = Math.floor(this.time / 24000) * 24000;
        if (args[0] === "day") this.time = day + 24000;
        else if (args[0] === "night") this.time = day + 13800;
        else return say("Usage: /time day|night");
        return this.broadcast(S.time(this.time));
      }
      case "me": return this.broadcast(S.chat(`* ${p.name} ${args.join(" ")}`));
      default: return say("Unknown command, try /help");
    }
  }
  teleport(p, x, y, z) {
    p.x = x; p.y = y; p.z = z; p.moved = true;
    this.sendChunks(p, 2, 1000);
    this.unstuck(p);
    p.send(S.posLook(p.x, p.y + 1.62, p.y, p.z, p.yaw, p.pitch));
  }

  // ---------- blocks ----------
  // The server is the authority: whatever happens, the acting player is sent the real state of every block the
  // action touched, so a block the client "predicted" but the server refused is corrected instead of lingering
  // until the chunk reloads (that was the "my blocks disappear" bug).
  resync(p, x, y, z) {
    if (y < 0 || y > 127) return;
    if (!p.loaded.has(key(x >> 4, z >> 4))) return;
    p.send(S.blockChange(x, y, z, this.block(x, y, z), this.meta(x, y, z)));
  }
  inReach(p, x, y, z) {
    const dx = x + 0.5 - p.x, dy = y + 0.5 - (p.y + 1.62), dz = z + 0.5 - p.z;
    return dx * dx + dy * dy + dz * dz <= REACH2;
  }
  solidAt(x, y, z) { return FULL.has(this.block(x, y, z)); }

  /** Where a wall-mounted block (torch, ladder, sign, lever, button) is attached: offset to its support block. */
  attachOffset(id, meta) {
    if (id === 50 || id === 75 || id === 76 || id === 69 || id === 77) {
      switch (meta & 7) { case 1: return [-1, 0, 0]; case 2: return [1, 0, 0]; case 3: return [0, 0, -1]; case 4: return [0, 0, 1]; default: return [0, -1, 0]; }
    }
    if (id === 65 || id === 68) {
      switch (meta) { case 2: return [0, 0, 1]; case 3: return [0, 0, -1]; case 4: return [1, 0, 0]; case 5: return [-1, 0, 0]; }
    }
    return null;
  }

  dig(p, x, y, z) {
    const touched = [[x, y, z]];
    this.digInner(p, x, y, z, touched);
    for (const [a, b, c] of touched) this.resync(p, a, b, c);
  }
  digInner(p, x, y, z, touched) {
    if (y < 0 || y > 127) return;
    const id = this.block(x, y, z);
    if (id === 0 || LIQUID.has(id)) return;
    if (id === 7 && y < 5) return;                                // the bedrock floor stays
    if (!this.inReach(p, x, y, z)) return;
    this.pop(x, y, z, true, touched);
  }
  /** Remove a block (and everything that depends on it). `drop` = spawn its item. */
  pop(x, y, z, drop, touched = []) {
    const id = this.block(x, y, z), meta = this.meta(x, y, z);
    if (id === 0) return;
    if (drop && CONTAINERS.has(id)) this.dropContents(x, y, z);
    this.setBlock(x, y, z, 0, 0);
    if (id === 64 || id === 71) {                                 // other door half
      const oy = meta & 8 ? y - 1 : y + 1;
      if (this.block(x, oy, z) === id) { this.setBlock(x, oy, z, 0, 0); touched.push([x, oy, z]); }
    }
    if (drop && (!(id === 64 || id === 71) || !(meta & 8))) this.dropFor(id, x, y, z);
    if (id === 44 || id === 43 || id === 53 || id === 67) { /* nothing extra */ }

    // things standing on top that need a floor (flowers, doors, rails, cactus stacks...)
    for (let ay = y + 1; ay < 128; ay++) {
      const above = this.block(x, ay, z);
      if (!NEEDS_FLOOR.has(above)) break;
      touched.push([x, ay, z]);
      this.pop(x, ay, z, true, touched);
      if (above !== 81 && above !== 83) break;
    }
    // things stuck to the sides (torches, ladders, signs, levers, buttons)
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const nx = x + dx, ny = y + dy, nz = z + dz, nid = this.block(nx, ny, nz);
      const off = this.attachOffset(nid, this.meta(nx, ny, nz));
      if (off && nx + off[0] === x && ny + off[1] === y && nz + off[2] === z) { touched.push([nx, ny, nz]); this.pop(nx, ny, nz, true, touched); }
    }
    // sand and gravel above fall down
    this.settle(x, y + 1, z, touched);
  }
  /** A broken chest / furnace spills what is inside it. */
  dropContents(x, y, z) {
    const data = this.chunk(x >> 4, z >> 4).tiles.get(`${x},${y},${z}`);
    if (!data) return;
    for (const it of tileItems(data)) {
      this.spawnItem(it.id, it.count, x + 0.2 + Math.random() * 0.6, y + 0.3, z + 0.2 + Math.random() * 0.6, (Math.random() - 0.5) * 0.2, 0.2, (Math.random() - 0.5) * 0.2, 10);
    }
  }
  /** The game sends a tile entity (chest/furnace contents, sign text) whenever it changes. Keep it and pass it on. */
  tile(p, pk) {
    const { x, y, z, data } = pk;
    if (y < 0 || y > 127 || data.length === 0 || data.length > MAX_TILE) return;
    if (!TILE_BLOCKS.has(this.block(x, y, z))) return;                 // nothing there that can hold data
    const dx = x + 0.5 - p.x, dz = z + 0.5 - p.z;
    if (dx * dx + dz * dz > 64 * 64) return;                           // far away: ignore
    const ch = this.chunk(x >> 4, z >> 4), k = `${x},${y},${z}`, old = ch.tiles.get(k);
    if (old && old.length === data.length && old.every((b, i) => b === data[i])) return;
    ch.tiles.set(k, data); ch.dirty = true;
    const pkt = S.tile(x, y, z, data), ck = key(x >> 4, z >> 4);
    for (const o of this.players.values()) if (o !== p && o.loaded.has(ck)) o.send(pkt);
  }
  dropFor(id, x, y, z) {
    let d = id in DROPS ? DROPS[id] : [id, 1];
    if (id === 18) d = Math.random() < 0.05 ? [6, 1] : null;      // leaves: sometimes a sapling
    if (id === 13 && Math.random() < 0.1) d = [318, 1];            // gravel: sometimes flint
    if (!d) return;
    this.spawnItem(d[0], d[1], x + 0.5, y + 0.3, z + 0.5, (Math.random() - 0.5) * 0.2, 0.2, (Math.random() - 0.5) * 0.2, 10);
  }
  /** Sand / gravel at (x,y,z) and everything stacked above it drops until it lands. */
  settle(x, y, z, touched = []) {
    for (let cy = y; cy < 128 && GRAVITY.has(this.block(x, cy, z)); cy++) {
      const id = this.block(x, cy, z);
      let ty = cy;
      while (ty > 1 && FALL_THROUGH.has(this.block(x, ty - 1, z))) ty--;
      if (ty === cy) break;
      this.setBlock(x, cy, z, 0, 0);
      this.setBlock(x, ty, z, id, 0);
      touched.push([x, cy, z], [x, ty, z]);
    }
  }

  place(p, pk) {
    const { x, y, z, face } = pk;
    if (face > 5 || y > 127) return;                              // using an item in the air
    const touched = [[x, y, z]];
    if (this.inReach(p, x, y, z)) this.placeInner(p, pk, touched);
    for (const [a, b, c] of touched) this.resync(p, a, b, c);
  }
  placeInner(p, pk, touched) {
    const { x, y, z, face, item } = pk;
    const clicked = this.block(x, y, z);
    // right click on doors / levers works with any item and never places anything
    if (clicked === 64 || clicked === 71) {
      if (clicked === 71) return;                                  // iron doors only open with redstone
      const by = this.meta(x, y, z) & 8 ? y - 1 : y, m = this.meta(x, by, z) ^ 4;
      this.setBlock(x, by, z, clicked, m);
      touched.push([x, by, z], [x, by + 1, z]);
      if (this.block(x, by + 1, z) === clicked) this.setBlock(x, by + 1, z, clicked, m | 8);
      return;
    }
    if (clicked === 69) { this.setBlock(x, y, z, 69, this.meta(x, y, z) ^ 8); return; }
    if ([54, 58, 61, 62, 77, 84].includes(clicked)) return;
    if (item >= 290 && item <= 294) {                              // hoe
      if ((clicked === 2 || clicked === 3) && face !== 0 && this.block(x, y + 1, z) === 0) this.setBlock(x, y, z, 60, 0);
      return;
    }
    if (item <= 0) return;

    let [tx, ty, tz] = [x + FACE[face][0], y + FACE[face][1], z + FACE[face][2]];
    if (clicked === 78) { tx = x; ty = y; tz = z; }                // snow layers get built into, not next to
    if (ty < 0 || ty > 127) return;
    touched.push([tx, ty, tz]);
    const existing = this.block(tx, ty, tz);
    if (!REPLACEABLE.has(existing)) return;
    // don't build inside yourself
    if (FULL.has(item) && Math.abs(tx + 0.5 - p.x) < 0.8 && Math.abs(tz + 0.5 - p.z) < 0.8 && ty >= Math.floor(p.y) && ty <= Math.floor(p.y + 1.7)) return;

    const dir = yawDir(p.yaw);
    let id = item, meta = 0;
    if (item === 324 || item === 330) {                            // doors: two blocks, the client's own hinge rules
      if (face !== 1 || !REPLACEABLE.has(this.block(tx, ty + 1, tz)) || ty > 125) return;
      if (!this.solidAt(tx, ty - 1, tz)) return;
      id = item === 324 ? 64 : 71;
      meta = doorMeta((a, b, c) => this.block(a, b, c), p.yaw, id, tx, ty, tz);
      this.setBlock(tx, ty, tz, id, meta);
      this.setBlock(tx, ty + 1, tz, id, meta | 8);
      touched.push([tx, ty + 1, tz]);
      return;
    }
    if (item === 323) { if (face === 0) return; id = face === 1 ? 63 : 68; meta = face === 1 ? Math.floor(((p.yaw + 180) * 16) / 360 + 0.5) & 15 : face; }
    else if (item === 331) { if (face !== 1) return; id = 55; }
    else if (item === 295) { if (clicked !== 60 || face !== 1) return; id = 59; }
    else if (item === 338) id = 83;
    else if (item === 326) id = 9;
    else if (item === 327) id = 11;
    else if (item >= 256) return;                                  // food, tools...: nothing to place
    else if (id === 50 || id === 75 || id === 76) { if (face === 0) return; meta = TORCH_META[face]; }
    else if (id === 65) { if (face < 2) return; meta = face; }
    else if (id === 53 || id === 67) meta = Math.max(0, stairMeta((a, b, c) => this.block(a, b, c), (i) => FULL.has(i) && i !== 53 && i !== 67, tx, ty, tz));
    else if (id === 61 || id === 62) meta = furnaceMeta((a, b, c) => this.block(a, b, c), tx, ty, tz);
    else if (id === 86 || id === 91) meta = (dir + 2) & 3;
    else if (id === 69) meta = face === 1 ? 5 + (dir & 1) : TORCH_META[face] ?? 5;
    else if (id === 77) { if (face < 2) return; meta = TORCH_META[face]; }

    // plants, rails, redstone... need something solid under them
    if (NEEDS_FLOOR.has(id)) { const below = this.block(tx, ty - 1, tz); if (below === 0 || LIQUID.has(below)) return; }

    this.setBlock(tx, ty, tz, id, meta);
    if (id === 44 && this.block(tx, ty - 1, tz) === 44) {          // slab on slab -> double slab (same rule as the client)
      this.setBlock(tx, ty, tz, 0, 0);
      this.setBlock(tx, ty - 1, tz, 43, 0);
      touched.push([tx, ty - 1, tz]);
    }
    if (GRAVITY.has(id)) this.settle(tx, ty, tz, touched);
  }

  /** Move a player out of solid blocks (saved spot got built over, teleport into a wall...). */
  unstuck(p) {
    const x = Math.floor(p.x), z = Math.floor(p.z);
    if (!Number.isFinite(p.y) || p.y < -10 || p.y > 200) { p.x = this.spawn[0] + 0.5; p.y = this.spawn[1]; p.z = this.spawn[2] + 0.5; return; }
    let y = Math.max(1, Math.floor(p.y));
    for (let n = 0; n < 128 && y < 126; n++, y++) {
      if (!FULL.has(this.block(x, y, z)) && !FULL.has(this.block(x, y + 1, z))) { if (y > Math.floor(p.y)) p.y = y; return; }
    }
    p.x = this.spawn[0] + 0.5; p.y = this.spawn[1]; p.z = this.spawn[2] + 0.5;
  }

  // ---------- dropped items ----------
  spawnItem(id, count, x, y, z, vx, vy, vz, delay) {
    const it = { eid: this.nextEid++, id, count, x, y, z, vx, vy, vz, age: 0, delay };
    this.items.set(it.eid, it);
    this.broadcast(S.pickupSpawn(it.eid, id, count, x, y, z, vx, vy, vz));
  }
  tickItems() {
    for (const it of this.items.values()) {
      it.age++;
      if (it.age > 6000) { this.items.delete(it.eid); this.broadcast(S.destroyEntity(it.eid)); continue; }
      // axis by axis, so an item sliding into a trunk / leaves stops instead of being pushed on top of them
      const solid = (x, y, z) => { const b = this.block(Math.floor(x), Math.floor(y), Math.floor(z)); return b !== 0 && !SOLID_NOT.has(b); };
      if (solid(it.x, it.y, it.z)) it.y = Math.floor(it.y) + 1;     // spawned inside a block: pop out upwards
      it.vy -= 0.04;
      if (solid(it.x + it.vx, it.y + 0.1, it.z)) it.vx = 0; else it.x += it.vx;
      if (solid(it.x, it.y + 0.1, it.z + it.vz)) it.vz = 0; else it.z += it.vz;
      if (solid(it.x, it.y + it.vy, it.z)) { if (it.vy < 0) it.y = Math.floor(it.y + it.vy) + 1; it.vy = 0; it.vx *= 0.5; it.vz *= 0.5; }
      else it.y += it.vy;
      it.vx *= 0.98; it.vz *= 0.98;
      if (it.y < -10) { this.items.delete(it.eid); this.broadcast(S.destroyEntity(it.eid)); continue; }
      if (it.age < it.delay) continue;
      for (const p of this.players.values()) {
        if (Math.abs(p.x - it.x) < 1.4 && Math.abs(p.z - it.z) < 1.4 && it.y > p.y - 1.5 && it.y < p.y + 2.5) {
          this.items.delete(it.eid);
          this.broadcast(S.collect(it.eid, p.eid));
          p.send(S.addToInventory(it.id, it.count, 0));
          break;
        }
      }
    }
  }

  // ---------- ticking (driven by polls, so it also works where background timers don't run) ----------
  tickUntilNow() {
    const now = Date.now();
    if (this.lastTick > now + 1000) this.lastTick = now;       // another instance's clock was ahead
    let n = Math.floor((now - this.lastTick) / TICK_MS);
    if (n <= 0) return;
    this.lastTick += n * TICK_MS;
    if (n > 40) { n = 40; this.lastTick = now; }     // after a long idle don't simulate the whole gap
    for (let i = 0; i < n; i++) this.tick(i === n - 1);
    if (now - this.lastSave > 15000) { this.lastSave = now; this.save(); }
  }
  tick(last) {
    this.time++;
    if (this.time % 20 === 0) this.broadcast(S.time(this.time));
    this.tickItems();
    for (const s of this.sessions.values()) {
      if (Date.now() - s.lastSeen > TIMEOUT_MS) { if (s.player) this.drop(s, "timed out"); else { s.closed = true; this.sessions.delete(s.sid); } }
    }
    if (!last) return;
    for (const p of this.players.values()) {
      if (p.moved) { p.moved = false; this.broadcast(S.teleport(p.eid, p.x, p.y, p.z, p.yaw, p.pitch), p); }
      if (p.session.outBytes < 256 * 1024) this.sendChunks(p, VIEW, 6);
    }
  }
  /** Load up to `max` missing chunks within `radius` (nearest first) and unload far ones. */
  sendChunks(p, radius, max) {
    const pcx = Math.floor(p.x) >> 4, pcz = Math.floor(p.z) >> 4;
    for (const k of p.loaded) {
      const [cx, cz] = k.split(",").map(Number);
      if (Math.abs(cx - pcx) > VIEW + 1 || Math.abs(cz - pcz) > VIEW + 1) { p.loaded.delete(k); p.send(S.preChunk(cx, cz, false)); }
    }
    const want = [];
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++)
      if (!p.loaded.has(key(pcx + dx, pcz + dz))) want.push([dx * dx + dz * dz, pcx + dx, pcz + dz]);
    want.sort((a, b) => a[0] - b[0]);
    for (const [, cx, cz] of want.slice(0, max)) {
      const c = this.chunk(cx, cz);
      p.loaded.add(key(cx, cz));
      p.send(S.preChunk(cx, cz, true));
      p.send(S.mapChunk(cx * 16, 0, cz * 16, 16, 128, 16, c.compressed()));
      for (const [k, d] of c.tiles) { const [tx, ty, tz] = k.split(",").map(Number); p.send(S.tile(tx, ty, tz, d)); }
    }
  }

  // ---------- skins & status ----------
  async skin(name) {
    await this.ready;
    const hit = this.skins.get(name);
    if (hit && (!this.db || Date.now() - hit.t < 60000)) return hit.png;
    let png = null;
    try {
      if (this.db) {
        const r = await this.db.pool.query("select v from rc_kv where k = $1", ["skin/" + name]);
        if (r.rows.length) png = new Uint8Array(r.rows[0].v);
      } else if (this.fs) png = new Uint8Array(this.fs.readFileSync(`${this.dir}/skins/${name}.png`));
    } catch { }
    if (png) this.skins.set(name, { png, t: Date.now() });
    return png;
  }
  async setSkin(name, png) {
    await this.ready;
    this.skins.set(name, { png, t: Date.now() });
    if (this.db) { await this.db.pool.query("insert into rc_kv (k, v) values ($1, $2) on conflict (k) do update set v = excluded.v", ["skin/" + name, Buffer.from(png)]); return; }
    try { this.fs?.writeFileSync(`${this.dir}/skins/${name}.png`, png); } catch { }
  }
  status() {
    if (!this.db) this.tickUntilNow();       // shared mode: a status request must not change the game
    return {
      online: this.players.size, max: MAX_PLAYERS,
      players: [...this.players.values()].map((p) => ({ name: p.name, x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) })),
      time: this.time, day: Math.floor(this.time / 24000) + 1, chunks: this.chunks.size, persistent: !!(this.fs || this.db), storage: this.db ? "database" : this.fs ? "disk" : "memory",
    };
  }
}

function parseJson(v) { try { return JSON.parse(new TextDecoder().decode(v)); } catch { return null; } }
function hashString(s) { let h = 0; for (const ch of String(s)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0; return h; }

/** One game per server process; survives Next.js hot reloads in dev. */
export async function getGame() {
  const g = (globalThis.__recreatecraft ??= new Game());
  await g.ready;
  return g;
}
