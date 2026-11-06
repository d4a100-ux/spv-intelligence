/**
 * SPV Intelligence — Validador de subconta (Etapa 2)
 *
 * Executa chamadas REAIS, somente leitura, em UMA subconta e gera a matriz de
 * disponibilidade comprovada. Nunca imprime o token nem PII de clientes
 * (nomes, telefones, e-mails, corpo de mensagens): reporta status HTTP, contagens,
 * presença de campos, nomes de chaves e valores de enums.
 *
 * Uso:  npm run validate          (lê LC_PIT e LC_LOCATION_ID de .env.local)
 * Saída: console + reports/validation-<locationId>-<timestamp>.json  (pasta fora do git)
 */
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://services.leadconnectorhq.com";
const TOKEN = process.env.LC_PIT ?? "";
const LOCATION_ID = process.env.LC_LOCATION_ID ?? "";
const VERSIONS = ["v3", "2021-07-28"]; // R4: testamos ambos e registramos qual funciona por recurso

if (!TOKEN || !LOCATION_ID) {
  console.error("Defina LC_PIT e LC_LOCATION_ID em .env.local (nunca no código, nunca no chat).");
  process.exit(1);
}

type Avail = "comprovado" | "parcial" | "indisponível" | "não testado";
type Check = {
  id: string; resource: string; endpoint: string; scope: string;
  status: number | null; versionUsed: string | null; versionsTried: Record<string, number | null>;
  ok: boolean; count?: number; keys?: string[];
  fieldsPresent?: Record<string, string>; enums?: Record<string, Record<string, number>>;
  pagination?: { tested: boolean; ok: boolean | null; detail: string };
  notes: string[];
};
type MatrixRow = { item: string; status: Avail; evidence: string };

const report = {
  schema: 2,
  locationId: LOCATION_ID,
  startedAt: new Date().toISOString(),
  rateLimit: {} as Record<string, string>,
  versions: {} as Record<string, string>,
  checks: [] as Check[],
  matrix: [] as MatrixRow[],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CallResult = { status: number | null; json: any; version: string | null; tried: Record<string, number | null> };

async function call(path: string, init: { method?: string; body?: unknown } = {}): Promise<CallResult> {
  const tried: Record<string, number | null> = {};
  let last: CallResult = { status: null, json: null, version: null, tried };
  for (const version of VERSIONS) {
    let status: number | null = null, json: any = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      let res: Response;
      try {
        res = await fetch(BASE + path, {
          method: init.method ?? "GET",
          headers: {
            Authorization: `Bearer ${TOKEN}`, Version: version, Accept: "application/json",
            ...(init.body ? { "Content-Type": "application/json" } : {}),
          },
          body: init.body ? JSON.stringify(init.body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        status = null; json = { message: `falha de rede: ${e instanceof Error ? e.name : "erro"}` };
        await sleep(2 ** attempt * 1000);
        continue;
      }
      for (const h of ["x-ratelimit-remaining", "x-ratelimit-max", "x-ratelimit-daily-remaining", "x-ratelimit-limit-daily", "x-ratelimit-interval-milliseconds"]) {
        const v = res.headers.get(h); if (v) report.rateLimit[h] = v;
      }
      status = res.status;
      try { json = await res.json(); } catch { json = null; }
      if (res.status === 429 || res.status >= 500) { await sleep(2 ** attempt * 1000 + Math.random() * 500); continue; }
      break;
    }
    tried[version] = status;
    last = { status, json, version, tried };
    if (status !== null && status >= 200 && status < 300) return last;
    if (status === 401 || status === 403) return last; // token/escopo — trocar versão não resolve
  }
  return last;
}

const ok = (s: number | null) => s !== null && s >= 200 && s < 300;
const get = (o: any, path: string) => path.split(".").reduce((x: any, k) => (x == null ? undefined : x[k]), o);

function presence(rows: any[], fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const n = rows.filter((r) => { const v = get(r, f); return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0); }).length;
    out[f] = `${n}/${rows.length}`;
  }
  return out;
}
function keyUnion(rows: any[]): string[] {
  const s = new Set<string>();
  for (const r of rows) if (r && typeof r === "object") for (const k of Object.keys(r)) s.add(k);
  return [...s].sort();
}
function tally(values: unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) { const k = v === undefined || v === null || v === "" ? "(vazio)" : String(v); out[k] = (out[k] ?? 0) + 1; }
  return out;
}
function errMsg(r: CallResult): string {
  if (ok(r.status)) return "";
  const m = r.json?.message ?? r.json?.error ?? "";
  return `erro: ${(Array.isArray(m) ? m.join("; ") : String(m)).slice(0, 200)}`;
}

