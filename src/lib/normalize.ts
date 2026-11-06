/** Utilitários puros (testáveis) usados pelo processamento. */

export function normalizePhone(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const d = p.replace(/\D/g, "");
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

/** Regra R3: outbound humana = source em humanSources. Sem source → indeterminado (null). */
export function isHumanMessage(m: { direction?: string; source?: string | null }, humanSources: readonly string[]): boolean | null {
  if (m.direction !== "outbound") return false;
  if (!m.source) return null;
  return humanSources.includes(m.source);
}
