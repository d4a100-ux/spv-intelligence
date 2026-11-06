import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/pglite.ts";

test("migration aplica sem erros e cria as tabelas obrigatórias", async () => {
  const { db } = await createTestDb();
  const { rows } = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema='public'`);
  const names = new Set(rows.map((r) => r.table_name));
  for (const t of ["units",
    "crm_users","contacts","conversations","messages","opportunities","pipelines","pipeline_stages",
    "opportunity_history","appointments","tasks","crm_events","operational_alerts","sync_logs",
    "metric_snapshots","seller_handoffs","appointment_history","contact_follower_history",
    "contact_assignment_history","jobs","unit_holidays"]) {
    assert.ok(names.has(t), `tabela ausente: ${t}`);
  }
});

test("business_minutes: NULL sem horário configurado; respeita janelas, fuso e feriados", async () => {
  const { db } = await createTestDb();
  const { rows: [u] } = await db.query(`insert into units (slug,name,location_id) values ('t','T','L1') returning id`);
  const none = await db.query(`select business_minutes($1,'2026-11-09T11:00:00Z','2026-11-09T12:00:00Z') v`, [u.id]);
  assert.equal(none.rows[0].v, null, "sem horário → indisponível (null), nunca zero");

  await db.query(`update units set business_hours = '{"mon":[["08:00","12:00"],["13:00","18:00"]]}' where id=$1`, [u.id]);
  // 09/11/2026 é segunda. 11:00Z..17:00Z = 08:00..14:00 em São Paulo (UTC-3) → 4h manhã + 1h tarde = 300 min
  const r = await db.query(`select business_minutes($1,'2026-11-09T11:00:00Z','2026-11-09T17:00:00Z') v`, [u.id]);
  assert.equal(Number(r.rows[0].v), 300);
  // domingo sem janela → 0
  const sun = await db.query(`select business_minutes($1,'2026-11-08T12:00:00Z','2026-11-08T20:00:00Z') v`, [u.id]);
  assert.equal(Number(sun.rows[0].v), 0);
  // feriado zera a segunda
  await db.query(`insert into unit_holidays (unit_id, day) values ($1,'2026-11-09')`, [u.id]);
  const hol = await db.query(`select business_minutes($1,'2026-11-09T11:00:00Z','2026-11-09T17:00:00Z') v`, [u.id]);
  assert.equal(Number(hol.rows[0].v), 0);
});

test("RLS: gestor só enxerga as unidades liberadas; tokens e jobs inacessíveis", async () => {
  const { pg, db } = await createTestDb();
  const a = (await db.query(`insert into units (slug,name,location_id) values ('a','A','LA') returning id`)).rows[0].id;
  const b = (await db.query(`insert into units (slug,name,location_id) values ('b','B','LB') returning id`)).rows[0].id;
  for (const [u, id] of [[a, "ca"], [b, "cb"]]) {
    await db.query(`insert into contacts (unit_id, crm_id, name) values ($1,$2,'x')`, [u, id]);
  }
  await db.query(`insert into integration_credentials (unit_id, token_ciphertext, token_iv, token_tag, token_last4)
                  values ($1,'\\x00','\\x00','\\x00','1234')`, [a]);
  const uid = "11111111-1111-1111-1111-111111111111";
  await db.query(`insert into auth.users (id) values ($1)`, [uid]);
  await db.query(`insert into app_users (id, role) values ($1,'manager')`, [uid]);
  await db.query(`insert into app_user_units (app_user_id, unit_id) values ($1,$2)`, [uid, a]);

  await pg.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  const seen = await db.query(`select crm_id from contacts order by 1`);
  assert.deepEqual(seen.rows.map((r) => r.crm_id), ["ca"], "não pode ver contatos da unidade B");
  const creds = await db.query(`select * from integration_credentials`);
  assert.equal(creds.rows.length, 0, "tokens nunca visíveis ao usuário autenticado");
  const jobs = await db.query(`select * from jobs`);
  assert.equal(jobs.rows.length, 0);
  await pg.exec(`reset role;`);
});

test("claim_job isola a fila por unidade", async () => {
  const { db } = await createTestDb();
  const a = (await db.query(`insert into units (slug,name,location_id) values ('a','A','LA') returning id`)).rows[0].id;
  const b = (await db.query(`insert into units (slug,name,location_id) values ('b','B','LB') returning id`)).rows[0].id;
  await db.query(`insert into jobs (unit_id, kind) values ($1,'sync_contacts'),($2,'sync_contacts')`, [a, b]);
  const j = await db.query(`select * from claim_job($1)`, [a]);
  assert.equal(j.rows.length, 1);
  assert.equal(j.rows[0].unit_id, a);
  const again = await db.query(`select * from claim_job($1)`, [a]);
  assert.equal(again.rows.length, 0, "unidade A sem mais jobs");
  const jb = await db.query(`select * from claim_job($1)`, [b]);
  assert.equal(jb.rows[0].unit_id, b, "unidade B não é afetada");
});

test("D2: duplicidade por telefone dentro da MESMA unidade apenas", async () => {
  const { db } = await createTestDb();
  const a = (await db.query(`insert into units (slug,name,location_id) values ('a','A','LA') returning id`)).rows[0].id;
  const b = (await db.query(`insert into units (slug,name,location_id) values ('b','B','LB') returning id`)).rows[0].id;
  await db.query(`insert into contacts (unit_id,crm_id,phone_normalized,date_added) values
    ($1,'old','5511999990000','2026-01-01'),($1,'new','5511999990000','2026-02-01'),($2,'other','5511999990000','2025-01-01')`, [a, b]);
  await db.query(`select classify_contact_origin($1,'new')`, [a]);
  await db.query(`select classify_contact_origin($1,'old')`, [a]);
  const r = await db.query(`select crm_id, origin_class, duplicate_of from contacts where unit_id=$1 order by crm_id`, [a]);
  assert.deepEqual(r.rows, [
    { crm_id: "new", origin_class: "duplicate", duplicate_of: "old" },
    { crm_id: "old", origin_class: "unclassified", duplicate_of: null },
  ]);
});

test("D3: conversa ativa exige inbound E outbound humana na janela", async () => {
  const { db } = await createTestDb();
  const u = (await db.query(`insert into units (slug,name,location_id) values ('a','A','LA') returning id`)).rows[0].id;
  await db.query(`insert into conversations (unit_id,crm_id,contact_id) values ($1,'c1','k1'),($1,'c2','k2')`, [u]);
  await db.query(`insert into messages (unit_id,crm_id,conversation_id,contact_id,direction,is_human,date_added) values
    ($1,'m1','c1','k1','inbound',null, now()-interval '2 hours'),
    ($1,'m2','c1','k1','outbound',true, now()-interval '1 hour'),
    ($1,'m3','c2','k2','inbound',null, now()-interval '2 hours'),
    ($1,'m4','c2','k2','outbound',false, now()-interval '1 hour')`, [u]);
  const r = await db.query(`select conversation_id from v_active_conversations`);
  assert.deepEqual(r.rows.map((x) => x.conversation_id), ["c1"], "c2 só teve automação → não é ativa");
});