function record(c: Omit<Check, "ok" | "notes" | "versionsTried"> & { tried?: Record<string, number | null>; notes?: string[] }) {
  const isOk = ok(c.status);
  const notes = (c.notes ?? []).filter(Boolean);
  if (c.status === 401) notes.push("401: token inválido, expirado ou de outra subconta.");
  if (c.status === 403) notes.push(`403: escopo provavelmente ausente na Private Integration (${c.scope}).`);
  if (c.status === 422 || c.status === 400) notes.push("400/422: parâmetros ou versão incompatíveis — ver versionsTried.");
  const { tried, ...rest } = c;
  report.checks.push({ ...rest, versionsTried: tried ?? {}, ok: isOk, notes });
  if (isOk && c.versionUsed) report.versions[c.resource] = c.versionUsed;
  const pg = c.pagination?.tested ? ` pag=${c.pagination.ok ? "ok" : "FALHOU"}` : "";
  console.log(`[${isOk ? "OK " : "ERR"}] ${c.id.padEnd(24)} HTTP ${String(c.status ?? "-").padEnd(4)} v=${(c.versionUsed ?? "-").padEnd(10)} ${c.count !== undefined ? `n=${c.count}` : ""}${pg}`);
}

async function main() {
  console.log(`Validando subconta ${LOCATION_ID.slice(0, 4)}… (token oculto)\n`);

  // 1. Location ----------------------------------------------------------
  const loc = await call(`/locations/${LOCATION_ID}`);
  const location = loc.json?.location ?? loc.json;
  const companyId: string | undefined = location?.companyId;
  record({ id: "location", resource: "locations", endpoint: "GET /locations/{id}", scope: "locations.readonly",
    status: loc.status, versionUsed: loc.version, tried: loc.tried,
    fieldsPresent: location ? presence([location], ["companyId", "timezone", "name"]) : undefined,
    notes: [location?.timezone ? `timezone=${location.timezone}` : "", errMsg(loc)] });

  // 2. Users -------------------------------------------------------------
  let users: any[] = [];
  if (companyId) {
    const u = await call(`/users/search?companyId=${companyId}&locationId=${LOCATION_ID}&limit=100`);
    users = u.json?.users ?? [];
    record({ id: "users", resource: "users", endpoint: "GET /users/search", scope: "users.readonly",
      status: u.status, versionUsed: u.version, tried: u.tried, count: users.length, keys: keyUnion(users),
      fieldsPresent: presence(users, ["id", "name", "email", "roles.role", "roles.type"]),
      enums: { "roles.role": tally(users.map((x) => x.roles?.role)), "roles.type": tally(users.map((x) => x.roles?.type)) },
      notes: [`total=${u.json?.count ?? u.json?.total ?? "?"}`, errMsg(u)] });
  } else {
    record({ id: "users", resource: "users", endpoint: "GET /users/search", scope: "users.readonly",
      status: null, versionUsed: null, notes: ["companyId indisponível — não foi possível consultar usuários."] });
  }
  const userIds = new Set(users.map((u) => u.id));

  // 3. Contacts search (+ paginação searchAfter) --------------------------
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const body = (extra: Record<string, unknown> = {}) => ({
    locationId: LOCATION_ID, pageLimit: 100,
    filters: [{ field: "dateUpdated", operator: "range", value: { gte: since } }],
    sort: [{ field: "dateUpdated", direction: "asc" }], ...extra,
  });
  const c1 = await call(`/contacts/search`, { method: "POST", body: body() });
  const contacts: any[] = c1.json?.contacts ?? [];
  let cPag: Check["pagination"] = { tested: false, ok: null, detail: "menos de 1 página — paginação não exercitada" };
  if (contacts.length === 100) {
    const sa = contacts[99]?.searchAfter;
    if (!Array.isArray(sa)) cPag = { tested: true, ok: false, detail: "contato sem campo searchAfter" };
    else {
      const c2 = await call(`/contacts/search`, { method: "POST", body: body({ searchAfter: sa }) });
      const p2: any[] = c2.json?.contacts ?? [];
      const overlap = p2.filter((x) => contacts.some((y) => y.id === x.id)).length;
      cPag = { tested: true, ok: ok(c2.status) && overlap === 0, detail: `página 2: HTTP ${c2.status}, n=${p2.length}, repetidos=${overlap}` };
    }
  }
  const phones = contacts.map((c) => (typeof c.phone === "string" ? c.phone.replace(/\D/g, "") : "")).filter((p) => p.length >= 8);
  const dupPhones = phones.length - new Set(phones).size;
  record({ id: "contacts.search", resource: "contacts", endpoint: "POST /contacts/search", scope: "contacts.readonly",
    status: c1.status, versionUsed: c1.version, tried: c1.tried, count: contacts.length, keys: keyUnion(contacts),
    fieldsPresent: presence(contacts, ["id", "dateAdded", "dateUpdated", "assignedTo", "followers", "source", "type",
      "attributionSource", "attributionSource.utmCampaign", "attributionSource.medium", "phone", "email", "searchAfter"]),
    enums: { source: tally(contacts.map((c) => c.source)), type: tally(contacts.map((c) => c.type)),
      "attributionSource.medium": tally(contacts.map((c) => c.attributionSource?.medium)) },
    pagination: cPag,
    notes: [`total (atualizados 30d) = ${c1.json?.total ?? "?"}`,
      `D2: telefones repetidos na amostra = ${dupPhones}`,
      `seguidores fora da lista de usuários = ${contacts.flatMap((c) => c.followers ?? []).filter((f: string) => !userIds.has(f)).length}`,
      errMsg(c1)] });

  const sampleContact = contacts.find((c) => (c.followers ?? []).length) ?? contacts[0];

  // 4. Contact detail + tasks -------------------------------------------
  if (sampleContact) {
    const cd = await call(`/contacts/${sampleContact.id}`);
    const c = cd.json?.contact ?? cd.json;
    record({ id: "contacts.get", resource: "contacts", endpoint: "GET /contacts/{id}", scope: "contacts.readonly",
      status: cd.status, versionUsed: cd.version, tried: cd.tried, keys: c ? keyUnion([c]) : undefined,
      fieldsPresent: c ? presence([c], ["assignedTo", "followers", "dateAdded", "dateUpdated", "customFields", "source"]) : undefined,
      notes: [errMsg(cd)] });
    const tk = await call(`/contacts/${sampleContact.id}/tasks`);
    record({ id: "contacts.tasks", resource: "contacts", endpoint: "GET /contacts/{id}/tasks", scope: "contacts.readonly",
      status: tk.status, versionUsed: tk.version, tried: tk.tried, count: (tk.json?.tasks ?? []).length,
      keys: keyUnion(tk.json?.tasks ?? []), notes: [errMsg(tk)] });
  }

  // 5. Conversations (+ paginação startAfterDate) -------------------------
  const cvQ = `/conversations/search?locationId=${LOCATION_ID}&limit=50&sortBy=last_message_date&sort=desc`;
  const cv1 = await call(cvQ);
  const convs: any[] = cv1.json?.conversations ?? [];
  let cvPag: Check["pagination"] = { tested: false, ok: null, detail: "menos de 1 página" };
  if (convs.length === 50) {
    const last = convs[49];
    const cursor = Array.isArray(last?.sort) ? last.sort[0] : last?.lastMessageDate;
    if (cursor === undefined) cvPag = { tested: true, ok: false, detail: "sem sort[] nem lastMessageDate para cursor" };
    else {
      const cv2 = await call(`${cvQ}&startAfterDate=${encodeURIComponent(String(cursor))}`);
      const p2: any[] = cv2.json?.conversations ?? [];
      const overlap = p2.filter((x) => convs.some((y) => y.id === x.id)).length;
      cvPag = { tested: true, ok: ok(cv2.status) && overlap === 0, detail: `página 2: HTTP ${cv2.status}, n=${p2.length}, repetidos=${overlap}, cursor=${Array.isArray(last?.sort) ? "sort[0]" : "lastMessageDate"}` };
    }
  }
  const lmTypes = tally(convs.map((c) => typeof c.lastMessageDate));
  record({ id: "conversations.search", resource: "conversations", endpoint: "GET /conversations/search", scope: "conversations.readonly",
    status: cv1.status, versionUsed: cv1.version, tried: cv1.tried, count: convs.length, keys: keyUnion(convs),
    fieldsPresent: presence(convs, ["id", "contactId", "lastMessageDate", "lastMessageDirection", "lastMessageType", "assignedTo", "followers", "unreadCount", "type", "dateUpdated", "sort"]),
    enums: { lastMessageDirection: tally(convs.map((c) => c.lastMessageDirection)), type: tally(convs.map((c) => c.type)), "typeof lastMessageDate": lmTypes },
    pagination: cvPag, notes: [`total = ${cv1.json?.total ?? "?"}`, errMsg(cv1)] });

  // 6. Messages (amostra de até 10 conversas + paginação lastMessageId) ----
  const msgs: any[] = [];
  let mLast: CallResult | null = null, order = "indeterminado";
  let mPag: Check["pagination"] = { tested: false, ok: null, detail: "nenhuma conversa com mais de 1 página na amostra" };
  for (const cv of convs.slice(0, 10)) {
    const m = await call(`/conversations/${cv.id}/messages?limit=50`);
    mLast = m;
    const box = m.json?.messages ?? {};
    const list: any[] = Array.isArray(box) ? box : (box.messages ?? []);
    msgs.push(...list);
    if (list.length >= 2 && order === "indeterminado") {
      order = Date.parse(list[0].dateAdded) >= Date.parse(list[list.length - 1].dateAdded) ? "mais recente primeiro" : "mais antiga primeiro";
    }
    if (!mPag.tested && box.nextPage && box.lastMessageId) {
      const m2 = await call(`/conversations/${cv.id}/messages?limit=50&lastMessageId=${box.lastMessageId}`);
      const l2: any[] = m2.json?.messages?.messages ?? [];
      const overlap = l2.filter((x) => list.some((y) => y.id === x.id)).length;
      mPag = { tested: true, ok: ok(m2.status) && overlap === 0, detail: `página 2: HTTP ${m2.status}, n=${l2.length}, repetidos=${overlap}` };
    }
  }
  const outbound = msgs.filter((m) => m.direction === "outbound");
  record({ id: "conversations.messages", resource: "messages", endpoint: "GET /conversations/{id}/messages", scope: "conversations/message.readonly",
    status: mLast?.status ?? null, versionUsed: mLast?.version ?? null, tried: mLast?.tried, count: msgs.length, keys: keyUnion(msgs),
    fieldsPresent: presence(msgs, ["direction", "userId", "source", "dateAdded", "messageType", "status", "contactId"]),
    enums: {
      direction: tally(msgs.map((m) => m.direction)),
      "outbound.source": tally(outbound.map((m) => m.source)),
      "outbound.source × userId": tally(outbound.map((m) => `${m.source ?? "(vazio)"} | ${m.userId ? "com userId" : "sem userId"}`)),
      messageType: tally(msgs.map((m) => m.messageType)),
    },
    pagination: mPag,
    notes: [`ordem: ${order}`, "R3: 'outbound.source × userId' define o que conta como resposta humana", mLast ? errMsg(mLast) : "sem conversas"] });

  // 7. Pipelines (nomes de etapas: necessários para o mapeamento; não são PII) ---
  const pl = await call(`/opportunities/pipelines?locationId=${LOCATION_ID}`);
  const pipelines: any[] = pl.json?.pipelines ?? [];
  record({ id: "pipelines", resource: "pipelines", endpoint: "GET /opportunities/pipelines", scope: "opportunities.readonly",
    status: pl.status, versionUsed: pl.version, tried: pl.tried, count: pipelines.length,
    notes: [...pipelines.map((p) => `${p.name} [${p.id}]: ${(p.stages ?? []).map((s: any) => `${s.name} [${s.id}]`).join(" → ")}`), errMsg(pl)] });

  // 8. Opportunities (+ paginação startAfter/startAfterId + GET individual) ---
  const opQ = `/opportunities/search?locationId=${LOCATION_ID}&limit=100&status=all`;
  const op = await call(opQ);
  const opps: any[] = op.json?.opportunities ?? [];
  const meta = op.json?.meta ?? {};
  let oPag: Check["pagination"] = { tested: false, ok: null, detail: "menos de 1 página" };
  if (opps.length === 100) {
    if (meta.startAfter === undefined || !meta.startAfterId) oPag = { tested: true, ok: false, detail: `meta sem cursor: ${Object.keys(meta).join(",")}` };
    else {
      const op2 = await call(`${opQ}&startAfter=${meta.startAfter}&startAfterId=${meta.startAfterId}`);
      const p2: any[] = op2.json?.opportunities ?? [];
      const overlap = p2.filter((x) => opps.some((y) => y.id === x.id)).length;
      oPag = { tested: true, ok: ok(op2.status) && overlap === 0, detail: `página 2: HTTP ${op2.status}, n=${p2.length}, repetidos=${overlap}` };
    }
  }
  record({ id: "opportunities.search", resource: "opportunities", endpoint: "GET /opportunities/search", scope: "opportunities.readonly",
    status: op.status, versionUsed: op.version, tried: op.tried, count: opps.length, keys: keyUnion(opps),
    fieldsPresent: presence(opps, ["pipelineId", "pipelineStageId", "status", "assignedTo", "followers", "lastStageChangeAt", "lastStatusChangeAt", "lastActionDate", "lostReasonId", "source", "monetaryValue", "contactId", "createdAt", "updatedAt"]),
    enums: { status: tally(opps.map((o) => o.status)) }, pagination: oPag,
    notes: [`total = ${meta.total ?? "?"}`, `seguidores (opp) fora da lista de usuários = ${opps.flatMap((o) => o.followers ?? []).filter((f: string) => !userIds.has(f)).length}`, errMsg(op)] });
  if (opps[0]) {
    const og = await call(`/opportunities/${opps[0].id}`);
    const o = og.json?.opportunity ?? og.json;
    record({ id: "opportunities.get", resource: "opportunities", endpoint: "GET /opportunities/{id}", scope: "opportunities.readonly",
      status: og.status, versionUsed: og.version, tried: og.tried,
      fieldsPresent: o ? presence([o], ["status", "pipelineStageId", "lastStatusChangeAt", "followers"]) : undefined, notes: [errMsg(og)] });
  }

  // 9. Calendars + events -----------------------------------------------
  const cl = await call(`/calendars/?locationId=${LOCATION_ID}`);
  const calendars: any[] = cl.json?.calendars ?? [];
  record({ id: "calendars", resource: "calendars", endpoint: "GET /calendars/", scope: "calendars.readonly",
    status: cl.status, versionUsed: cl.version, tried: cl.tried, count: calendars.length, notes: [errMsg(cl)] });
  const events: any[] = [];
  let evLast: CallResult | null = null;
  const start = Date.now() - 30 * 86400000, end = Date.now() + 30 * 86400000;
  for (const cal of calendars.slice(0, 15)) {
    const ev = await call(`/calendars/events?locationId=${LOCATION_ID}&calendarId=${cal.id}&startTime=${start}&endTime=${end}`);
    evLast = ev;
    events.push(...(ev.json?.events ?? []));
  }
  record({ id: "calendars.events", resource: "events", endpoint: "GET /calendars/events", scope: "calendars/events.readonly",
    status: evLast?.status ?? null, versionUsed: evLast?.version ?? null, tried: evLast?.tried, count: events.length, keys: keyUnion(events),
    fieldsPresent: presence(events, ["appointmentStatus", "assignedUserId", "users", "contactId", "dateAdded", "dateUpdated", "startTime"]),
    enums: { appointmentStatus: tally(events.map((e) => e.appointmentStatus)) },
    notes: [calendars.length ? "" : "Nenhum calendário retornado — eventos não testados.", evLast ? errMsg(evLast) : ""] });

  // 10. Custom fields -----------------------------------------------------
  const cf = await call(`/locations/${LOCATION_ID}/customFields`);
  const fields: any[] = cf.json?.customFields ?? [];
  record({ id: "customFields", resource: "customFields", endpoint: "GET /locations/{id}/customFields", scope: "locations/customFields.readonly",
    status: cf.status, versionUsed: cf.version, tried: cf.tried, count: fields.length,
    notes: [...fields.slice(0, 60).map((f) => `${f.name} (${f.dataType})`), errMsg(cf)] });

  buildMatrix(contacts, convs, msgs, opps, events, users);

  mkdirSync("reports", { recursive: true });
  const file = `reports/validation-${LOCATION_ID}-${report.startedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log("\nMATRIZ DE DISPONIBILIDADE");
  for (const m of report.matrix) console.log(`  ${m.status.padEnd(13)} ${m.item.padEnd(42)} ${m.evidence}`);
  console.log(`\nRate limit observado:`, report.rateLimit);
  console.log(`Versões comprovadas:`, report.versions);
  console.log(`Relatório: ${file}`);
  const failed = report.checks.filter((c) => !c.ok);
  if (failed.length) console.log(`\n${failed.length} verificação(ões) falharam: ${failed.map((c) => c.id).join(", ")}`);
}

function buildMatrix(contacts: any[], convs: any[], msgs: any[], opps: any[], events: any[], users: any[]) {
  const chk = (id: string) => report.checks.find((c) => c.id === id);
  const frac = (rows: any[], f: string) => { const n = rows.filter((r) => { const v = get(r, f); return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length); }).length; return { n, t: rows.length }; };
  const row = (item: string, checkId: string, rows: any[], field: string | null, extra = "") => {
    const c = chk(checkId);
    if (!c) return report.matrix.push({ item, status: "não testado", evidence: "" });
    if (!c.ok) return report.matrix.push({ item, status: "indisponível", evidence: `HTTP ${c.status} ${c.notes[0] ?? ""}` });
    if (!field) return report.matrix.push({ item, status: "comprovado", evidence: `HTTP ${c.status}, n=${c.count ?? "-"} ${extra}` });
    const { n, t } = frac(rows, field);
    const status: Avail = t === 0 ? "não testado" : n === t ? "comprovado" : n > 0 ? "parcial" : "indisponível";
    report.matrix.push({ item, status, evidence: `${field}: ${n}/${t} ${extra}`.trim() });
  };
  row("Lead: data de entrada (dateAdded)", "contacts.search", contacts, "dateAdded");
  row("Lead: origem (source)", "contacts.search", contacts, "source");
  row("Lead: campanha (UTM)", "contacts.search", contacts, "attributionSource.utmCampaign", "(depende de preenchimento)");
  row("Lead: responsável (assignedTo)", "contacts.search", contacts, "assignedTo", "(ausência pode ser lead sem responsável)");
  row("Lead: seguidores (followers)", "contacts.search", contacts, "followers", "(ausência pode ser real)");
  row("Lead: tipo (type) p/ D2", "contacts.search", contacts, "type");
  row("Conversa: data da última mensagem", "conversations.search", convs, "lastMessageDate");
  row("Conversa: responsável", "conversations.search", convs, "assignedTo");
  row("Mensagem: direção", "conversations.messages", msgs, "direction");
  row("Mensagem: source (humano × automação)", "conversations.messages", msgs.filter((m) => m.direction === "outbound"), "source");
  row("Mensagem: autor (userId) em outbound", "conversations.messages", msgs.filter((m) => m.direction === "outbound"), "userId");
  row("Pipelines e etapas reais", "pipelines", [], null);
  row("Oportunidade: etapa", "opportunities.search", opps, "pipelineStageId");
  row("Oportunidade: horário da mudança de etapa", "opportunities.search", opps, "lastStageChangeAt");
  row("Oportunidade: horário da mudança de status", "opportunities.search", opps, "lastStatusChangeAt");
  row("Oportunidade: seguidores", "opportunities.search", opps, "followers", "(ausência pode ser real)");
  row("Agendamento: status (confirmado/compareceu)", "calendars.events", events, "appointmentStatus");
  row("Agendamento: responsável", "calendars.events", events, "assignedUserId");
  row("Usuários (SDRs/vendedores)", "users", users, "id", "(papel SDR/vendedor: cadastro manual)");
  for (const [id, c] of [["Paginação contatos", chk("contacts.search")], ["Paginação conversas", chk("conversations.search")], ["Paginação mensagens", chk("conversations.messages")], ["Paginação oportunidades", chk("opportunities.search")]] as const) {
    const p = c?.pagination;
    report.matrix.push({ item: id, status: !p?.tested ? "não testado" : p.ok ? "comprovado" : "indisponível", evidence: p?.detail ?? "" });
  }
  report.matrix.push({ item: "Histórico de responsável/seguidor/etapa", status: "indisponível", evidence: "API fornece só o estado atual → captura própria a partir do H0" });
}

main().catch((e) => {
  console.error("Falha inesperada:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
