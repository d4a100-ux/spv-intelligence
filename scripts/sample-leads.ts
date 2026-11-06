/**
 * Amostra para conferência manual (passo 8 do guia piloto).
 *   npm run sample -- --unit carros-online [--n 20]
 * Gera reports/conferencia-<slug>-<data>.csv com link do CRM e os campos a comparar.
 * ATENÇÃO: o arquivo contém dados pessoais (nome/telefone) — fica só na sua máquina; não envie em chats.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { getDb, closeDb } from "../src/db/pg.ts";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const APP = (process.env.CRM_APP_URL ?? "https://app.gohighlevel.com").replace(/\/$/, "");

async function main() {
  const slug = arg("unit"); const n = Number(arg("n") ?? 20);
  if (!slug) throw new Error("Informe --unit <slug>");
  const db = getDb();
  const unit = (await db.query(`select id, location_id from units where slug=$1`, [slug])).rows[0];
  if (!unit) throw new Error("Unidade não encontrada");
  // Estratificada: metade recente (últimas 48h), metade aleatória dos últimos 30 dias.
  const rows = (await db.query(
    `(select * from contacts where unit_id=$1 and date_added > now() - interval '48 hours' order by random() limit $2)
     union all
     (select * from contacts where unit_id=$1 and date_added between now() - interval '30 days' and now() - interval '48 hours' order by random() limit $3)`,
    [unit.id, Math.ceil(n / 2), Math.floor(n / 2)])).rows;

  const users = new Map((await db.query(`select crm_id, name from crm_users where unit_id=$1`, [unit.id])).rows.map((u) => [u.crm_id, u.name]));
  const header = ["link_crm", "nome", "telefone", "entrada (dateAdded)", "origem", "classificação D2", "responsável", "seguidores",
    "1ª resposta humana", "1ª resposta por", "última msg cliente", "última msg equipe", "aguardando", "etapa atual", "CONFERE? (S/N)", "observação"];
  const out = [header];
  for (const c of rows) {
    const opp = (await db.query(
      `select coalesce(s.name, o.stage_id) stage, o.status from opportunities o
       left join pipeline_stages s on s.unit_id=o.unit_id and s.crm_id=o.stage_id
       where o.unit_id=$1 and o.contact_id=$2 order by o.updated_at_crm desc nulls last limit 1`, [unit.id, c.crm_id])).rows[0];
    const fmt = (d: any) => (d ? new Date(d).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "");
    out.push([
      `${APP}/v2/location/${unit.location_id}/contacts/detail/${c.crm_id}`, c.name ?? "", c.phone ?? "", fmt(c.date_added),
      c.source ?? "", c.origin_class, users.get(c.assigned_to) ?? c.assigned_to ?? "(sem responsável)",
      (c.followers ?? []).map((f: string) => users.get(f) ?? f).join(" | "),
      fmt(c.first_human_reply_at), users.get(c.first_human_reply_by) ?? c.first_human_reply_by ?? "",
      fmt(c.last_customer_msg_at), fmt(c.last_team_msg_at), c.waiting_on ?? "",
      opp ? `${opp.stage} (${opp.status})` : "(sem oportunidade)", "", "",
    ]);
  }
  mkdirSync("reports", { recursive: true });
  const file = `reports/conferencia-${slug}-${new Date().toISOString().slice(0, 10)}.csv`;
  writeFileSync(file, "﻿" + out.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n"));
  console.log(`${rows.length} leads → ${file} (abra no Excel; contém dados pessoais, não compartilhe)`);
  await closeDb();
}

main().catch(async (e) => { console.error("Falha:", e instanceof Error ? e.message : String(e)); await closeDb(); process.exit(1); });
