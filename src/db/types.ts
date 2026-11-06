/** Interface mínima de banco usada por todo o código de sync (pg em produção, PGlite em testes). */
export interface Db {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}
