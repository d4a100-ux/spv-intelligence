/**
 * Conversas + mensagens. Incremental por last_message_date (desc) com cursor startAfterDate.
 * Mensagens só são buscadas para conversas que mudaram desde o último ciclo (economia de cota).
 */
import { DAY, MINUTE, getCursor, setCursor, setting, type SyncContext, type SyncResult } from "./context.ts";
import { isHumanMessage, messageKind, toIso } from "../lib/normalize.ts";
import { runInLanes } from "../lib/lanes.ts";

const LANES = Number(process.env.SYNC_DB_LANES ?? 8);

type Cursor = {
  lastMessageAt: number;          // ms — tudo até aqui já foi processado
  resume?: { startAfterDate: unknown; newMax: number }; // backfill em andamento
};

const PAGE = 100;
/** Poucas páginas por rodada: a carga longa é intercalada com contatos/oportunidades/agendamentos. */
const MAX_PAGES_PER_RUN = 5;
const MAX_MESSAGE_PAGES = 20;
const OVERLAP_MS = 2 * MINUTE;

function lastMsgMs(cv: any): number | null {
  const v = cv.lastMessageDate ?? (Array.isArray(cv.sort) ? cv.sort[0] : undefined) ?? cv.dateUpdated;
  const iso = toIso(v);
  return iso ? Date.parse(iso) : null;
}

export async function syncConversations(ctx: SyncContext): Promise<SyncResult> {
  const days = setting(ctx.unit, "backfill_conversations_days", 30);
  const cur: Cursor = (await getCursor<Cursor>(ctx.db, ctx.unit.id, "conversations")) ??
    { lastMessageAt: ctx.now().getTime() - days * DAY };
  const floor = cur.lastMessageAt - OVERLAP_MS;

  let startAfterDate = cur.resume?.startAfterDate;
  let newMax = cur.resume?.newMax ?? cur.lastMessageAt;
  let upserted = 0, changes = 0, reachedOld = false, exhausted = false;
  const notes: string[] = [];

  for (let page = 0; page < MAX_PAGES_PER_RUN && !reachedOld; page++) {
    const r = await ctx.api.get("conversations", "/conversations/search", {
      locationId: ctx.unit.location_id, limit: PAGE, sortBy: "last_message_date", sort: "desc",
      startAfterDate: startAfterDate as any,
    });
    const list: any[] = r?.conversations ?? [];
    // A busca vem ordenada (desc): processa até a primeira conversa mais antiga que o cursor.
    const fresh: { cv: any; lm: number | null }[] = [];
    for (const cv of list) {
      const lm = lastMsgMs(cv);
      if (lm !== null && lm < floor) { reachedOld = true; break; }
      if (lm !== null && lm > newMax) newMax = lm;
      fresh.push({ cv, lm });
    }
    // Paralelo por pistas; o mesmo contato fica sempre na mesma pista (campos derivados/handoffs).
    const results = await runInLanes(fresh, LANES, (x) => String(x.cv.contactId ?? x.cv.id), (x) => syncOneConversation(ctx, x.cv, x.lm));
    for (const n of results) changes += n;
    upserted += fresh.length;
    if (list.length < PAGE) { reachedOld = true; break; }
    const last = list[list.length - 1];
    startAfterDate = Array.isArray(last?.sort) ? last.sort[0] : last?.lastMessageDate;
    if (startAfterDate === undefined) { notes.push("sem cursor startAfterDate na resposta"); reachedOld = true; }
    if (page === MAX_PAGES_PER_RUN - 1 && !reachedOld) exhausted = true;
  }

  if (exhausted) {
    await setCursor(ctx.db, ctx.unit.id, "conversations", { ...cur, resume: { startAfterDate, newMax } } satisfies Cursor);
    return { status: "partial", upserted, changes, needsContinuation: true, notes };
  }
  await setCursor(ctx.db, ctx.unit.id, "conversations", { lastMessageAt: newMax } satisfies Cursor);
  return { status: "ok", upserted, changes, notes };
}

