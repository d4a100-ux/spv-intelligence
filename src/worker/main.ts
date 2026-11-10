/**
 * Worker de sincronização contínua (processo dedicado — não depende da interface).
 *   npm run worker          → roda continuamente todas as unidades habilitadas
 *   npm run worker -- --once → processa os jobs vencidos e encerra (diagnóstico)
 *   npm run worker -- --unit carros-online → só uma unidade
 */
import { getDb, getPool, closeDb } from "../db/pg.ts";
import { createLogger } from "../lib/log.ts";
import { loadUnitClient } from "../units/load.ts";
import { recoverInterrupted, runUnit } from "./unit-runner.ts";

const args = process.argv.slice(2);
const once = args.includes("--once");
const onlySlug = args.includes("--unit") ? args[args.indexOf("--unit") + 1] : undefined;
const log = createLogger({ svc: "worker" });
let stopping = false;
process.on("SIGINT", () => { stopping = true; log.warn("encerrando após o job atual…"); });
process.on("SIGTERM", () => { stopping = true; });

const running = new Map<string, Promise<void>>();

async function startUnit(unitId: string, slug: string) {
  // Advisory lock por unidade: impede dois workers processando a mesma subconta.
  const client = await getPool().connect();
  // Se a conexão da trava cair, a trava é perdida no servidor: para esta unidade com segurança
  // (o próximo discover() a reinicia com uma trava nova).
  let lockLost = false;
  client.on("error", (e) => { lockLost = true; log.warn("conexão da trava da unidade perdida; reiniciando unidade", { unit: slug, error: e.message }); });
  let got = false;
  try {
    got = (await client.query(`select pg_try_advisory_lock(hashtext('spv-unit:' || $1)) ok`, [unitId])).rows[0].ok;
  } catch (e) { client.release(true); throw e; }
  if (!got) { client.release(); log.warn("unidade já em execução em outro worker", { unit: slug }); return; }
  const db = getDb();
  const { unit, api } = await loadUnitClient(db, unitId);
  const recovered = await recoverInterrupted(db, unitId);
  log.info("unidade iniciada", { unit: slug, jobsRecuperados: recovered });
  const p = runUnit(db, unit, api, log.child({ unit: slug }), { once, shouldStop: () => stopping || lockLost })
    .catch((e) => log.error("loop da unidade abortou", { unit: slug, error: e instanceof Error ? e.message : String(e) }))
    .finally(async () => {
      if (!lockLost) await client.query(`select pg_advisory_unlock(hashtext('spv-unit:' || $1))`, [unitId]).catch(() => {});
      client.release(lockLost);
      running.delete(unitId);
    });
  running.set(unitId, p);
}

async function discover() {
  const db = getDb();
  const rows = (await db.query<{ id: string; slug: string }>(
    `select u.id, u.slug from units u join integration_credentials c on c.unit_id = u.id
     where u.enabled ${onlySlug ? "and u.slug = $1" : ""}`, onlySlug ? [onlySlug] : [])).rows;
  if (!rows.length) log.warn("nenhuma unidade habilitada com credencial", { onlySlug });
  for (const r of rows) if (!running.has(r.id)) await startUnit(r.id, r.slug);
}

// Última barreira: nada de erro "solto" derruba o processo sem registro. O supervisor (npm run worker)
// religa o processo se ele encerrar mesmo assim.
process.on("unhandledRejection", (e) => log.error("promessa rejeitada sem tratamento", { error: e instanceof Error ? e.message : String(e) }));

async function main() {
  // Rede instável na partida: tenta descobrir as unidades com backoff em vez de abortar.
  for (let attempt = 1; ; attempt++) {
    try { await discover(); break; } catch (e) {
      if (once || attempt >= 10) throw e;
      log.warn("falha ao iniciar; nova tentativa", { attempt, error: e instanceof Error ? e.message : String(e) });
      await new Promise((r) => setTimeout(r, Math.min(60_000, 2000 * attempt)));
    }
  }
  if (once) { await Promise.all(running.values()); await closeDb(); return; }
  // Novas unidades cadastradas — e unidades cujo loop parou (ex.: trava perdida) — reiniciam sozinhas.
  const timer = setInterval(() => { if (!stopping) discover().catch((e) => log.error("discover falhou", { error: String(e) })); }, 60_000);
  while (!stopping || running.size) await new Promise((r) => setTimeout(r, 1000));
  clearInterval(timer);
  await closeDb();
}

main().catch(async (e) => {
  log.error("worker falhou", { error: e instanceof Error ? e.message : String(e) });
  await closeDb();
  process.exit(1);
});
