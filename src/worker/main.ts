/**
 * Worker de sincronização contínua (processo dedicado — não depende da interface).
 *   npm run worker          → roda continuamente todas as unidades habilitadas
 *   npm run worker -- --once → processa os jobs vencidos e encerra (diagnóstico)
 *   npm run worker -- --unit carros-online → só uma unidade
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { getDb, closeDb } from "../db/pg.ts";
import { createLogger } from "../lib/log.ts";
import { loadUnitClient } from "../units/load.ts";
import { recoverInterrupted, runUnit } from "./unit-runner.ts";
import { acquireLease } from "./lease.ts";

const args = process.argv.slice(2);
const once = args.includes("--once");
const onlySlug = args.includes("--unit") ? args[args.indexOf("--unit") + 1] : undefined;
const log = createLogger({ svc: "worker" });
let stopping = false;
process.on("SIGINT", () => { stopping = true; log.warn("encerrando após o job atual…"); });
process.on("SIGTERM", () => { stopping = true; });

const running = new Map<string, Promise<void>>();

/** Identidade desta instância do worker (aparece em unit_leases.holder). */
const HOLDER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

async function startUnit(unitId: string, slug: string) {
  // Lease por unidade (tabela unit_leases): impede dois workers na mesma subconta e expira
  // sozinho se este processo morrer ou perder a rede — sem depender de sessão no servidor.
  const db = getDb();
  const lease = await acquireLease(db, unitId, HOLDER, {
    onLost: (reason) => log.warn("lease da unidade perdido; parando a unidade (será retomada)", { unit: slug, reason }),
  });
  if (!lease) { log.warn("unidade em uso por outro worker (lease ativo)", { unit: slug }); return; }
  running.set(unitId, Promise.resolve()); // reserva o slot antes de qualquer await
  try {
    const { unit, api } = await loadUnitClient(db, unitId);
    const recovered = await recoverInterrupted(db, unitId);
    log.info("unidade iniciada", { unit: slug, jobsRecuperados: recovered, holder: HOLDER });
    const p = runUnit(db, unit, api, log.child({ unit: slug }), { once, shouldStop: () => stopping || lease.isLost() })
      .catch((e) => log.error("loop da unidade abortou", { unit: slug, error: e instanceof Error ? e.message : String(e) }))
      .finally(async () => { await lease.release(); running.delete(unitId); });
    running.set(unitId, p);
  } catch (e) {
    await lease.release();
    running.delete(unitId);
    throw e;
  }
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
