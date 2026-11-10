/**
 * Aluguel (lease) de uma unidade por este worker. Substitui o advisory lock, que não é confiável
 * atrás do pooler do Supabase (ver supabase/migrations/0002_unit_leases.sql).
 *
 * - TTL de 120 s, renovado a cada 30 s.
 * - Renovação que falha por erro de rede: tenta de novo no próximo ciclo.
 * - Se não conseguir renovar por mais de 75% do TTL, o worker ASSUME que perdeu a unidade e para,
 *   antes que outro worker possa assumi-la (evita dois workers na mesma subconta).
 */
import type { Db } from "../db/types.ts";

export type Lease = {
  readonly holder: string;
  isLost(): boolean;
  stop(): void;
  release(): Promise<void>;
};

export type LeaseOptions = { ttlSeconds?: number; renewEveryMs?: number; now?: () => number; onLost?: (reason: string) => void };

export async function acquireLease(db: Db, unitId: string, holder: string, opts: LeaseOptions = {}): Promise<Lease | null> {
  const ttl = opts.ttlSeconds ?? 120;
  const now = opts.now ?? Date.now;
  const ok = (await db.query<{ ok: boolean }>(`select acquire_unit_lease($1,$2,$3) ok`, [unitId, holder, ttl])).rows[0]?.ok;
  if (!ok) return null;

  let lost = false;
  let lastRenewOk = now();
  const markLost = (reason: string) => { if (!lost) { lost = true; opts.onLost?.(reason); } };

  const timer = setInterval(async () => {
    if (lost) return;
    try {
      const r = (await db.query<{ ok: boolean }>(`select acquire_unit_lease($1,$2,$3) ok`, [unitId, holder, ttl])).rows[0]?.ok;
      if (r) lastRenewOk = now();
      else markLost("outro worker assumiu a unidade (lease expirado)");
    } catch (e) {
      if (now() - lastRenewOk > ttl * 1000 * 0.75) {
        markLost(`renovação falhando há mais de ${Math.round(ttl * 0.75)} s: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }, opts.renewEveryMs ?? 30_000);
  timer.unref?.();

  return {
    holder,
    isLost: () => lost || now() - lastRenewOk > ttl * 1000 * 0.75,
    stop: () => clearInterval(timer),
    release: async () => {
      clearInterval(timer);
      if (!lost) await db.query(`select release_unit_lease($1,$2)`, [unitId, holder]).catch(() => {});
    },
  };
}
