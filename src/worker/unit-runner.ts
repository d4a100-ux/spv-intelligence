/**
 * Executor de UMA unidade. Cada unidade tem: seu próprio cliente/limitador, sua fila (claim_job por unit_id)
 * e seu advisory lock. Erro, 429 ou token inválido em uma subconta não afeta as demais.
 */
import type { Db } from "../db/types.ts";
import type { LcApi } from "../integrations/leadconnector/client.ts";
import { LcError } from "../integrations/leadconnector/errors.ts";
import { safeErrorMessage, type Logger } from "../lib/log.ts";
import type { UnitRow } from "../sync/context.ts";
import { JOBS, enqueueContinuation, enqueueDue, type JobKind } from "./jobs.ts";
import { config } from "../config.ts";
import { sleep } from "../integrations/leadconnector/rate-limiter.ts";

const DEGRADED_AFTER = 3;

export type RunnerOptions = { once?: boolean; idleMs?: number; shouldStop?: () => boolean };

export async function runUnit(db: Db, unit: UnitRow, api: LcApi, log: Logger, opts: RunnerOptions = {}): Promise<void> {
  const idleMs = opts.idleMs ?? 5000;
  let lastRecovery = 0;
  for (;;) {
    if (opts.shouldStop?.()) return;
    const fresh = (await db.query<UnitRow & { enabled: boolean }>(`select * from units where id=$1`, [unit.id])).rows[0];
    if (!fresh?.enabled) { if (opts.once) return; await sleep(30_000); continue; }
    Object.assign(unit, fresh);

    if (Date.now() - lastRecovery > 5 * 60_000) {
      await db.query(
        `update jobs set status='queued', locked_at=null, last_error='recuperado após travamento'
         where unit_id=$1 and status='running' and locked_at < now() - interval '15 minutes'`, [unit.id]);
      lastRecovery = Date.now();
    }

    const lowQuota = api.limiter.lastDailyRemaining !== null && api.limiter.lastDailyRemaining < config.dailyReserve;
    await enqueueDue(db, unit.id, { onlyHealth: unit.connection_status === "error", lowQuota });

    const job = (await db.query(`select * from claim_job($1)`, [unit.id])).rows[0];
    if (!job) { if (opts.once) return; await sleep(idleMs); continue; }
    await executeJob(db, unit, api, log, job);
  }
}

export async function executeJob(db: Db, unit: UnitRow, api: LcApi, log: Logger, job: any): Promise<void> {
  const kind = job.kind as JobKind;
  const def = JOBS[kind];
  const jlog = log.child({ unit: unit.slug, job: job.id, kind });
  const started = Date.now();
  const reqBefore = api.stats.requests;
  const logRow = (await db.query<{ id: number }>(
    `insert into sync_logs (unit_id, job_id, resource, status) values ($1,$2,$3,'running') returning id`,
    [unit.id, job.id, kind])).rows[0];

  const finishLog = (status: string, extra: { upserted?: number; changes?: number; errorClass?: string | null; http?: number | null; error?: string | null }) =>
    db.query(
      `update sync_logs set finished_at=now(), duration_ms=$2, status=$3, requests=$4, records_upserted=$5,
         changes_detected=$6, rate_limit_remaining=$7, daily_remaining=$8, error_class=$9, http_status=$10, error=$11
       where id=$1`,
      [logRow.id, Date.now() - started, status, api.stats.requests - reqBefore, extra.upserted ?? 0, extra.changes ?? 0,
       api.limiter.lastRemaining, api.limiter.lastDailyRemaining, extra.errorClass ?? null, extra.http ?? null, extra.error ?? null]);

  if (!def) {
    await db.query(`update jobs set status='skipped', finished_at=now(), last_error='tipo desconhecido' where id=$1`, [job.id]);
    await finishLog("error", { errorClass: "internal", error: `tipo de job desconhecido: ${kind}` });
    return;
  }

  try {
    const res = await def.run({ db, unit, api, log: jlog, now: () => new Date() });
    await finishLog(res.status, { upserted: res.upserted, changes: res.changes, error: res.notes?.join("; ") || null });
    await db.query(`update jobs set status='done', finished_at=now(), last_error=null where id=$1`, [job.id]);
    if (res.needsContinuation) await enqueueContinuation(db, unit.id, kind, job.id);
    await markHealthy(db, unit);
    jlog.info("job ok", { status: res.status, upserted: res.upserted, changes: res.changes, requests: api.stats.requests - reqBefore });
  } catch (e) {
    const lc = e instanceof LcError ? e : null;
    const msg = safeErrorMessage(e);
    await finishLog("error", { errorClass: lc?.errorClass ?? "internal", http: lc?.httpStatus ?? null, error: msg });
    const fatal = lc?.isFatalForUnit ?? false;
    const retry = !fatal && job.attempts < job.max_attempts;
    await db.query(
      `update jobs set status=$2, finished_at=case when $2='failed' then now() end, locked_at=null, last_error=$3,
         run_after = now() + make_interval(secs => $4) where id=$1`,
      [job.id, retry ? "queued" : "failed", msg, Math.min(900, 30 * 2 ** job.attempts)]);
    await markFailure(db, unit, msg, fatal, lc?.errorClass ?? "internal");
    jlog.error("job falhou", { errorClass: lc?.errorClass ?? "internal", http: lc?.httpStatus ?? null, error: msg, willRetry: retry });
  }
}

async function markHealthy(db: Db, unit: UnitRow) {
  await db.query(
    `update units set connection_status='ok', consecutive_failures=0, last_error=null, last_sync_at=now(), updated_at=now()
     where id=$1`, [unit.id]);
  await db.query(
    `with r as (update operational_alerts set status='auto_resolved', resolved_at=now()
       where unit_id=$1 and rule_key='integracao_falhando' and status in ('open','acknowledged') returning id)
     insert into alert_events (alert_id, action, note) select id, 'auto_resolved', 'sincronização normalizada' from r`, [unit.id]);
  unit.connection_status = "ok";
}

/** Monitoramento de falhas: degrada após N falhas seguidas; auth/escopo → erro imediato + alerta crítico. */
async function markFailure(db: Db, unit: UnitRow, msg: string, fatal: boolean, errorClass: string) {
  const r = await db.query<{ consecutive_failures: number; connection_status: string }>(
    `update units set consecutive_failures = consecutive_failures + 1, last_error=$2, updated_at=now(),
       connection_status = case when $3 then 'error'
                                when consecutive_failures + 1 >= $4 then 'degraded'
                                else connection_status end
     where id=$1 returning consecutive_failures, connection_status`,
    [unit.id, msg, fatal, DEGRADED_AFTER]);
  const st = r.rows[0];
  unit.connection_status = st.connection_status;
  if (st.connection_status === "error" || st.connection_status === "degraded") {
    const ins = await db.query<{ id: string }>(
      `insert into operational_alerts (unit_id, rule_key, priority, title, details, started_at)
       values ($1,'integracao_falhando',$2,$3,$4, now())
       on conflict do nothing returning id`,
      [unit.id, fatal ? "critical" : "high",
       fatal ? `Integração ${unit.name}: token inválido ou sem permissão` : `Integração ${unit.name}: falhas consecutivas de sincronização`,
       JSON.stringify({ errorClass, consecutiveFailures: st.consecutive_failures, lastError: msg })]);
    if (ins.rows[0]) await db.query(`insert into alert_events (alert_id, action, note) values ($1,'opened',$2)`, [ins.rows[0].id, errorClass]);
  }
}
