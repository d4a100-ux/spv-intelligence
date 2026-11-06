/** Configuração via variáveis de ambiente (lidas sob demanda para não quebrar testes). */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente ausente: ${name} (defina em .env.local)`);
  return v;
}

export const config = {
  get databaseUrl() { return required("DATABASE_URL"); },
  get credentialsKey() { return required("CREDENTIALS_KEY"); },
  /** Margem de segurança sobre o limite documentado de 100 req / 10 s por subconta. */
  burstMax: Number(process.env.LC_BURST_MAX ?? 70),
  burstWindowMs: Number(process.env.LC_BURST_WINDOW_MS ?? 10_000),
  /** Abaixo disso, a unidade só executa jobs essenciais (health, conversas). */
  dailyReserve: Number(process.env.LC_DAILY_RESERVE ?? 20_000),
};

export const API_BASE = "https://services.leadconnectorhq.com";
