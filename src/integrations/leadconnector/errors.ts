export type LcErrorClass = "auth" | "scope" | "rate_limit" | "bad_request" | "server" | "network" | "internal";

/** Erro da API sem nenhum dado sensível (nem token, nem corpo de resposta com PII). */
export class LcError extends Error {
  errorClass: LcErrorClass;
  httpStatus: number | null;
  path: string;
  constructor(errorClass: LcErrorClass, httpStatus: number | null, path: string, detail: string) {
    super(`[${errorClass}] HTTP ${httpStatus ?? "-"} ${path}: ${detail}`.slice(0, 400));
    this.errorClass = errorClass;
    this.httpStatus = httpStatus;
    this.path = path;
  }
  /** Erros que não adianta repetir até alguém agir (token/escopo). */
  get isFatalForUnit(): boolean {
    return this.errorClass === "auth" || this.errorClass === "scope";
  }
}

export function classifyStatus(status: number): LcErrorClass {
  if (status === 401) return "auth";
  if (status === 403) return "scope";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "bad_request";
}