async function syncOneConversation(ctx: SyncContext, cv: any, lm: number | null): Promise<number> {
  const unitId = ctx.unit.id;
  const prev = (await ctx.db.query(
    `select last_message_at, messages_synced_at from conversations where unit_id=$1 and crm_id=$2`, [unitId, cv.id])).rows[0];
  await ctx.db.query(
    `insert into conversations (unit_id, crm_id, contact_id, type, assigned_to, unread_count, last_message_at,
        last_message_direction, last_message_type, raw, synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
     on conflict (unit_id, crm_id) do update set contact_id=excluded.contact_id, type=excluded.type,
       assigned_to=excluded.assigned_to, unread_count=excluded.unread_count, last_message_at=excluded.last_message_at,
       last_message_direction=excluded.last_message_direction, last_message_type=excluded.last_message_type,
       raw=excluded.raw, synced_at=now()`,
    [unitId, cv.id, cv.contactId ?? null, cv.type ?? null, cv.assignedTo ?? null, cv.unreadCount ?? null,
     lm !== null ? new Date(lm).toISOString() : null, cv.lastMessageDirection ?? null, cv.lastMessageType ?? null,
     JSON.stringify(redactConversation(cv))]);

  // Sem mudança desde o último ciclo → não gasta requisição com mensagens.
  const prevLm = prev?.last_message_at ? Date.parse(toIso(prev.last_message_at)!) : null;
  if (prev?.messages_synced_at && prevLm !== null && lm !== null && lm <= prevLm) return 0;

  const stopBefore = prev?.messages_synced_at && prevLm !== null ? prevLm - OVERLAP_MS : null;
  const n = await syncMessages(ctx, cv.id, cv.contactId ?? null, stopBefore);
  await ctx.db.query(`update conversations set messages_synced_at = now() where unit_id=$1 and crm_id=$2`, [unitId, cv.id]);
  if (cv.contactId) {
    await ctx.db.query(`select refresh_contact_derived($1,$2)`, [unitId, cv.contactId]);
    await ctx.db.query(`select refresh_seller_handoffs($1,$2)`, [unitId, cv.contactId]);
  }
  return n;
}

async function syncMessages(ctx: SyncContext, conversationId: string, contactId: string | null, stopBeforeMs: number | null): Promise<number> {
  const humanSources: string[] = setting(ctx.unit, "human_sources", ["app"]);
  let lastMessageId: string | undefined;
  let inserted = 0;
  for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
    const r = await ctx.api.get("messages", `/conversations/${conversationId}/messages`, { limit: 100, lastMessageId });
    const box = r?.messages ?? {};
    const list: any[] = Array.isArray(box) ? box : (box.messages ?? []);
    let crossed = false;
    // Uma página inteira = UM comando no banco (antes: um comando por mensagem).
    const rows: unknown[][] = [];
    const seen = new Set<string>();
    for (const m of list) {
      const at = toIso(m.dateAdded);
      if (!at || !m.id || seen.has(m.id)) continue;   // id repetido no mesmo lote quebraria o ON CONFLICT
      if (stopBeforeMs !== null && Date.parse(at) < stopBeforeMs) { crossed = true; continue; }
      seen.add(m.id);
      rows.push([ctx.unit.id, m.id, conversationId, m.contactId ?? contactId, m.direction ?? null, messageKind(m.messageType),
        m.source ?? null, isHumanMessage(m, humanSources), m.userId ?? null, m.messageType ?? null, m.status ?? null,
        typeof m.body === "string" ? m.body.slice(0, 160) : null, at, JSON.stringify(metaOnly(m))]);
    }
    if (rows.length) {
      const COLS = 14;
      const values = rows.map((_, i) => `(${Array.from({ length: COLS }, (_, k) => `$${i * COLS + k + 1}`).join(",")})`).join(",");
      const res = await ctx.db.query<{ inserted: boolean }>(
        `insert into messages (unit_id, crm_id, conversation_id, contact_id, direction, kind, source, is_human, user_id,
            message_type, status, body_preview, date_added, raw)
         values ${values}
         on conflict (unit_id, crm_id) do update set status=excluded.status, source=excluded.source, kind=excluded.kind,
           is_human=excluded.is_human, user_id=excluded.user_id
         returning (xmax = 0) as inserted`,
        rows.flat());
      inserted += res.rows.filter((x) => x.inserted).length;
    }
    if (crossed || Array.isArray(box) || !box.nextPage || !box.lastMessageId) break;
    lastMessageId = box.lastMessageId;
  }
  return inserted;
}

/** raw sem corpo da mensagem (LGPD): o preview truncado já fica em body_preview. */
function metaOnly(m: any) {
  const { body, attachments, meta, ...rest } = m ?? {};
  return { ...rest, hasAttachments: Array.isArray(attachments) && attachments.length > 0 };
}
function redactConversation(cv: any) {
  const { lastMessageBody, ...rest } = cv ?? {};
  return rest;
}
