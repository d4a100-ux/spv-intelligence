import type { SyncContext, SyncResult } from "../sync/context.ts";
import { syncCalendars, syncHealth, syncPipelines, syncUsers } from "../sync/reference.ts";
import { syncContacts } from "../sync/contacts.ts";
import { syncConversations } from "../sync/conversations.ts";
import { syncOpportunities } from "../sync/opportunities.ts";
import { syncAppointments } from "../sync/appointments.ts";
import type { Db } from "../db/types.ts";

export type JobKind =
  | "health" | "users" | "pipelines" | "calendars"
  | "conversations" | "contacts" | "opportunities" | "appointments" | "maintenance";

type JobDef = {
  run: (ctx: SyncContext) => Promise<SyncResult>;
  intervalSec: number;
  priority: number;
  /** essencial = continua rodando com cota diária baixa; health = único que roda com unidade em erro */
  essential: boolean;
};

/** Prioridade conforme briefing: mensagens/conversas → responsáveis/seguidores → etapas → agendamentos. */
export const JOBS: Record<JobKind, JobDef> = {
  health:        { run: syncHealth,        intervalSec: 300,   priority: 5,  essential: true },
  users:         { run: syncUsers,         intervalSec: 3600,  priority: 10, essential: true },
  pipelines:     { run: syncPipelines,     intervalSec: 3600,  priority: 10, essential: true },
  calendars:     { run: syncCalendars,     intervalSec: 3600,  priority: 10, essential: false },
  conversations: { run: syncConversations, intervalSec: 60,    priority: 20, essential: true },
  contacts:      { run: syncContacts,      intervalSec: 120,   priority: 30, essential: true },
  opportunities: { run: syncOpportunities, intervalSec: 300,   priority: 40, essential: false },
  appointments:  { run: syncAppointments,  intervalSec: 300,   priority: 50, essential: false },
  maintenance:   { run: maintenance,       intervalSec: 86400, priority: 90, essential: false },
};

async function maintenance(ctx: SyncContext): Promise<SyncResult> {
  const r = await ctx.db.query(
    `with d as (delete from jobs where unit_id=$1 and status in ('done','skipped') and finished_at < now() - interval '7 days' returning 1)
     select count(*)::int n from d`, [ctx.unit.id]);
  return { status: "ok", upserted: 0, changes: 0, notes: [`${r.rows[0].n} jobs antigos removidos`] };
}

/**
 * Enfileira jobs vencidos de UMA unidade. Idempotente: dedupe_key por janela de tempo e
 * nunca duplica um job do mesmo tipo que ainda esteja na fila/rodando.
 */
export async function enqueueDue(db: Db, unitId: string, opts: { onlyHealth: boolean; lowQuota: boolean }): Promise<void> {
  const now = Date.now();
  for (const [kind, def] of Object.entries(JOBS) as [JobKind, JobDef][]) {
    if (opts.onlyHealth && kind !== "health") continue;
    if (opts.lowQuota && !def.essential) continue;
    const slot = Math.floor(now / (def.intervalSec * 1000));
    await db.query(
      `insert into jobs (unit_id, kind, priority, dedupe_key)
       select $1, $2, $3, $4
       where not exists (select 1 from jobs where unit_id=$1 and kind=$2 and status in ('queued','running'))
       on conflict (dedupe_key) do nothing`,
      [unitId, kind, def.priority, `${unitId}:${kind}:${slot}`]);
  }
}

export async function enqueueContinuation(db: Db, unitId: string, kind: JobKind, fromJobId: number): Promise<void> {
  await db.query(
    `insert into jobs (unit_id, kind, priority, dedupe_key) values ($1,$2,$3,$4) on conflict (dedupe_key) do nothing`,
    [unitId, kind, JOBS[kind].priority + 1, `${unitId}:${kind}:cont:${fromJobId}`]);
}
