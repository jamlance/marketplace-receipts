// Shared Postgres helper. All apps connect to one database
// (`bookerva_apps`) but each gets its OWN schema, so tables never
// collide and data survives redeploys (unlike the old per-container
// SQLite). Async API.
//
//   const db = await openPg("promo_codes", `
//     CREATE TABLE IF NOT EXISTS codes ( ... );
//   `);
//   const rows = await db.q("SELECT * FROM codes WHERE merchant_id=$1", [mid]);
//   const row  = await db.one("SELECT * FROM codes WHERE id=$1", [id]);
//   await db.run("INSERT INTO codes (...) VALUES (...)", [...]);

import pg from "pg";

let pool = null;
function getPool() {
  if (!pool) {
    const connectionString = process.env.APPS_DATABASE_URL;
    if (!connectionString) {
      throw new Error("APPS_DATABASE_URL is not set — the app needs a Postgres connection string.");
    }
    pool = new pg.Pool({ connectionString, max: 6, idleTimeoutMillis: 30000 });
    pool.on("error", (e) => console.error("[pgdb] pool error", e.message));
  }
  return pool;
}

function safeSchema(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!s || /^[0-9]/.test(s)) return `app_${s}`;
  return s;
}

export async function openPg(appName, schemaSql) {
  const schema = safeSchema(appName);

  // Ensure the schema + DDL exist, lazily and idempotently. We do NOT connect
  // at openPg() time: the app must boot even when Postgres is briefly down
  // (otherwise a transient DB blip crash-loops the whole container into 503s).
  // The first query triggers this; on failure it resets so the next request
  // retries, and the app self-heals once the DB returns.
  let ensured = null;
  function ensureSchema() {
    if (ensured) return ensured;
    ensured = (async () => {
      const c = await getPool().connect();
      try {
        await c.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        if (schemaSql) {
          await c.query(`SET search_path TO "${schema}"`);
          await c.query(schemaSql);
        }
      } finally {
        c.release();
      }
    })().catch((e) => { ensured = null; throw e; });
    return ensured;
  }

  // Run a unit of work with the schema's search_path pinned.
  const withSchema = async (fn) => {
    await ensureSchema();
    const c = await getPool().connect();
    try {
      await c.query(`SET search_path TO "${schema}"`);
      return await fn(c);
    } finally {
      c.release();
    }
  };

  return {
    schema,
    ensureSchema,
    async q(sql, params = []) {
      return withSchema(async (c) => (await c.query(sql, params)).rows);
    },
    async one(sql, params = []) {
      return withSchema(async (c) => (await c.query(sql, params)).rows[0] || null);
    },
    async run(sql, params = []) {
      return withSchema(async (c) => {
        const r = await c.query(sql, params);
        return { rowCount: r.rowCount, rows: r.rows };
      });
    },
    /** Run several statements in one transaction with the schema pinned. */
    async tx(fn) {
      await ensureSchema();
      const c = await getPool().connect();
      try {
        await c.query(`SET search_path TO "${schema}"`);
        await c.query("BEGIN");
        const out = await fn(c);
        await c.query("COMMIT");
        return out;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
  };
}
