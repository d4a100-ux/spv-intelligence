/**
 * Logger estruturado (JSON por linha) com redação obrigatória.
 * Nunca registra tokens, headers de autorização, telefones, e-mails ou corpo de mensagens.
 */
const SECRET_KEYS = /token|authorization|secret|password|pit|apikey|api_key|credential|cookie/i;
const PII_KEYS = /^(phone|email|body|message|lastMessageBody|firstName|lastName|name|fullName|contactName)$/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer [REDACTED]")
      .replace(/pit-[A-Za-z0-9\-]{8,}/g, "pit-[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k)) out[k] = "[REDACTED]";
      else if (PII_KEYS.test(k)) out[k] = "[PII]";
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type Logger = {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(ctx: Record<string, unknown>): Logger;
};

export function createLogger(ctx: Record<string, unknown> = {}): Logger {
  const emit = (level: string, msg: string, data?: Record<string, unknown>) => {
    const line = { ts: new Date().toISOString(), level, msg, ...ctx, ...(data ? (redact(data) as object) : {}) };
    (level === "error" ? console.error : console.log)(JSON.stringify(line));
  };
  return {
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
    child: (c) => createLogger({ ...ctx, ...c }),
  };
}

/** Mensagem de erro segura para gravar em banco (sem token/PII, tamanho limitado). */
export function safeErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return String(redact(msg)).slice(0, 500);
}
