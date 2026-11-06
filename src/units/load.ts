import type { Db } from "../db/types.ts";
import { createLcClient, type LcApi } from "../integrations/leadconnector/client.ts";
import { RateLimiter } from "../integrations/leadconnector/rate-limiter.ts";
import { open } from "../lib/crypto.ts";
import { config } from "../config.ts";
import type { UnitRow } from "../sync/context.ts";

/** Carrega a unidade e cria um cliente EXCLUSIVO dela (token decifrado só em memória). */
export async function loadUnitClient(db: Db, unitId: string): Promise<{ unit: UnitRow; api: LcApi }> {
  const r = await db.query(
    `select u.*, c.token_ciphertext, c.token_iv, c.token_tag, c.api_versions
     from units u join integration_credentials c on c.unit_id = u.id where u.id=$1`, [unitId]);
  const row = r.rows[0];
  if (!row) throw new Error(`Unidade ${unitId} sem credencial cadastrada`);
  const token = open({ ciphertext: row.token_ciphertext, iv: row.token_iv, tag: row.token_tag }, config.credentialsKey);
  const { token_ciphertext, token_iv, token_tag, api_versions, ...unit } = row;
  const api = createLcClient({
    locationId: unit.location_id, token, versions: api_versions ?? {},
    limiter: new RateLimiter(config.burstMax, config.burstWindowMs),
  });
  return { unit: unit as UnitRow, api };
}
