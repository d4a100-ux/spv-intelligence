/**
 * Captura histórica (risco R2): a API só fornece o estado atual, então cada sync compara
 * o estado anterior salvo com o novo e grava a diferença. Prioridade: responsáveis,
 * seguidores (com detecção de vendedor), etapas/status e agendamentos.
 */
import type { Db } from "../db/types.ts";
import { diffSets } from "../lib/normalize.ts";

export type DetectedBy = "poll" | "backfill" | "webhook";

type FollowerCtx = {
  db: Db; unitId: string; contactId: string; opportunityId: string | null;
  before: string[] | null;               // null = primeira vez que vemos o registro
  after: string[];
  responsible: string | null;            // assignedTo atual (SDR)
  observedAfter: string | null;          // última observação anterior
  firstSeenLowerBound: string | null;    // para snapshot: data de entrada do lead
  now: string;
  detectedBy: DetectedBy;
};

/** Grava mudanças de seguidores e abre/fecha handoffs de vendedor. Retorna nº de mudanças. */
export async function recordFollowers(c: FollowerCtx): Promise<number> {
  let changes = 0;
  if (c.before === null) {
    for (const u of c.after) {
      const id = await insertFollower(c, u, "snapshot", c.now, c.firstSeenLowerBound, "snapshot");
      await openHandoffIfSeller(c, u, id, c.now, c.firstSeenLowerBound);
    }
    return 0; // snapshot não é mudança
  }
  const { added, removed } = diffSets(c.before, c.after);
  for (const u of added) {
    const id = await insertFollower(c, u, "added", c.now, c.observedAfter, "detected");
    await openHandoffIfSeller(c, u, id, c.now, c.observedAfter);
    changes++;
  }
  for (const u of removed) {
    await insertFollower(c, u, "removed", c.now, c.observedAfter, "detected");
    await c.db.query(
      `update seller_handoffs set status='follower_removed', updated_at=now()
       where unit_id=$1 and contact_id=$2 and seller_user_id=$3 and status='awaiting_seller'
         and coalesce(opportunity_id,'') = coalesce($4,'')`,
      [c.unitId, c.contactId, u, c.opportunityId]);
    changes++;
  }
  return changes;
}

