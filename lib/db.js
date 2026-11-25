// Optional PostgreSQL storage. Wasmer Edge injects DB_HOST / DB_PORT / DB_NAME / DB_USERNAME / DB_PASSWORD when the
// app has a database (app.yaml: capabilities.database.engine: postgres); when those are set the world is saved there.
// Everything is one key/value table: level.json, players.json, chunk/<cx>/<cz>, skin/<name>.

export function dbConfigured() {
  const e = globalThis.process?.env;
  return !!(e && e.DB_HOST && e.DB_USERNAME);
}

export async function openDb() {
  const mod = await import("pg");
  const pg = mod.default ?? mod;
  const e = process.env;
  const pool = new pg.Pool({
    host: e.DB_HOST, port: Number(e.DB_PORT) || 5432, database: e.DB_NAME,
    user: e.DB_USERNAME, password: e.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },      // Wasmer requires TLS with a private CA
    max: 3, connectionTimeoutMillis: 10000,
  });
  pool.on("error", (err) => console.log("recreatecraft db pool error:", err.message));
  await pool.query("create table if not exists rc_kv (k text primary key, v bytea not null)");
  return {
    /** Every row as [key, Uint8Array]. */
    async loadAll() {
      const r = await pool.query("select k, v from rc_kv");
      return r.rows.map((row) => [row.k, new Uint8Array(row.v.buffer, row.v.byteOffset, row.v.byteLength)]);
    },
    /** Upsert [key, bytes] pairs in one transaction. */
    async putMany(entries) {
      if (!entries.length) return;
      const c = await pool.connect();
      try {
        await c.query("begin");
        for (const [k, v] of entries) {
          await c.query("insert into rc_kv (k, v) values ($1, $2) on conflict (k) do update set v = excluded.v", [k, Buffer.from(v)]);
        }
        await c.query("commit");
      } catch (err) {
        await c.query("rollback").catch(() => {});
        throw err;
      } finally { c.release(); }
    },
  };
}
