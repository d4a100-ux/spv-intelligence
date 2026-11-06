/**
 * Limitador por subconta (uma instância por unidade — nunca compartilhado).
 * Combina janela deslizante local com os headers autoritativos X-RateLimit-* da API.
 */
export class RateLimiter {
  private stamps: number[] = [];
  private pausedUntil = 0;
  private max: number;
  private windowMs: number;
  lastRemaining: number | null = null;
  lastDailyRemaining: number | null = null;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now < this.pausedUntil) { await sleep(this.pausedUntil - now); continue; }
      this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
      if (this.stamps.length < this.max) { this.stamps.push(now); return; }
      await sleep(this.windowMs - (now - this.stamps[0]) + 25);
    }
  }

  /** Atualiza a partir dos headers da resposta. */
  observe(headers: Headers): void {
    const rem = num(headers.get("x-ratelimit-remaining"));
    const interval = num(headers.get("x-ratelimit-interval-milliseconds")) ?? this.windowMs;
    const daily = num(headers.get("x-ratelimit-daily-remaining"));
    if (rem !== null) {
      this.lastRemaining = rem;
      if (rem <= 5) this.pausedUntil = Math.max(this.pausedUntil, Date.now() + interval);
    }
    if (daily !== null) this.lastDailyRemaining = daily;
  }

  /** 429: pausa a unidade (só ela) com backoff. */
  backoff(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }
}

function num(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