async function insertFollower(c: FollowerCtx, userId: string, action: string, at: string, observedAfter: string | null, timeSource: string): Promise<number> {
  const r = await c.db.query<{ id: number }>(
    `insert into contact_follower_history (unit_id, contact_id, opportunity_id, user_id, action, changed_at, observed_after, time_source, detected_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [c.unitId, c.contactId, c.opportunityId, userId, action, at, observedAfter, timeSource, c.detectedBy]);
  return r.rows[0].id;
}

/** Só vira handoff se o usuário estiver classificado como vendedor. Não é transferência concluída. */
async function openHandoffIfSeller(c: FollowerCtx, userId: string, historyId: number, at: string, observedAfter: string | null) {
  await c.db.query(
    `insert into seller_handoffs (unit_id, contact_id, opportunity_id, seller_user_id, responsible_at_detection,
                                  follower_history_id, added_at, observed_after)
     select $1,$2,$3,$4,$5,$6,$7,$8
     where exists (select 1 from crm_users where unit_id=$1 and crm_id=$4 and operational_role='seller')
       and coalesce($5,'') <> $4            -- vendedor que já é o responsável não é "seguidor compartilhado"
     on conflict do nothing`,
    [c.unitId, c.contactId, c.opportunityId, userId, c.responsible, historyId, at, observedAfter]);
}

export async function recordAssignment(db: Db, p: {
  unitId: string; contactId: string; before: string | null | undefined; after: string | null;
  isNew: boolean; observedAfter: string | null; now: string; detectedBy: DetectedBy;
}): Promise<number> {
  if (p.isNew) {
    await db.query(
      `insert into contact_assignment_history (unit_id, contact_id, from_user, to_user, changed_at, observed_after, time_source, detected_by)
       values ($1,$2,null,$3,$4,null,'snapshot',$5)`,
      [p.unitId, p.contactId, p.after, p.now, p.detectedBy]);
    return 0;
  }
  if ((p.before ?? null) === (p.after ?? null)) return 0;
  await db.query(
    `insert into contact_assignment_history (unit_id, contact_id, from_user, to_user, changed_at, observed_after, time_source, detected_by)
     values ($1,$2,$3,$4,$5,$6,'detected',$7)`,
    [p.unitId, p.contactId, p.before ?? null, p.after, p.now, p.observedAfter, p.detectedBy]);
  return 1;
}

type OppState = {
  stage_id: string | null; status: string | null; assigned_to: string | null; pipeline_id: string | null;
  last_stage_change_at: string | null; last_status_change_at: string | null; synced_at?: string | null;
};

export async function recordOpportunity(db: Db, p: {
  unitId: string; oppId: string; contactId: string | null; before: OppState | null; after: OppState;
  createdAt: string | null; now: string; detectedBy: DetectedBy;
}): Promise<number> {
  const ins = (field: string, oldV: string | null, newV: string | null, at: string, observedAfter: string | null, src: string) =>
    db.query(
      `insert into opportunity_history (unit_id, opportunity_id, contact_id, field, old_value, new_value, changed_at, observed_after, time_source, detected_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [p.unitId, p.oppId, p.contactId, field, oldV, newV, at, observedAfter, src, p.detectedBy]);

  const a = p.after;
  if (!p.before) {
    await ins("stage", null, a.stage_id, a.last_stage_change_at ?? p.createdAt ?? p.now, null, "snapshot");
    await ins("status", null, a.status, a.last_status_change_at ?? p.createdAt ?? p.now, null, "snapshot");
    if (a.assigned_to) await ins("assigned_to", null, a.assigned_to, p.now, null, "snapshot");
    return 0;
  }
  const b = p.before;
  let n = 0;
  // Etapa/status: usa o horário exato do CRM quando ele avançou; senão, o momento da detecção.
  const exactOr = (crmAt: string | null, prevAt: string | null) =>
    crmAt && (!prevAt || Date.parse(crmAt) > Date.parse(prevAt)) ? { at: crmAt, src: "crm_field" } : { at: p.now, src: "detected" };
  if (b.pipeline_id !== a.pipeline_id) { await ins("pipeline", b.pipeline_id, a.pipeline_id, p.now, b.synced_at ?? null, "detected"); n++; }
  if (b.stage_id !== a.stage_id) {
    const t = exactOr(a.last_stage_change_at, b.last_stage_change_at);
    await ins("stage", b.stage_id, a.stage_id, t.at, b.synced_at ?? null, t.src); n++;
  }
  if (b.status !== a.status) {
    const t = exactOr(a.last_status_change_at, b.last_status_change_at);
    await ins("status", b.status, a.status, t.at, b.synced_at ?? null, t.src); n++;
  }
  if ((b.assigned_to ?? null) !== (a.assigned_to ?? null)) {
    await ins("assigned_to", b.assigned_to, a.assigned_to, p.now, b.synced_at ?? null, "detected"); n++;
  }
  return n;
}

type ApptState = { appointment_status: string | null; start_time: string | null; assigned_user_id: string | null; date_updated: string | null; synced_at?: string | null };

export async function recordAppointment(db: Db, p: {
  unitId: string; apptId: string; contactId: string | null; before: ApptState | null; after: ApptState;
  dateAdded: string | null; now: string; detectedBy: DetectedBy;
}): Promise<number> {
  const ins = (field: string, oldV: string | null, newV: string | null, at: string, observedAfter: string | null, src: string) =>
    db.query(
      `insert into appointment_history (unit_id, appointment_id, contact_id, field, old_value, new_value, changed_at, observed_after, time_source, detected_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [p.unitId, p.apptId, p.contactId, field, oldV, newV, at, observedAfter, src, p.detectedBy]);
  if (!p.before) {
    await ins("created", null, p.after.appointment_status, p.dateAdded ?? p.now, null, p.dateAdded ? "crm_field" : "snapshot");
    return p.detectedBy === "backfill" ? 0 : 1;
  }
  const b = p.before, a = p.after;
  const t = a.date_updated && (!b.date_updated || Date.parse(a.date_updated) > Date.parse(b.date_updated))
    ? { at: a.date_updated, src: "crm_updated" } : { at: p.now, src: "detected" };
  let n = 0;
  for (const f of ["appointment_status", "start_time", "assigned_user_id"] as const) {
    const ov = b[f] ? String(b[f]) : null, nv = a[f] ? String(a[f]) : null;
    const same = f === "start_time" ? (ov && nv ? Date.parse(ov) === Date.parse(nv) : ov === nv) : ov === nv;
    if (!same) { await ins(f, ov, nv, t.at, b.synced_at ?? null, t.src); n++; }
  }
  return n;
}
