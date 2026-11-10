/**
 * Executa um arquivo SQL (seed/configuração) ou uma consulta no banco de DATABASE_URL.
 *   npm run sql -- supabase/seed/arquivo.sql      → executa o arquivo numa transação
 *   npm run sql -- --query "select 1"              → consulta e imprime em tabela
 * Migrations de schema NÃO passam por aqui: use npm run migrate.
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { config } from "../src/config.ts";

async function main() {
  const qi = process.argv.indexOf("--query");
  const file = qi === -1 ? process.argv[2] : undefined;
  const sql = qi > -1 ? process.argv[qi + 1] : file ? readFileSync(file, "utf8") : "";
  if (!sql) throw new Error('Uso: npm run sql -- <arquivo.sql>  |  npm run sql -- --query "select ..."');
  if (file && /supabase[\\/]migrations[\\/]/.test(file)) throw new Error("Migrations devem ser aplicadas com: npm run migrate");

  const url = config.databaseUrl;
  const client = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });
  await client.connect();
  try {
    if (file) {
      await client.query("begin");
      const r = await client.query(sql);
      await client.query("commit");
      const results = Array.isArray(r) ? r : [r];
      for (const x of results) {
        if (x.rows?.length) console.table(x.rows);
        else if (x.command) console.log(`${x.command}: ${x.rowCount ?? 0} linha(s)`);
      }
      console.log(`✓ ${file} aplicado`);
    } else {
      const r = await client.query(sql);
      console.table(r.rows);
    }
  } catch (e) {
    if (file) await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("Falha:", e instanceof Error ? e.message : String(e)); process.exit(1); });
