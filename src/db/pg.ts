import pg from "pg";
import type { Db } from "./types.ts";
import { config } from "../config.ts";

let pool: pg.Pool | null = null;

export const TX_GUARDS = "set local lock_timeout = '15s'; set local idle_in_transaction_session_timeout = '60s'";

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: Number(process.env.DB_POOL_MAX ?? 12),
      ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? undefined : { rejectUnauthorized: false },
      keepAlive: true,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    // Conexão OCIOSA derrubada pela rede (ECONNRESET) emite 'error' no pool. Sem este handler o Node
    // encerra o processo inteiro (causa da queda de 09/11). O pool descarta o cliente e cria outro.
    pool.on("error", (e) => {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "conexão ociosa do banco perdida (será recriada)", error: e.message }));
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
      // Conexão RESERVADA (dentro da transação): se a rede cair entre dois comandos, o 'error' chega
      // sem query ativa para recebê-lo e derrubaria o processo (incidente 10/11 13:14). Com o handler,
      // o próximo comando falha normalmente, a transação vira rollback e o job é refeito.
      let broken: Error | null = null;
      const onError = (e: Error) => { broken = e; };
      client.on("error", onError);
      try {
        await client.query("begin");
        // Limites POR TRANSAÇÃO (incidente 10/11 13:14–13:24): se este processo morrer no meio da
        // transação, o servidor a encerra em 60 s e libera as travas (o Supabase vem com
        // idle_in_transaction_session_timeout = 0, ou seja, nunca). E nenhuma espera por trava passa
        // de 15 s: falha rápido e o job é refeito, em vez de travar até o statement_timeout (2 min).
        await client.query(TX_GUARDS);
        const out = await fn(wrap(client));
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.off("error", onError);
        // Conexão quebrada é descartada (não volta ao pool).
        client.release(broken ?? undefined);
      }
    },
  };
}

/** Exposto só para testes. */
export const wrapForTest = (p: pg.Pool): Db => wrap(p);

export function getDb(): Db {
  return wrap(getPool());
}

export async function closeDb() {
  await pool?.end();
  pool = null;
}
