/**
 * Classificação operacional dos usuários do CRM (o CRM não distingue SDR de vendedor).
 *   npm run users -- list --unit carros-online
 *   npm run users -- set --unit carros-online --user <crmUserId> --role seller|sdr|manager|other
 * Ao marcar alguém como vendedor, os handoffs são reconstruídos a partir do histórico de seguidores.
 */
import { getDb, closeDb } from "../src/db/pg.ts";

const [cmd] = process.argv.slice(2);
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };

async function main() {
  const db = getDb();
  const slug = arg("unit");
  if (!slug) throw new Error("Informe --unit <slug>");
  const unit = (await db.query(`select id, name from units where slug=$1`, [slug])).rows[0];
  if (!unit) throw new Error(`Unidade não encontrada: ${slug}`);

  if (cmd === "list") {
    const r = await db.query(
      `select u.crm_id, u.name, u.crm_role, u.operational_role, u.active,
         (select count(*) from contacts c where c.unit_id=u.unit_id and c.assigned_to=u.crm_id) as contatos_atribuidos,
         (select count(*) from contacts c where c.unit_id=u.unit_id and u.crm_id = any(c.followers)) as contatos_seguindo
       from crm_users u where u.unit_id=$1 order by u.operational_role, u.name`, [unit.id]);
    console.table(r.rows);
  } else if (cmd === "set") {
    const user = arg("user"), role = arg("role");
    if (!user || !role) throw new Error("Informe --user e --role");
    const r = await db.query(
      `update crm_users set operational_role=$3, role_updated_at=now() where unit_id=$1 and crm_id=$2 returning name`,
      [unit.id, user, role]);
    if (!r.rows[0]) throw new Error("Usuário não encontrado nesta unidade (rode o worker para sincronizar usuários).");
    console.log(`${r.rows[0].name} → ${role}`);
    if (role === "seller") {
      const n = (await db.query(`select rebuild_seller_handoffs($1) n`, [unit.id])).rows[0].n;
      console.log(`${n} handoff(s) de vendedor seguidor reconstruídos a partir do histórico.`);
    }
  } else {
    throw new Error("Comando: list | set");
  }
  await closeDb();
}

main().catch(async (e) => { console.error("Falha:", e instanceof Error ? e.message : String(e)); await closeDb(); process.exit(1); });
