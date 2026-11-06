import pg from "pg";
import type { Db } from "./types.ts";
import { config } from "../config.ts";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: Number(process.env.DB_POOL_MAX ?? 12),
      ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? undefined : { rejectUnauthorized: false },
    });
  }
  return pool;
}

function wrap(q: pg.Pool | pg.PoolClient): Db {
  return {
    async query(text, params) {
      const r = await q.query(text, params as any[]);
      return { rows: r.rows };
    },
    async tx(fn) {
      if ("release" in q) return fn(wrap(q)); // já dentro de transação
      const client = await (q as pg.Pool).connect();
      try {
        await client.query("begin");
        const out = await fn(wrap(client));
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

export function getDb(): Db {
  return wrap(getPool());
}

export async function closeDb() {
  await pool?.end();
  pool = null;
}
