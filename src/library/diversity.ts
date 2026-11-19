/** Imported product labels, normalized for quota counting; this is not app recognition. */
export function appKey(product: string): string {
  return product.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/** Prefer one best-ranked candidate per app before considering a second from any app. */
export function selectAppDiverse<T>(
  ranked: T[],
  product: (item: T) => string,
  limit: number,
  maxPerApp: number,
): T[] {
  const chosen = new Set<T>();
  const counts = new Map<string, number>();
  for (let round = 0; round < maxPerApp && chosen.size < limit; round++) {
    let added = false;
    for (const item of ranked) {
      const key = appKey(product(item));
      if (chosen.has(item) || (counts.get(key) ?? 0) !== round) continue;
      chosen.add(item);
      counts.set(key, round + 1);
      added = true;
      if (chosen.size === limit) break;
    }
    if (!added) break;
  }
  // Preserve original score order and IDs; diversity never changes similarity scores.
  return ranked.filter((item) => chosen.has(item));
}
