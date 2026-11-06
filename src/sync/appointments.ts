/** Agendamentos: GET /calendars/events exige calendarId → iteramos os calendários da unidade. */
import { DAY, getCursor, setCursor, setting, type SyncContext, type SyncResult } from "./context.ts";
import { asStringArray, toIso } from "../lib/normalize.ts";
import { recordAppointment, type DetectedBy } from "../processing/history.ts";

type Cursor = { backfillDone: boolean };

export async function syncAppointments(ctx: SyncContext): Promise<SyncResult> {
  const cur = (await getCursor<Cursor>(ctx.db, ctx.unit.id, "appointments")) ?? { backfillDone: false };
  const now = ctx.now().getTime();
  const pastDays = cur.backfillDone ? 7 : setting(ctx.unit, "backfill_contacts_days", 90);
  const startTime = now - pastDays * DAY;
  const endTime = now + 60 * DAY;
  const detectedBy: DetectedBy = cur.backfillDone ? "poll" : "backfill";

  const cals = await ctx.db.query<{ crm_id: string }>(`select crm_id from calendars where unit_id=$1 and active`, [ctx.unit.id]);
  let upserted = 0, changes = 0;
  const touchedContacts = new Set<string>();

  for (const { crm_id } of cals.rows) {
    const r = await ctx.api.get("events", "/calendars/events", {
      locationId: ctx.unit.location_id, calendarId: crm_id, startTime, endTime,
    });
    for (const e of (r?.events ?? []) as any[]) {
      changes += await upsertAppointment(ctx, e, detectedBy);
      upserted++;
      if (e.contactId) touchedContacts.add(e.contactId);
    }
  }
  for (const c of touchedContacts) {
    await ctx.db.query(`select refresh_contact_derived($1,$2)`, [ctx.unit.id, c]);
    await ctx.db.query(`select refresh_seller_handoffs($1,$2)`, [ctx.unit.id, c]);
  }
  if (!cur.backfillDone) await setCursor(ctx.db, ctx.unit.id, "appointments", { backfillDone: true } satisfies Cursor);
  return { status: "ok", upserted, changes, notes: cals.rows.length ? [] : ["nenhum calendário ativo sincronizado"] };
}

async function upsertAppointment(ctx: SyncContext, e: any, detectedBy: DetectedBy): Promise<number> {
  return ctx.db.tx(async (db) => {
    const prev = (await db.query(
      `select appointment_status, start_time, assigned_user_id, date_updated, synced_at from appointments
       where unit_id=$1 and crm_id=$2 for update`, [ctx.unit.id, e.id])).rows[0];
    const after = {
      appointment_status: e.appointmentStatus ?? null, start_time: toIso(e.startTime),
      assigned_user_id: e.assignedUserId ?? null, date_updated: toIso(e.dateUpdated),
    };
    await db.query(
      `insert into appointments (unit_id, crm_id, calendar_id, contact_id, assigned_user_id, users, title, appointment_status,
          start_time, end_time, date_added, date_updated, raw, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
       on conflict (unit_id, crm_id) do update set calendar_id=excluded.calendar_id, contact_id=excluded.contact_id,
         assigned_user_id=excluded.assigned_user_id, users=excluded.users, title=excluded.title,
         appointment_status=excluded.appointment_status, start_time=excluded.start_time, end_time=excluded.end_time,
         date_added=excluded.date_added, date_updated=excluded.date_updated, raw=excluded.raw, synced_at=now()`,
      [ctx.unit.id, e.id, e.calendarId ?? null, e.contactId ?? null, after.assigned_user_id, asStringArray(e.users),
       e.title ?? null, after.appointment_status, after.start_time, toIso(e.endTime), toIso(e.dateAdded),
       after.date_updated, JSON.stringify(e)]);
    const before = prev ? {
      ...prev, start_time: toIso(prev.start_time), date_updated: toIso(prev.date_updated), synced_at: toIso(prev.synced_at),
    } : null;
    return recordAppointment(db, {
      unitId: ctx.unit.id, apptId: e.id, contactId: e.contactId ?? null, before, after,
      dateAdded: toIso(e.dateAdded), now: ctx.now().toISOString(), detectedBy,
    });
  });
}
