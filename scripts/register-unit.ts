/**
 * Cadastra/atualiza UMA unidade a partir de um relatório do validador aprovado.
 *   npm run unit:register -- --slug carros-online --name "Carros Online"
 *
 * - Exige relatório reports/validation-<LC_LOCATION_ID>-*.json com os recursos essenciais OK.
 * - Cifra o token (AES-256-GCM) e grava somente o texto cifrado no banco.
 * - Define o marco H0 (history_since) na PRIMEIRA conexão validada — nunca sobrescreve.
 * - Enfileira a carga inicial; a captura histórica começa assim que o worker rodar.
 * - Impede misturar unidades: o slug não pode apontar para outro Location ID e vice-versa.
 */
import { readdirSync, readFileSync } from "node:fs";
import { getDb, closeDb } from "../src/db/pg.ts";
import { seal } from "../src/lib/crypto.ts";
import { config } from "../src/config.ts";
import { createLcClient } from "../src/integrations/leadconnector/client.ts";
import { RateLimiter } from "../src/integrations/leadconnector/rate-limiter.ts";
import { JOBS, type JobKind } from "../src/worker/jobs.ts";

const ESSENTIAL = ["location", "users", "contacts.search", "conversations.search", "conversations.messages", "pipelines", "opportunities.search"];
const SCOPE_BY_CHECK: Record<string, string> = {};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg("slug"), name = arg("name");
  const token = process.env.LC_PIT ?? "", locationId = process.env.LC_LOCATION_ID ?? "";
  if (!slug || !name) throw new Error('Uso: npm run unit:register -- --slug carros-online --name "Carros Online"');
  if (!token || !locationId) throw new Error("LC_PIT e LC_LOCATION_ID devem estar em .env.local");

  // 1. Relatório do validador mais recente desta subconta
  const files = readdirSync("reports").filter((f) => f.startsWith(`validation-${locationId}-`)).sort();
  if (!files.length) throw new Error("Nenhum relatório do validador para este Location ID. Rode: npm run validate");
  const report = JSON.parse(readFileSync(`reports/${files[files.length - 1]}`, "utf8"));
  if (report.schema !== 2) throw new Error("Relatório de versão antiga. Rode novamente: npm run validate");
  const failed = ESSENTIAL.filter((id) => !report.checks.find((c: any) => c.id === id)?.ok);
  if (failed.length) throw new Error(`Validação essencial falhou: ${failed.join(", ")}. Corrija escopos/token e rode npm run validate.`);
  const badPag = report.checks.filter((c: any) => c.pagination?.tested && c.pagination.ok === false).map((c: any) => c.id);
  if (badPag.length) throw new Error(`Paginação falhou em: ${badPag.join(", ")} — não é seguro iniciar a sync.`);
  for (const c of report.checks) SCOPE_BY_CHECK[c.scope] = (SCOPE_BY_CHECK[c.scope] ?? true) && c.ok;

  // 2. Conexão ao vivo (prova que o token atual ainda vale)
  const api = createLcClient({ locationId, token, versions: report.versions, limiter: new RateLimiter(10, 10_000) });
  const loc = await api.get("locations", `/locations/${locationId}`);
  const location = loc?.location ?? loc;

  const db = getDb();
  const sealed = seal(token, config.credentialsKey);
  const unitId = await db.tx(async (tx) => {
    const bySlug = (await tx.query(`select id, location_id from units where slug=$1`, [slug])).rows[0];
    const byLoc = (await tx.query(`select id, slug from units where location_id=$1`, [locationId])).rows[0];
    if (bySlug && bySlug.location_id !== locationId) throw new Error(`Slug "${slug}" já pertence a outro Location ID. Abortado para não misturar unidades.`);
    if (byLoc && byLoc.slug !== slug) throw new Error(`Este Location ID já está cadastrado como "${byLoc.slug}". Abortado.`);

    const u = (await tx.query<{ id: string; history_since: string | null }>(
      `insert into units (slug, name, location_id, company_id, timezone, connection_status, last_validated_at, history_since)
       values ($1,$2,$3,$4,coalesce($5,'America/Sao_Paulo'),'ok',now(),now())
       on conflict (location_id) do update set name=excluded.name, company_id=coalesce(excluded.company_id, units.company_id),
         connection_status='ok', consecutive_failures=0, last_error=null, last_validated_at=now(),
         history_since=coalesce(units.history_since, excluded.history_since), updated_at=now()
       returning id, history_since`,
      [slug, name, locationId, location?.companyId ?? null, location?.timezone ?? null])).rows[0];

    await tx.query(
      `insert into integration_credentials (unit_id, token_ciphertext, token_iv, token_tag, token_last4, api_versions, scopes_validated, validation_report, rotate_before)
       values ($1,$2,$3,$4,$5,$6,$7,$8, current_date + 85)
       on conflict (unit_id) do update set token_ciphertext=excluded.token_ciphertext, token_iv=excluded.token_iv,
         token_tag=excluded.token_tag, token_last4=excluded.token_last4, api_versions=excluded.api_versions,
         scopes_validated=excluded.scopes_validated, validation_report=excluded.validation_report,
         rotate_before=excluded.rotate_before, updated_at=now()`,
      [u.id, sealed.ciphertext, sealed.iv, sealed.tag, token.slice(-4), JSON.stringify(report.versions),
       JSON.stringify(SCOPE_BY_CHECK), JSON.stringify({ file: files[files.length - 1], matrix: report.matrix, rateLimit: report.rateLimit })]);

    // Carga inicial: referência primeiro (usuários são necessários para detectar vendedores seguidores)
    for (const kind of Object.keys(JOBS) as JobKind[]) {
      if (kind === "maintenance") continue;
      await tx.query(
        `insert into jobs (unit_id, kind, priority, dedupe_key) values ($1,$2,$3,$4) on conflict (dedupe_key) do nothing`,
        [u.id, kind, JOBS[kind].priority, `${u.id}:${kind}:initial`]);
    }
    console.log(`Unidade "${name}" registrada. H0 (início da captura histórica): ${new Date(u.history_since!).toISOString()}`);
    return u.id;
  });

  console.log(`unit_id=${unitId}  token=••••${token.slice(-4)}  versões=${JSON.stringify(report.versions)}`);
  console.log("\nPróximos passos:");
  console.log("  1. Remova LC_PIT do .env.local (o token agora está cifrado no banco).");
  console.log(`  2. Inicie a captura:  npm run worker -- --unit ${slug}`);
  await closeDb();
}

main().catch(async (e) => {
  console.error("Falha:", e instanceof Error ? e.message : String(e));
  await closeDb();
  process.exit(1);
});
