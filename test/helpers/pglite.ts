/**
 * Postgres real (PGlite/WASM) em memória para testes. NÃO é o banco de produção.
 * Simula apenas o que o Supabase provê por padrão: schema auth, auth.uid(), papéis e publication.
 */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "../../src/db/types.ts";

const SUPABASE_STUBS = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
end $$;
grant usage on schema public, auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
-- Simula o projeto criado com "Automatically expose new tables" DESLIGADO:
-- nenhum privilégio automático; a migration precisa conceder tudo explicitamente.
create publication supabase_realtime;
`;

export async function createTestDb(): Promise<{ pg: PGlite; db: Db }> {
  const pg = new PGlite();
  await pg.exec(SUPABASE_STUBS);
  await pg.exec(readFileSync(new URL("../../supabase/migrations/0001_init.sql", import.meta.url), "utf8"));
  return { pg, db: pgliteDb(pg) };
}

function pgliteDb(pg: PGlite | any): Db {
  return {
    async query(text, params) {
      const r = await pg.query(text, params ?? []);
      return { rows: r.rows as any[] };
    },
    async tx(fn) {
      return pg.transaction((t: any) => fn(pgliteDb(t)));
    },
  };
}
