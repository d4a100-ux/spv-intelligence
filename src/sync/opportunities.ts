/**
 * Oportunidades. A busca não documenta ordenação por atualização, então:
 *  - backfill: varredura completa status=all (paginada, retomável);
 *  - regime:   varredura de status=open a cada ciclo + consulta individual das que saíram de "open"
 *              (foram ganhas/perdidas/excluídas) para capturar o novo status.
 */
import { getCursor, setCursor, type SyncContext, type SyncResult } from "./context.ts";
import { asStringArray, toIso } from "../lib/normalize.ts";
import { recordFollowers, recordOpportunity, type DetectedBy } from "../processing/history.ts";
import { LcError } from "../integrations/leadconnector/errors.ts";

type Cursor = {
  mode: "backfill" | "open_scan";
  scanStartedAt?: string;
  startAfter?: string | number;
  startAfterId?: string;
};

const PAGE = 100;
const MAX_PAGES_PER_RUN = 30;
const MAX_INDIVIDUAL_FETCH = 50;

export async function syncOpportunities(ctx: SyncContext): Promise<SyncResult> {
  const cur: Cursor = (await getCursor<Cursor>(ctx.db, ctx.unit.id, "opportunities")) ?? { mode: "backfill" };
  const scanStartedAt = cur.scanStartedAt ?? ctx.now().toISOString();
  const detectedBy: DetectedBy = cur.mode === "backfill" ? "backfill" : "poll";
  let { startAfter, startAfterId } = cur;
  let upserted = 0, changes = 0;

  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    const r = await ctx.api.get("opportunities", "/opportunities/search", {
      locationId: ctx.unit.location_id, limit: PAGE, status: cur.mode === "backfill" ? "all" : "open",
      startAfter: startAfter as any, startAfterId,
    });
    const list: any[] = r?.opportunities ?? [];
    for (const o of list) { changes += await upsertOpportunity(ctx, o, detectedBy, scanStartedAt); upserted++; }

    const meta = r?.meta ?? {};
    if (list.length < PAGE || (!meta.nextPage && !meta.startAfterId)) {
      // varredura completa
      if (cur.mode === "open_scan") changes += await reconcileClosed(ctx, scanStartedAt);
      await setCursor(ctx.db, ctx.unit.id, "opportunities", { mode: "open_scan" } satisfies Cursor);
      return { status: "ok", upserted, changes };
    }
    startAfter = meta.startAfter;
    startAfterId = meta.startAfterId;
    if (startAfter === undefined || !startAfterId) throw new Error("opportunities.search: meta sem startAfter/startAfterId");
  }
  await setCursor(ctx.db, ctx.unit.id, "opportunities", { mode: cur.mode, scanStartedAt, startAfter, startAfterId } satisfies Cursor);
  return { status: "partial", upserted, changes, needsContinuation: true };
}

/** Abertas no banco que não apareceram na varredura de abertas → consulta individual. */
async function reconcileClosed(ctx: SyncContext, scanStartedAt: string): Promise<number> {
  const gone = await ctx.db.query<{ crm_id: string }>(
    `select crm_id from opportunities where unit_id=$1 and status='open'
       and (last_seen_in_scan_at is null or last_seen_in_scan_at < $2) limit $3`,
    [ctx.unit.id, scanStartedAt, MAX_INDIVIDUAL_FETCH]);
  let n = 0;
  for (const { crm_id } of gone.rows) {
    try {
      const r = await ctx.api.get("opportunities", `/opportunities/${crm_id}`);
      const o = r?.opportunity ?? r;
      if (o?.id) n += await upsertOpportunity(ctx, o, "poll", scanStartedAt);
    } catch (e) {
      if (e instanceof LcError && (e.httpStatus === 404 || e.httpStatus === 400)) {
        await ctx.db.query(
          `insert into opportunity_history (unit_id, opportunity_id, field, old_value, new_value, changed_at, time_source, detected_by)
           values ($1,$2,'status','open','deleted',now(),'detected','poll')`, [ctx.unit.id, crm_id]);
        await ctx.db.query(`update opportunities set status='deleted', synced_at=now() where unit_id=$1 and crm_id=$2`, [ctx.unit.id, crm_id]);
        n++;
      } else throw e;
    }
  }
  return n;
}

