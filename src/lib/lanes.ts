/**
 * Processa itens em paralelo em N "pistas". Itens com a MESMA chave caem sempre na mesma pista
 * e rodam em sequência, evitando conflito/deadlock entre gravações do mesmo contato ou do mesmo
 * grupo de duplicidade. Itens de chaves diferentes rodam em paralelo.
 * A ordem relativa dentro de uma chave é preservada. Retorna os resultados na ordem original.
 */
export async function runInLanes<T, R>(items: readonly T[], lanes: number, keyOf: (item: T) => string, fn: (item: T) => Promise<R>): Promise<R[]> {
  const n = Math.max(1, Math.floor(lanes));
  const buckets: { idx: number; item: T }[][] = Array.from({ length: n }, () => []);
  items.forEach((item, idx) => buckets[hash(keyOf(item)) % n].push({ idx, item }));
  const out = new Array<R>(items.length);
  await Promise.all(buckets.map(async (b) => {
    for (const { idx, item } of b) out[idx] = await fn(item);
  }));
  return out;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
