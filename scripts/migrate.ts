/**
 * Aplica as migrations de supabase/migrations/ no banco de DATABASE_URL.
 *   npm run migrate            → aplica as pendentes
 *   npm run migrate -- --check → só mostra o que seria aplicado
 * Cada arquivo roda numa transação única (erro = nada aplicado) e fica registrado em
 * public.schema_migrations com hash, para nunca ser aplicado duas vezes nem alterado em silêncio.
 * Nunca imprime a connection string.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { config } from "../src/config.ts";

const DIR = "supabase/migrations";
const checkOnly = process.argv.includes("--check");

async function main() {
  const url = config.databaseUrl;
  const host = new URL(url).hostname;
  const client = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });
  await client.connect();
  console.log(`Conectado a ${host}`);

  await client.query(`create table if not exists public.schema_migrations (
    name text primary key, sha256 text not null, applied_at timestamptz not null default now())`);
  await client.query(`alter table public.schema_migrations enable row level security`);
  const applied = new Map((await client.query(`select name, sha256 from public.schema_migrations`)).rows.map((r) => [r.name, r.sha256]));

  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(`${DIR}/${f}`, "utf8");
    const sha = createHash("sha256").update(sql).digest("hex");
    if (applied.has(f)) {
      if (applied.get(f) !== sha) throw new Error(`${f} já aplicada mas o arquivo MUDOU. Crie uma nova migration em vez de editar a antiga.`);
      console.log(`✓ ${f} (já aplicada)`);
      continue;
    }
    if (checkOnly) { console.log(`• ${f} (pendente)`); continue; }
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(`insert into public.schema_migrations (name, sha256) values ($1,$2)`, [f, sha]);
      await client.query("commit");
      console.log(`✓ ${f} aplicada`);
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw new Error(`${f} falhou e NADA foi aplicado: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (checkOnly) { await client.end(); return; }
  const v = (await client.query(`select
    (select count(*)::int from information_schema.tables where table_schema='public' and table_type='BASE TABLE') tabelas,
    (select count(*)::int from information_schema.views where table_schema='public') views,
    (select count(*)::int from pg_tables where schemaname='public' and not rowsecurity) tabelas_sem_rls,
    (select count(*)::int from canonical_stages) etapas_canonicas`)).rows[0];
  console.log("Verificação:", v);
  await client.end();
}

main().catch((e) => { console.error("Falha:", e instanceof Error ? e.message : String(e)); process.exit(1); });
