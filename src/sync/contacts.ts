/**
 * Contatos (leads — D2: lead = contato criado, por dateAdded).
 * Incremental por dateUpdated (asc) com cursor searchAfter, conforme documentação de POST /contacts/search.
 */
import { DAY, MINUTE, getCursor, setCursor, setting, type SyncContext, type SyncResult } from "./context.ts";
import { asStringArray, normalizeEmail, normalizePhone, toIso } from "../lib/normalize.ts";
import { recordAssignment, recordFollowers, type DetectedBy } from "../processing/history.ts";
import type { Db } from "../db/types.ts";

type Cursor = { updatedSince: string; searchAfter?: unknown[]; maxUpdated?: string; backfill: boolean };

const PAGE = 200;
const MAX_PAGES_PER_RUN = 25;
const OVERLAP_MS = 2 * MINUTE;

export async function syncContacts(ctx: SyncContext): Promise<SyncResult> {
  const backfillDays = setting(ctx.unit, "backfill_contacts_days", 90);
  const cur: Cursor = (await getCursor<Cursor>(ctx.db, ctx.unit.id, "contacts")) ??
    { updatedSince: new Date(ctx.now().getTime() - backfillDays * DAY).toISOString(), backfill: true };

  let searchAfter = cur.searchAfter;
  let maxUpdated = cur.maxUpdated ?? cur.updatedSince;
  let upserted = 0, changes = 0;
  const detectedBy: DetectedBy = cur.backfill ? "backfill" : "poll";

  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    const body: Record<string, unknown> = {
      locationId: ctx.unit.location_id,
      pageLimit: PAGE,
      filters: [{ field: "dateUpdated", operator: "range", value: { gte: cur.updatedSince } }],
      sort: [{ field: "dateUpdated", direction: "asc" }],
    };
    if (searchAfter) body.searchAfter = searchAfter;
    const r = await ctx.api.post("contacts", "/contacts/search", body);
    const list: any[] = r?.contacts ?? [];

    for (const c of list) {
      changes += await upsertContact(ctx, c, detectedBy);
      upserted++;
      const u = toIso(c.dateUpdated);
      if (u && u > maxUpdated) maxUpdated = u;
    }

    if (list.length < PAGE) {
      const next = new Date(Date.parse(maxUpdated) - OVERLAP_MS).toISOString();
      await setCursor(ctx.db, ctx.unit.id, "contacts", { updatedSince: next, backfill: false } satisfies Cursor);
      return { status: "ok", upserted, changes };
    }
    searchAfter = list[list.length - 1]?.searchAfter;
    if (!Array.isArray(searchAfter)) {
      throw new Error("contacts.search: resposta sem searchAfter — paginação não confiável (ver relatório do validador)");
    }
  }
  await setCursor(ctx.db, ctx.unit.id, "contacts", { ...cur, searchAfter, maxUpdated } satisfies Cursor);
  return { status: "partial", upserted, changes, needsContinuation: true };
}

export async function upsertContact(ctx: SyncContext, c: any, detectedBy: DetectedBy, dbIn?: Db): Promise<number> {
  const run = async (db: Db) => {
    const unitId = ctx.unit.id;
    const prev = (await db.query(
      `select assigned_to, followers, synced_at, date_added from contacts where unit_id=$1 and crm_id=$2 for update`,
      [unitId, c.id])).rows[0];
    const now = ctx.now().toISOString();
    const dateAdded = toIso(c.dateAdded);
    const followers = asStringArray(c.followers);
    const assignedTo = typeof c.assignedTo === "string" && c.assignedTo ? c.assignedTo : null;
    const capturedLive = !!(dateAdded && ctx.unit.history_since && dateAdded >= toIso(ctx.unit.history_since)!);
    const name = c.contactName ?? ([c.firstName, c.lastName].filter(Boolean).join(" ") || null);

    await db.query(
      `insert into contacts (unit_id, crm_id, name, phone, phone_normalized, email, email_normalized, contact_type, source,
          attribution, tags, assigned_to, followers, date_added, date_updated, captured_live, raw, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       on conflict (unit_id, crm_id) do update set
         name=excluded.name, phone=excluded.phone, phone_normalized=excluded.phone_normalized,
         email=excluded.email, email_normalized=excluded.email_normalized, contact_type=excluded.contact_type,
         source=excluded.source, attribution=excluded.attribution, tags=excluded.tags,
         assigned_to=excluded.assigned_to, followers=excluded.followers,
         date_added=excluded.date_added, date_updated=excluded.date_updated, raw=excluded.raw, synced_at=excluded.synced_at`,
      [unitId, c.id, name, c.phone ?? null, normalizePhone(c.phone), c.email ?? null, normalizeEmail(c.email),
       c.type ?? null, c.source ?? null, c.attributionSource ? JSON.stringify(c.attributionSource) : null,
       asStringArray(c.tags), assignedTo, followers, dateAdded, toIso(c.dateUpdated), capturedLive,
       JSON.stringify(c), now]);

    const observedAfter = prev ? toIso(prev.synced_at) : null;
    let n = await recordAssignment(db, {
      unitId, contactId: c.id, before: prev?.assigned_to, after: assignedTo, isNew: !prev, observedAfter, now, detectedBy,
    });
    n += await recordFollowers({
      db, unitId, contactId: c.id, opportunityId: null,
      before: prev ? asStringArray(prev.followers) : null, after: followers,
      responsible: assignedTo, observedAfter, firstSeenLowerBound: dateAdded, now, detectedBy,
    });
    if (!prev) {
      await db.query(`select classify_contact_origin($1,$2)`, [unitId, c.id]);
      await db.query(`select refresh_contact_derived($1,$2)`, [unitId, c.id]);
    }
    await db.query(`select refresh_seller_handoffs($1,$2)`, [unitId, c.id]);
    return n;
  };
  return dbIn ? run(dbIn) : ctx.db.tx(run);
}
