/**
 * Monitoramento da integração (antes da interface existir).
 *   npm run status
 */
import { getDb, closeDb } from "../src/db/pg.ts";

async function main() {
  const db = getDb();
  const h = await db.query(
    `select slug, connection_status, consecutive_failures, last_sync_at, history_since, jobs_queued, jobs_failed_24h,
            sync_errors_1h, min_daily_remaining_1h, last_error from v_integration_health order by slug`);
  console.log("\n== Saúde por unidade ==");
  console.table(h.rows);

  const last = await db.query(
    `select distinct on (u.slug, s.resource) u.slug, s.resource, s.status, s.finished_at, s.requests, s.records_upserted,
            s.changes_detected, s.error_class, left(s.error, 80) as error
     from sync_logs s join units u on u.id=s.unit_id order by u.slug, s.resource, s.started_at desc`);
  console.log("== Última execução por recurso ==");
  console.table(last.rows);

  const vol = await db.query(
    `select u.slug,
       (select count(*) from contacts c where c.unit_id=u.id) contatos,
       (select count(*) from contacts c where c.unit_id=u.id and c.captured_live) contatos_pos_h0,
       (select count(*) from conversations c where c.unit_id=u.id) conversas,
       (select count(*) from messages m where m.unit_id=u.id) mensagens,
       (select count(*) from opportunities o where o.unit_id=u.id) oportunidades,
       (select count(*) from appointments a where a.unit_id=u.id) agendamentos,
       (select count(*) from contact_assignment_history x where x.unit_id=u.id and x.time_source<>'snapshot') mudancas_responsavel,
       (select count(*) from contact_follower_history x where x.unit_id=u.id and x.action<>'snapshot') mudancas_seguidor,
       (select count(*) from opportunity_history x where x.unit_id=u.id and x.time_source<>'snapshot') mudancas_oportunidade,
       (select count(*) from appointment_history x where x.unit_id=u.id and x.detected_by<>'backfill') eventos_agendamento,
       (select count(*) from seller_handoffs x where x.unit_id=u.id and x.status='awaiting_seller') vendedor_aguardando
     from units u order by u.slug`);
  console.log("== Volume capturado (mudanças excluem o snapshot inicial) ==");
  console.table(vol.rows);

  const alerts = await db.query(
    `select u.slug, a.priority, a.title, a.detected_at from operational_alerts a join units u on u.id=a.unit_id
     where a.rule_key='integracao_falhando' and a.status in ('open','acknowledged')`);
  if (alerts.rows.length) { console.log("== ALERTAS DE INTEGRAÇÃO ABERTOS =="); console.table(alerts.rows); }
  await closeDb();
}

main().catch(async (e) => { console.error("Falha:", e instanceof Error ? e.message : String(e)); await closeDb(); process.exit(1); });
