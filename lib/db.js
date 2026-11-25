// PostgreSQL storage (Wasmer injects DB_HOST / DB_PORT / DB_NAME / DB_USERNAME / DB_PASSWORD when the app has a
// database: app.yaml capabilities.database.engine: postgres).
//
// When a database is configured the WHOLE game state lives in it, not only the world, so any number of server
// instances (Wasmer runs several copies of the app) share one world and one set of players:
//   rc_kv   key/value: chunk/<cx>/<cz> (modified chunks), level.json, skin/<name>
//   rc_hot  id 1 = live state (sessions, players, items, time), id 2 = saved players. ver = write counter.
//   rc_log  one row per chunk write, so other instances know which chunks to reload.

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
    ssl: e.DB_SSL === "off" ? false : { rejectUnauthorized: false },   // Wasmer requires TLS with a private CA
    max: 4, connectionTimeoutMillis: 10000, statement_timeout: 20000,
  });
  pool.on("error", (err) => console.log("recreatecraft db pool error:", err.message));
  // several instances may start at once: serialize the schema setup
  const c = await pool.connect();
  try {
    await c.query("begin; select pg_advisory_xact_lock(727273);");
    await c.query(`
      create table if not exists rc_kv (k text primary key, v bytea not null);
      create table if not exists rc_hot (id int primary key, ver bigint not null default 0, pruned bigint not null default 0, v text);
      create table if not exists rc_log (seq bigserial primary key, k text not null, ts timestamptz not null default now());
      insert into rc_hot (id) values (1), (2) on conflict do nothing;
    `);
    await c.query("commit");
  } catch (err) { await c.query("rollback").catch(() => {}); throw err; }
  finally { c.release(); }
  return { pool };
}
