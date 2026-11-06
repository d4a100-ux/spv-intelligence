/**
 * Worker de sincronização contínua (processo dedicado — não depende da interface).
 *   npm run worker          → roda continuamente todas as unidades habilitadas
 *   npm run worker -- --once → processa os jobs vencidos e encerra (diagnóstico)
 *   npm run worker -- --unit carros-online → só uma unidade
 */
import { getDb, getPool, closeDb } from "../db/pg.ts";
import { createLogger } from "../lib/log.ts";
import { loadUnitClient } from "../units/load.ts";
import { runUnit } from "./unit-runner.ts";

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
  const got = (await client.query(`select pg_try_advisory_lock(hashtext('spv-unit:' || $1)) ok`, [unitId])).rows[0].ok;
  if (!got) { client.release(); log.warn("unidade já em execução em outro worker", { unit: slug }); return; }
  const db = getDb();
  const { unit, api } = await loadUnitClient(db, unitId);
  log.info("unidade iniciada", { unit: slug });
  const p = runUnit(db, unit, api, log.child({ unit: slug }), { once, shouldStop: () => stopping })
    .catch((e) => log.error("loop da unidade abortou", { unit: slug, error: e instanceof Error ? e.message : String(e) }))
    .finally(async () => {
      await client.query(`select pg_advisory_unlock(hashtext('spv-unit:' || $1))`, [unitId]).catch(() => {});
      client.release();
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

async function main() {
  await discover();
  if (once) { await Promise.all(running.values()); await closeDb(); return; }
  // Novas unidades cadastradas entram sem reiniciar o worker.
  const timer = setInterval(() => { if (!stopping) discover().catch((e) => log.error("discover falhou", { error: String(e) })); }, 5 * 60_000);
  while (!stopping || running.size) await new Promise((r) => setTimeout(r, 1000));
  clearInterval(timer);
  await closeDb();
}

main().catch(async (e) => {
  log.error("worker falhou", { error: e instanceof Error ? e.message : String(e) });
  await closeDb();
  process.exit(1);
});
