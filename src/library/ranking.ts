import type { ChunkVector } from "./schema.js";

const cosine = (a: number[], b: number[]) =>
  a.reduce((sum, value, index) => sum + value * b[index], 0);

/** Layout mode preserves tile positions; balanced mode tolerates rearranged components. */
export function imageSimilarity(
  query: ChunkVector[],
  document: ChunkVector[],
  strategy: "balanced" | "layout" = "balanced",
): number {
  const whole = document.find((chunk) => chunk.region === "full")!;
  const full = cosine(query[0].vector, whole.vector);
  const parts = query.slice(1);
  if (!parts.length)
    return strategy === "layout"
      ? full
      : Math.max(...document.map((chunk) => cosine(query[0].vector, chunk.vector)));
  const aligned = parts.reduce((sum, part) => {
    if (strategy === "balanced")
      return sum + Math.max(...document.map((chunk) => cosine(part.vector, chunk.vector)));
    // A portrait tile has no corresponding landscape tile: fall back to the whole view.
    const target = document.find((chunk) => chunk.region === part.region) ?? whole;
    return sum + cosine(part.vector, target.vector);
  }, 0);
  return 0.6 * full + (0.4 * aligned) / parts.length;
}
