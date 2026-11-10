/**
 * Testes da LÓGICA de sync/histórico com um cliente falso e payloads montados à mão.
 * NÃO são resultados da API real — a validação real é feita por `npm run validate`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/pglite.ts";
import type { LcApi } from "../src/integrations/leadconnector/client.ts";
import { RateLimiter } from "../src/integrations/leadconnector/rate-limiter.ts";
import type { SyncContext, UnitRow } from "../src/sync/context.ts";
import { syncContacts } from "../src/sync/contacts.ts";
import { syncConversations } from "../src/sync/conversations.ts";
import { syncOpportunities } from "../src/sync/opportunities.ts";
import { createLogger } from "../src/lib/log.ts";
import { executeJob } from "../src/worker/unit-runner.ts";
import { LcError } from "../src/integrations/leadconnector/errors.ts";

type Handler = (path: string, q: any, body: any) => any;
function fakeApi(handler: Handler): LcApi {
  const stats = { requests: 0, lastStatus: 200 };
  return {
    locationId: "LOC", stats, limiter: new RateLimiter(1000, 1000),
    async get(_r, path, q) { stats.requests++; return handler(path, q, undefined); },
    async post(_r, path, body) { stats.requests++; return handler(path, undefined, body); },
  };
}

async function setupUnit(db: any, slug: string, loc: string): Promise<UnitRow> {
  const r = await db.query(
    `insert into units (slug,name,location_id,history_since,connection_status) values ($1,$1,$2, now() - interval '1 hour','ok') returning *`, [slug, loc]);
  return r.rows[0];
}
const ctxOf = (db: any, unit: UnitRow, api: LcApi): SyncContext => ({ db, unit, api, log: createLogger({ test: true }), now: () => new Date() });
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } } as any;

test("contatos: snapshot inicial, depois troca de responsável e vendedor seguidor viram histórico", async () => {
  const { db } = await createTestDb();
  const unit = await setupUnit(db, "carros-online", "LOC");
  await db.query(`insert into crm_users (unit_id, crm_id, name, operational_role) values ($1,'sdr1','S','sdr'),($1,'sdr2','S2','sdr'),($1,'vend1','V','seller')`, [unit.id]);

  let state = { id: "c1", dateAdded: new Date().toISOString(), dateUpdated: new Date().toISOString(), assignedTo: "sdr1", followers: [] as string[], phone: "+55 11 99999-0000" };
  const api = fakeApi((path) => { assert.equal(path, "/contacts/search"); return { contacts: [state], total: 1 }; });
  const ctx = ctxOf(db, unit, api);

  await syncContacts(ctx);
  let h = await db.query(`select time_source, to_user from contact_assignment_history`);
  assert.deepEqual(h.rows, [{ time_source: "snapshot", to_user: "sdr1" }]);

  // SDR adiciona vendedor como seguidor e lead é reatribuído
  state = { ...state, assignedTo: "sdr2", followers: ["vend1"], dateUpdated: new Date(Date.now() + 1000).toISOString() };
  const res = await syncContacts(ctx);
  assert.equal(res.changes, 2);
  h = await db.query(`select from_user, to_user, time_source from contact_assignment_history where time_source='detected'`);
  assert.deepEqual(h.rows, [{ from_user: "sdr1", to_user: "sdr2", time_source: "detected" }]);
  const f = await db.query(`select user_id, action from contact_follower_history`);
  assert.deepEqual(f.rows, [{ user_id: "vend1", action: "added" }]);
  const hand = await db.query(`select seller_user_id, responsible_at_detection, status from seller_handoffs`);
  assert.deepEqual(hand.rows, [{ seller_user_id: "vend1", responsible_at_detection: "sdr2", status: "awaiting_seller" }],
    "seguidor vendedor = handoff pendente, NÃO transferência concluída");

  // Reprocessar o mesmo estado (overlap do cursor) não duplica nada
  await syncContacts(ctx);
  assert.equal((await db.query(`select count(*)::int n from contact_follower_history`)).rows[0].n, 1);
});

test("conversas: mensagem humana do vendedor fecha o handoff; automação não conta como resposta", async () => {
  const { db } = await createTestDb();
  const unit = await setupUnit(db, "carros-online", "LOC");
  await db.query(`insert into crm_users (unit_id, crm_id, operational_role) values ($1,'vend1','seller')`, [unit.id]);
  const t0 = Date.now() - 30 * 60_000;
  await db.query(`insert into contacts (unit_id, crm_id, date_added, assigned_to, followers) values ($1,'c1',$2,'sdr1','{vend1}')`, [unit.id, new Date(t0).toISOString()]);
  await db.query(`insert into seller_handoffs (unit_id, contact_id, seller_user_id, added_at, observed_after) values ($1,'c1','vend1',$2,$2)`, [unit.id, new Date(t0).toISOString()]);

  const iso = (m: number) => new Date(t0 + m * 60_000).toISOString();
  // Formato espelha o observado no piloto: eventos de sistema chegam como outbound + source=app.
  const messages = [
    { id: "m4", direction: "outbound", source: "app", userId: "vend1", messageType: "TYPE_WHATSAPP", dateAdded: iso(20) },
    { id: "m3", direction: "inbound", messageType: "TYPE_WHATSAPP", dateAdded: iso(10) },
    { id: "a2", direction: "outbound", source: "app", messageType: "TYPE_INTERNAL_COMMENT", userId: "sdr1", dateAdded: iso(4) },
    { id: "a1", direction: "outbound", source: "app", messageType: "TYPE_ACTIVITY_OPPORTUNITY", dateAdded: iso(3) },
    { id: "m2", direction: "outbound", source: "workflow", messageType: "TYPE_WHATSAPP", dateAdded: iso(2) },
    { id: "m1", direction: "inbound", messageType: "TYPE_WHATSAPP", dateAdded: iso(1) },
  ];
  const api = fakeApi((path) => {
    if (path === "/conversations/search") return { conversations: [{ id: "cv1", contactId: "c1", lastMessageDate: t0 + 20 * 60_000 }], total: 1 };
    if (path === "/conversations/cv1/messages") return { messages: { messages, nextPage: false, lastMessageId: "m1" } };
    throw new Error("rota inesperada " + path);
  });
  await syncConversations(ctxOf(db, unit, api));

  const c = (await db.query(`select first_human_reply_by, waiting_on, first_human_reply_at = $1::timestamptz as ok from contacts where crm_id='c1'`, [iso(20)])).rows[0];
  assert.equal(c.first_human_reply_by, "vend1");
  assert.equal(c.ok, true, "workflow (min 2), atividade de oportunidade (min 3) e comentário interno (min 4) não são primeira resposta");
  assert.equal(c.waiting_on, "customer");
  const h = (await db.query(`select status, first_seller_action from seller_handoffs`)).rows[0];
  assert.deepEqual(h, { status: "seller_acted", first_seller_action: "message" });
  const human = (await db.query(`select crm_id, kind, is_human from messages where direction='outbound' order by crm_id`)).rows;
  assert.deepEqual(human, [
    { crm_id: "a1", kind: "activity", is_human: false },
    { crm_id: "a2", kind: "internal", is_human: false },
    { crm_id: "m2", kind: "message", is_human: false },
    { crm_id: "m4", kind: "message", is_human: true },
  ]);
});

test("oportunidades: mudança de etapa usa o horário exato do CRM (lastStageChangeAt)", async () => {
  const { db } = await createTestDb();
  const unit = await setupUnit(db, "carros-online", "LOC");
  let opp: any = { id: "o1", contactId: "c1", pipelineId: "p1", pipelineStageId: "s1", status: "open", followers: [],
    lastStageChangeAt: "2026-11-01T10:00:00.000Z", createdAt: "2026-11-01T10:00:00.000Z" };
  const api = fakeApi((path) => {
    if (path === "/opportunities/search") return { opportunities: [opp], meta: { total: 1 } };
    throw new Error("rota inesperada " + path);
  });
  const ctx = ctxOf(db, unit, api);
  await syncOpportunities(ctx);                // backfill
  opp = { ...opp, pipelineStageId: "s2", lastStageChangeAt: "2026-11-06T12:34:00.000Z" };
  await syncOpportunities(ctx);                // regime (open_scan)
  const h = (await db.query(`select old_value, new_value, time_source, changed_at = '2026-11-06T12:34:00Z'::timestamptz as exact
    from opportunity_history where field='stage' and time_source <> 'snapshot'`)).rows;
  assert.deepEqual(h, [{ old_value: "s1", new_value: "s2", time_source: "crm_field", exact: true }]);
});

test("isolamento: mesmo crm_id em duas unidades não se mistura", async () => {
  const { db } = await createTestDb();
  const a = await setupUnit(db, "carros-online", "LOC-A");
  const b = await setupUnit(db, "matriz", "LOC-B");
  const mk = (assigned: string) => fakeApi(() => ({ contacts: [{ id: "same", dateAdded: new Date().toISOString(), dateUpdated: new Date().toISOString(), assignedTo: assigned }] }));
  await syncContacts(ctxOf(db, a, mk("userA")));
  await syncContacts(ctxOf(db, b, mk("userB")));
  const r = await db.query(`select u.slug, c.assigned_to from contacts c join units u on u.id=c.unit_id order by u.slug`);
  assert.deepEqual(r.rows, [{ slug: "carros-online", assigned_to: "userA" }, { slug: "matriz", assigned_to: "userB" }]);
});

test("monitoramento: 401 marca SÓ a unidade afetada como erro, grava log sanitizado e abre alerta crítico", async () => {
  const { db } = await createTestDb();
  const a = await setupUnit(db, "carros-online", "LOC-A");
  const b = await setupUnit(db, "matriz", "LOC-B");
  const failing = fakeApi(() => { throw new LcError("auth", 401, "/contacts/search", "Bearer pit-abcdef123456789 invalid"); });
  await db.query(`insert into jobs (unit_id, kind) values ($1,'contacts')`, [a.id]);
  const job = (await db.query(`select * from claim_job($1)`, [a.id])).rows[0];
  await executeJob(db, a, failing, silent, job);

  const units = (await db.query(`select slug, connection_status from units order by slug`)).rows;
  assert.deepEqual(units, [{ slug: "carros-online", connection_status: "error" }, { slug: "matriz", connection_status: "ok" }]);
  const log = (await db.query(`select status, error_class, http_status, error from sync_logs`)).rows[0];
  assert.equal(log.error_class, "auth");
  assert.equal(log.http_status, 401);
  assert.ok(!log.error.includes("abcdef123456789"), "token nunca pode ir para o log");
  const j = (await db.query(`select status from jobs where id=$1`, [job.id])).rows[0];
  assert.equal(j.status, "failed", "erro de autenticação não fica tentando à toa");
  const al = (await db.query(`select priority, rule_key from operational_alerts`)).rows;
  assert.deepEqual(al, [{ priority: "critical", rule_key: "integracao_falhando" }]);
});

test("B1: duplicado é detectado mesmo quando o contato mais antigo chega depois", async () => {
  const { db } = await createTestDb();
  const unit = await setupUnit(db, "carros-online", "LOC");
  // O sync ordena por dateUpdated: o lead novo chega antes do antigo (caso real de backfill).
  const novo = { id: "novo", phone: "+55 11 90000-0001", dateAdded: "2026-11-01T10:00:00Z", dateUpdated: "2026-11-01T10:00:00Z" };
  const antigo = { id: "antigo", phone: "(11) 90000-0001", dateAdded: "2026-01-01T10:00:00Z", dateUpdated: "2026-11-05T10:00:00Z" };
  await syncContacts(ctxOf(db, unit, fakeApi(() => ({ contacts: [novo, antigo] }))));
  const r = (await db.query(`select crm_id, origin_class, duplicate_of from contacts order by crm_id`)).rows;
  assert.deepEqual(r, [
    { crm_id: "antigo", origin_class: "unclassified", duplicate_of: null },
    { crm_id: "novo", origin_class: "duplicate", duplicate_of: "antigo" },
  ]);
});

test("B1: telefone corrigido no CRM desfaz a duplicidade", async () => {
  const { db } = await createTestDb();
  const unit = await setupUnit(db, "carros-online", "LOC");
  const antigo = { id: "antigo", phone: "11900000001", dateAdded: "2026-01-01T10:00:00Z", dateUpdated: "2026-11-01T10:00:00Z" };
  let novo: any = { id: "novo", phone: "11900000001", dateAdded: "2026-11-01T10:00:00Z", dateUpdated: "2026-11-02T10:00:00Z" };
  const api = fakeApi(() => ({ contacts: [antigo, novo] }));
  await syncContacts(ctxOf(db, unit, api));
  novo = { ...novo, phone: "11911112222", dateUpdated: "2026-11-03T10:00:00Z" };
  await syncContacts(ctxOf(db, unit, api));
  const r = (await db.query(`select origin_class, duplicate_of from contacts where crm_id='novo'`)).rows[0];
  assert.deepEqual(r, { origin_class: "unclassified", duplicate_of: null });
});

test("D2: importação usa attributionSource.medium quando `source` vem vazio (comportamento real do CRM)", async () => {
  const { db } = await createTestDb();
  const unit = await setupUnit(db, "carros-online", "LOC");
  await db.query(`update units set settings = '{"import_sources":["csv_import"]}' where id=$1`, [unit.id]);
  unit.settings = { import_sources: ["csv_import"] };
  const mk = (id: string, medium: string, phone: string) => ({ id, phone, attributionSource: { medium }, dateAdded: "2026-11-01T10:00:00Z", dateUpdated: "2026-11-01T10:00:00Z" });
  await syncContacts(ctxOf(db, unit, fakeApi(() => ({ contacts: [mk("a", "csv_import", "11911110001"), mk("b", "whatsapp", "11911110002")] }))));
  const r = (await db.query(`select crm_id, origin_class from contacts order by crm_id`)).rows;
  assert.deepEqual(r, [{ crm_id: "a", origin_class: "imported" }, { crm_id: "b", origin_class: "new" }]);
});

test("B2: mensagem do cliente não zera o tempo parado; espera da equipe começa na 1ª mensagem sem resposta", async () => {
  const { db } = await createTestDb();
  const unit = await setupUnit(db, "carros-online", "LOC");
  await db.query(`insert into contacts (unit_id,crm_id,date_added) values ($1,'c', now() - interval '3 days')`, [unit.id]);
  await db.query(`insert into messages (unit_id,crm_id,conversation_id,contact_id,direction,is_human,date_added) values
    ($1,'m1','cv','c','outbound',true, now() - interval '2 days'),
    ($1,'m2','cv','c','inbound',null, now() - interval '30 minutes'),
    ($1,'m3','cv','c','inbound',null, now() - interval '5 minutes')`, [unit.id]);
  await db.query(`select refresh_contact_derived($1,'c')`, [unit.id]);
  const c = (await db.query(`select waiting_on,
      round(extract(epoch from now()-last_operational_activity_at)/3600) as horas_sem_acao_equipe,
      round(extract(epoch from now()-waiting_since)/60) as min_esperando,
      round(extract(epoch from now()-last_any_activity_at)/60) as min_ultima_movimentacao
    from contacts`)).rows[0];
  assert.equal(c.waiting_on, "team");
  assert.equal(Number(c.horas_sem_acao_equipe), 48, "equipe sem agir há 2 dias");
  assert.equal(Number(c.min_esperando), 30, "cliente esperando desde a 1ª mensagem não respondida");
  assert.equal(Number(c.min_ultima_movimentacao), 5);
});

test("B6: funções de escrita não podem ser chamadas por usuário autenticado (API pública)", async () => {
  const { pg, db } = await createTestDb();
  const unit = await setupUnit(db, "carros-online", "LOC");
  await pg.exec(`set role authenticated`);
  for (const sql of [`select * from claim_job('${unit.id}')`, `select refresh_contact_derived('${unit.id}','x')`, `select rebuild_seller_handoffs('${unit.id}')`]) {
    await assert.rejects(db.query(sql), /permission denied/, sql);
  }
  await pg.exec(`reset role`);
});

test("normalizePhone: mesmo número BR com/sem código do país e com 0 de discagem", async () => {
  const { normalizePhone } = await import("../src/lib/normalize.ts");
  for (const p of ["+55 11 90000-0001", "(11) 90000-0001", "011 90000-0001", "5511900000001"]) {
    assert.equal(normalizePhone(p), "5511900000001", p);
  }
  assert.equal(normalizePhone("+1 415 555 0100"), "14155550100");
  assert.equal(normalizePhone("123"), null);
});

test("pistas: mesma chave em sequência e na ordem; resultados na ordem original", async () => {
  const { runInLanes } = await import("../src/lib/lanes.ts");
  const log: string[] = [];
  const items = ["a1", "b1", "a2", "c1", "a3", "b2"];
  const out = await runInLanes(items, 4, (s) => s[0], async (s) => {
    log.push(`start ${s}`); await new Promise((r) => setTimeout(r, s.startsWith("a") ? 15 : 1)); log.push(`end ${s}`); return s.toUpperCase();
  });
  assert.deepEqual(out, ["A1", "B1", "A2", "C1", "A3", "B2"]);
  const aEvents = log.filter((x) => x.endsWith("a1") || x.endsWith("a2") || x.endsWith("a3"));
  assert.deepEqual(aEvents, ["start a1", "end a1", "start a2", "end a2", "start a3", "end a3"], "mesma chave nunca em paralelo");
});

test("mensagens em lote: id repetido na mesma página não quebra; reprocessar não duplica", async () => {
  const { db } = await createTestDb();
  const unit = await setupUnit(db, "carros-online", "LOC");
  const t = Date.now() - 60_000;
  const msgs = [
    { id: "m2", direction: "outbound", source: "app", userId: "u", messageType: "TYPE_WHATSAPP", dateAdded: new Date(t).toISOString() },
    { id: "m2", direction: "outbound", source: "app", userId: "u", messageType: "TYPE_WHATSAPP", dateAdded: new Date(t).toISOString() },
    { id: "m1", direction: "inbound", messageType: "TYPE_WHATSAPP", dateAdded: new Date(t - 1000).toISOString() },
  ];
  let lmd = t;
  const api = fakeApi((path) => path === "/conversations/search"
    ? { conversations: [{ id: "cv", contactId: "c", lastMessageDate: lmd }] }
    : { messages: { messages: msgs, nextPage: false } });
  await syncConversations(ctxOf(db, unit, api));
  lmd = t + 1; // conversa "mudou" → busca mensagens de novo
  await syncConversations(ctxOf(db, unit, api));
  assert.equal((await db.query(`select count(*)::int n from messages`)).rows[0].n, 2);
});

test("resiliência: falha do banco fora de um job não derruba o loop da unidade", async () => {
  const { db } = await createTestDb();
  const unit = await setupUnit(db, "carros-online", "LOC");
  let failures = 2;
  const flaky = { ...db, query: async (text: string, params?: unknown[]) => {
    if (failures > 0 && text.includes("from units where id")) { failures--; throw new Error("getaddrinfo ENOTFOUND pooler"); }
    return db.query(text, params);
  } } as any;
  const api = fakeApi(() => ({ location: { companyId: "co" } }));
  const { runUnit } = await import("../src/worker/unit-runner.ts");
  await runUnit(flaky, unit, api, silent, { once: true, retryBaseMs: 1 });
  assert.equal(failures, 0, "as duas falhas foram absorvidas");
  const health = (await db.query(`select status from jobs where kind='health'`)).rows;
  assert.deepEqual(health, [{ status: "done" }], "depois das falhas, o loop seguiu e executou o health");
});

test("retomada: jobs e logs 'running' de um processo morto voltam à fila na hora", async () => {
  const { db } = await createTestDb();
  const unit = await setupUnit(db, "carros-online", "LOC");
  const j = (await db.query(`insert into jobs (unit_id, kind, status, locked_at) values ($1,'conversations','running', now()) returning id`, [unit.id])).rows[0];
  await db.query(`insert into sync_logs (unit_id, job_id, resource, status) values ($1,$2,'conversations','running')`, [unit.id, j.id]);
  const { recoverInterrupted } = await import("../src/worker/unit-runner.ts");
  assert.equal(await recoverInterrupted(db, unit.id), 1);
  assert.equal((await db.query(`select status from jobs where id=$1`, [j.id])).rows[0].status, "queued");
  assert.equal((await db.query(`select status from sync_logs`)).rows[0].status, "error");
});

test("intercalação: continuação de carga longa vai para depois do 1º ciclo dos outros recursos", async () => {
  const { JOBS, CONTINUATION_PRIORITY_OFFSET } = await import("../src/worker/jobs.ts");
  const contConversations = JOBS.conversations.priority + CONTINUATION_PRIORITY_OFFSET;
  for (const k of ["contacts", "opportunities", "appointments"] as const) {
    assert.ok(JOBS[k].priority < contConversations, `${k} antes da continuação das conversas`);
  }
});
