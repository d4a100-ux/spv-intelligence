/** Dados de referência (baixo volume, leitura completa): location/health, usuários, pipelines, calendários. */
import type { SyncContext, SyncResult } from "./context.ts";

export async function syncHealth(ctx: SyncContext): Promise<SyncResult> {
  const r = await ctx.api.get("locations", `/locations/${ctx.unit.location_id}`);
  const loc = r?.location ?? r;
  await ctx.db.query(
    `update units set company_id = coalesce($2, company_id), last_validated_at = now(), updated_at = now() where id = $1`,
    [ctx.unit.id, loc?.companyId ?? null]);
  if (loc?.companyId) ctx.unit.company_id = loc.companyId;
  return { status: "ok", upserted: 0, changes: 0 };
}

export async function syncUsers(ctx: SyncContext): Promise<SyncResult> {
  if (!ctx.unit.company_id) await syncHealth(ctx);
  if (!ctx.unit.company_id) throw new Error("companyId indisponível para consultar usuários");
  const seen: string[] = [];
  let skip = 0;
  for (let page = 0; page < 20; page++) {
    const r = await ctx.api.get("users", "/users/search", {
      companyId: ctx.unit.company_id, locationId: ctx.unit.location_id, limit: 100, skip,
    });
    const users: any[] = r?.users ?? [];
    for (const u of users) {
      seen.push(u.id);
      await ctx.db.query(
        `insert into crm_users (unit_id, crm_id, name, email, crm_role, active, raw, synced_at)
         values ($1,$2,$3,$4,$5,true,$6,now())
         on conflict (unit_id, crm_id) do update set name=excluded.name, email=excluded.email,
           crm_role=excluded.crm_role, active=true, raw=excluded.raw, synced_at=now()`,
        [ctx.unit.id, u.id, u.name ?? [u.firstName, u.lastName].filter(Boolean).join(" "), u.email ?? null,
         u.roles?.role ?? null, JSON.stringify(u)]);
    }
    if (users.length < 100) break;
    skip += 100;
  }
  // Usuários que sumiram da subconta ficam inativos (o histórico é preservado).
  if (seen.length) {
    await ctx.db.query(`update crm_users set active=false where unit_id=$1 and not (crm_id = any($2::text[]))`, [ctx.unit.id, seen]);
  }
  return { status: "ok", upserted: seen.length, changes: 0 };
}

export async function syncPipelines(ctx: SyncContext): Promise<SyncResult> {
  const r = await ctx.api.get("pipelines", "/opportunities/pipelines", { locationId: ctx.unit.location_id });
  const pipelines: any[] = r?.pipelines ?? [];
  let n = 0;
  await ctx.db.tx(async (db) => {
    for (const p of pipelines) {
      await db.query(
        `insert into pipelines (unit_id, crm_id, name, raw, synced_at) values ($1,$2,$3,$4,now())
         on conflict (unit_id, crm_id) do update set name=excluded.name, raw=excluded.raw, synced_at=now()`,
        [ctx.unit.id, p.id, p.name ?? "(sem nome)", JSON.stringify(p)]);
      for (const [i, s] of (p.stages ?? []).entries()) {
        await db.query(
          `insert into pipeline_stages (unit_id, crm_id, pipeline_id, name, position) values ($1,$2,$3,$4,$5)
           on conflict (unit_id, crm_id) do update set pipeline_id=excluded.pipeline_id, name=excluded.name, position=excluded.position`,
          [ctx.unit.id, s.id, p.id, s.name ?? "(sem nome)", s.position ?? i]);
        n++;
      }
    }
  });
  const unmapped = await ctx.db.query<{ n: string }>(
    `select count(*) n from pipeline_stages s where s.unit_id=$1
       and not exists (select 1 from stage_mappings m where m.unit_id=s.unit_id and m.stage_id=s.crm_id)`, [ctx.unit.id]);
  const notes = Number(unmapped.rows[0].n) > 0 ? [`${unmapped.rows[0].n} etapa(s) sem mapeamento canônico`] : [];
  return { status: "ok", upserted: n, changes: 0, notes };
}

export async function syncCalendars(ctx: SyncContext): Promise<SyncResult> {
  const r = await ctx.api.get("calendars", "/calendars/", { locationId: ctx.unit.location_id });
  const cals: any[] = r?.calendars ?? [];
  for (const c of cals) {
    await ctx.db.query(
      `insert into calendars (unit_id, crm_id, name, active, raw, synced_at) values ($1,$2,$3,$4,$5,now())
       on conflict (unit_id, crm_id) do update set name=excluded.name, active=excluded.active, raw=excluded.raw, synced_at=now()`,
      [ctx.unit.id, c.id, c.name ?? null, c.isActive !== false, JSON.stringify(c)]);
  }
  return { status: "ok", upserted: cals.length, changes: 0 };
}
