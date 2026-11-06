import type { Db } from "../db/types.ts";
import type { LcApi } from "../integrations/leadconnector/client.ts";
import type { Logger } from "../lib/log.ts";

export type UnitRow = {
  id: string;
  slug: string;
  name: string;
  location_id: string;
  company_id: string | null;
  timezone: string;
  settings: Record<string, any>;
  history_since: string | null;
  connection_status: string;
};

export type SyncContext = {
  db: Db;
  unit: UnitRow;
  api: LcApi;
  log: Logger;
  now: () => Date;
};

export type SyncResult = {
  status: "ok" | "partial";
  upserted: number;
  changes: number;
  /** true = orçamento de páginas esgotado; o worker agenda continuação imediata */
  needsContinuation?: boolean;
  notes?: string[];
};

export const MINUTE = 60_000;
export const DAY = 86_400_000;

export function setting<T>(unit: UnitRow, key: string, fallback: T): T {
  const v = unit.settings?.[key];
  return (v === undefined || v === null ? fallback : v) as T;
}

export async function getCursor<T>(db: Db, unitId: string, resource: string): Promise<T | null> {
  const r = await db.query<{ cursor: T }>(`select cursor from sync_cursors where unit_id=$1 and resource=$2`, [unitId, resource]);
  return r.rows[0]?.cursor ?? null;
}

export async function setCursor(db: Db, unitId: string, resource: string, cursor: unknown): Promise<void> {
  await db.query(
    `insert into sync_cursors (unit_id, resource, cursor) values ($1,$2,$3)
     on conflict (unit_id, resource) do update set cursor = excluded.cursor, updated_at = now()`,
    [unitId, resource, JSON.stringify(cursor)],
  );
}
