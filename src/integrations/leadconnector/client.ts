import { API_BASE } from "../../config.ts";
import { LcError, classifyStatus } from "./errors.ts";
import { RateLimiter, sleep } from "./rate-limiter.ts";

/** Recursos com versão de header configurável (comprovada pelo validador por subconta). */
export type LcResource =
  | "locations" | "users" | "contacts" | "conversations" | "messages"
  | "pipelines" | "opportunities" | "calendars" | "events" | "customFields";

export type RequestStats = { requests: number; lastStatus: number | null };

export interface LcApi {
  readonly locationId: string;
  readonly stats: RequestStats;
  readonly limiter: RateLimiter;
  get<T = any>(resource: LcResource, path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  post<T = any>(resource: LcResource, path: string, body: unknown): Promise<T>;
}

export type ClientOptions = {
  locationId: string;
  token: string;
  versions: Partial<Record<LcResource, string>>;
  limiter: RateLimiter;
  defaultVersion?: string;
  maxRetries?: number;
};

/** Um cliente por unidade. O token fica em closure privada e nunca é exposto/logado. */
export function createLcClient(opts: ClientOptions): LcApi {
  const token = opts.token;
  const maxRetries = opts.maxRetries ?? 5;
  const stats: RequestStats = { requests: 0, lastStatus: null };

  async function request<T>(resource: LcResource, method: "GET" | "POST", path: string, query?: Record<string, any>, body?: unknown): Promise<T> {
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const version = opts.versions[resource] ?? opts.defaultVersion ?? "v3";

    for (let attempt = 0; ; attempt++) {
      await opts.limiter.acquire();
      let res: Response;
      try {
        stats.requests++;
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Version: version,
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        if (attempt >= maxRetries) throw new LcError("network", null, path, e instanceof Error ? e.name : "fetch failed");
        await sleep(backoffMs(attempt));
        continue;
      }
      stats.lastStatus = res.status;
      opts.limiter.observe(res.headers);

      if (res.ok) return (await res.json().catch(() => ({}))) as T;

      const cls = classifyStatus(res.status);
      if ((cls === "rate_limit" || cls === "server") && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
        if (cls === "rate_limit") opts.limiter.backoff(wait);
        await res.body?.cancel().catch(() => {});
        await sleep(wait);
        continue;
      }
      // Mensagem da API costuma ser curta e técnica; ainda assim truncada e sem eco do corpo enviado.
      let detail = res.statusText;
      try {
        const j: any = await res.json();
        detail = String(j?.message ?? j?.error ?? detail).slice(0, 200);
      } catch { /* sem corpo */ }
      throw new LcError(cls, res.status, path, detail);
    }
  }

  return {
    locationId: opts.locationId,
    stats,
    limiter: opts.limiter,
    get: (resource, path, query) => request(resource, "GET", path, query),
    post: (resource, path, body) => request(resource, "POST", path, undefined, body),
  };
}

function backoffMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 750);
}
