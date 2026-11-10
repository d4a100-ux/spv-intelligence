-- =====================================================================
-- 0002 — Aluguel (lease) de unidade por worker, substituindo o advisory lock.
--
-- Motivo (incidente de 10/11/2026): atrás do pooler do Supabase (Supavisor, modo session)
-- a sessão do servidor é reaproveitada entre clientes e sobrevive à queda da conexão do
-- cliente. O advisory lock (estado de sessão) ficou preso numa sessão-fantasma e a unidade
-- parou de sincronizar. O lease vive numa tabela, expira sozinho e não depende de conexão.
-- =====================================================================

create table unit_leases (
  unit_id     uuid primary key references units(id) on delete cascade,
  holder      text not null,                 -- host:pid:instância do worker
  acquired_at timestamptz not null default now(),
  renewed_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
alter table unit_leases enable row level security;   -- sem policies: só o worker (owner)

-- Adquire ou renova. Sucesso se: não há lease, ou o lease é do mesmo holder, ou expirou.
-- Retorna true/false (nunca null).
create or replace function acquire_unit_lease(p_unit uuid, p_holder text, p_ttl_seconds int)
returns boolean language plpgsql as $$
declare ok boolean;
begin
  insert into unit_leases as l (unit_id, holder, expires_at)
  values (p_unit, p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (unit_id) do update
    set holder      = excluded.holder,
        acquired_at = case when l.holder = excluded.holder then l.acquired_at else now() end,
        renewed_at  = now(),
        expires_at  = excluded.expires_at
    where l.holder = excluded.holder or l.expires_at < now()
  returning true into ok;
  return coalesce(ok, false);
end $$;

create or replace function release_unit_lease(p_unit uuid, p_holder text)
returns void language sql as $$
  delete from unit_leases where unit_id = p_unit and holder = p_holder;
$$;

do $$
declare f text;
begin
  foreach f in array array['acquire_unit_lease(uuid, text, int)', 'release_unit_lease(uuid, text)'] loop
    execute format('revoke execute on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke execute on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke execute on function %s from authenticated', f); end if;
  end loop;
end $$;