export async function upsertOpportunity(ctx: SyncContext, o: any, detectedBy: DetectedBy, seenAt: string): Promise<number> {
  return ctx.db.tx(async (db) => {
    const unitId = ctx.unit.id;
    const prev = (await db.query(
      `select stage_id, status, assigned_to, pipeline_id, followers, last_stage_change_at, last_status_change_at, synced_at
       from opportunities where unit_id=$1 and crm_id=$2 for update`, [unitId, o.id])).rows[0];
    const now = ctx.now().toISOString();
    const after = {
      stage_id: o.pipelineStageId ?? null, status: o.status ?? null, assigned_to: o.assignedTo || null,
      pipeline_id: o.pipelineId ?? null, last_stage_change_at: toIso(o.lastStageChangeAt), last_status_change_at: toIso(o.lastStatusChangeAt),
    };
    const followers = asStringArray(o.followers);
    const contactId = o.contactId ?? o.contact?.id ?? null;

    await db.query(
      `insert into opportunities (unit_id, crm_id, contact_id, pipeline_id, stage_id, status, assigned_to, followers,
          monetary_value, source, lost_reason_id, created_at_crm, updated_at_crm, last_stage_change_at,
          last_status_change_at, last_action_at, last_seen_in_scan_at, raw, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       on conflict (unit_id, crm_id) do update set contact_id=excluded.contact_id, pipeline_id=excluded.pipeline_id,
         stage_id=excluded.stage_id, status=excluded.status, assigned_to=excluded.assigned_to, followers=excluded.followers,
         monetary_value=excluded.monetary_value, source=excluded.source, lost_reason_id=excluded.lost_reason_id,
         created_at_crm=excluded.created_at_crm, updated_at_crm=excluded.updated_at_crm,
         last_stage_change_at=excluded.last_stage_change_at, last_status_change_at=excluded.last_status_change_at,
         last_action_at=excluded.last_action_at, last_seen_in_scan_at=excluded.last_seen_in_scan_at,
         raw=excluded.raw, synced_at=excluded.synced_at`,
      [unitId, o.id, contactId, after.pipeline_id, after.stage_id, after.status, after.assigned_to, followers,
       o.monetaryValue ?? null, o.source ?? null, o.lostReasonId ?? null, toIso(o.createdAt), toIso(o.updatedAt),
       after.last_stage_change_at, after.last_status_change_at, toIso(o.lastActionDate), seenAt,
       JSON.stringify(stripContact(o)), now]);

    const before = prev ? {
      ...prev, last_stage_change_at: toIso(prev.last_stage_change_at), last_status_change_at: toIso(prev.last_status_change_at),
      synced_at: toIso(prev.synced_at),
    } : null;
    let n = await recordOpportunity(db, { unitId, oppId: o.id, contactId, before, after, createdAt: toIso(o.createdAt), now, detectedBy });
    if (contactId) {
      n += await recordFollowers({
        db, unitId, contactId, opportunityId: o.id,
        before: prev ? asStringArray(prev.followers) : null, after: followers,
        responsible: after.assigned_to, observedAfter: before?.synced_at ?? null,
        firstSeenLowerBound: toIso(o.createdAt), now, detectedBy,
      });
      await db.query(`select refresh_contact_derived($1,$2)`, [unitId, contactId]);
      await db.query(`select refresh_seller_handoffs($1,$2)`, [unitId, contactId]);
    }
    return n;
  });
}

/** O objeto aninhado `contact` traz nome/telefone/e-mail — já temos em contacts; não duplicar PII. */
function stripContact(o: any) {
  const { contact, ...rest } = o ?? {};
  return { ...rest, contactId: o?.contactId ?? contact?.id };
}
