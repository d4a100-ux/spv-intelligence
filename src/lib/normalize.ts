/** Utilitários puros (testáveis) usados pelo processamento. */

/**
 * Telefone canônico para detecção de duplicidade. As unidades são brasileiras: 10–11 dígitos
 * (DDD + número, sem código do país) recebem o prefixo 55, para que "+55 11 9…" e "(11) 9…"
 * sejam o mesmo número. Números estrangeiros/curtos ficam como estão.
 */
export function normalizePhone(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const hasCountryCode = p.trim().startsWith("+");          // "+1 415…" já traz o país: não prefixar
  let d = p.replace(/\D/g, "");
  if (!hasCountryCode && d.startsWith("0")) d = d.replace(/^0+/, ""); // discagem com 0 / 0xx
  if (!hasCountryCode && (d.length === 10 || d.length === 11)) d = "55" + d;
  return d.length >= 8 ? d : null;
}

export function normalizeEmail(e: unknown): string | null {
  if (typeof e !== "string") return null;
  const v = e.trim().toLowerCase();
  return v.includes("@") ? v : null;
}

/** Aceita ISO string, epoch ms (number ou string numérica). Retorna ISO ou null. */
export function toIso(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? new Date(v).toISOString() : null;
  if (typeof v === "string") {
    if (/^\d{10,13}$/.test(v)) return new Date(Number(v)).toISOString();
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  if (typeof v === "object" && v && "toISOString" in (v as any)) return (v as Date).toISOString();
  return null;
}

export function diffSets(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const b = new Set(before), a = new Set(after);
  return { added: [...a].filter((x) => !b.has(x)), removed: [...b].filter((x) => !a.has(x)) };
}

export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

/**
 * Eventos de sistema que o CRM grava como "mensagem" (comprovado no piloto Carros Online):
 * TYPE_ACTIVITY_OPPORTUNITY / _APPOINTMENT / _SLA … e TYPE_INTERNAL_COMMENT, todos outbound + source=app.
 */
export function messageKind(messageType: unknown): "message" | "activity" | "internal" {
  if (typeof messageType !== "string") return "message";
  if (messageType.startsWith("TYPE_ACTIVITY")) return "activity";
  if (messageType === "TYPE_INTERNAL_COMMENT") return "internal";
  return "message";
}

/**
 * Regra R3: outbound humana = mensagem real (não evento de sistema) com source em humanSources.
 * Sem source → indeterminado (null). userId ausente NÃO a torna automação: no piloto, ~1/3 das
 * mensagens app sem userId tinham padrão de resposta humana (enviadas fora do CRM, ex.: celular).
 */
export function isHumanMessage(m: { direction?: string; source?: string | null; messageType?: string }, humanSources: readonly string[]): boolean | null {
  if (m.direction !== "outbound") return false;
  if (messageKind(m.messageType) !== "message") return false;
  if (!m.source) return null;
  return humanSources.includes(m.source);
}
