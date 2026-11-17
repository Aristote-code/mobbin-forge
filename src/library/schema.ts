import { z } from "zod";

export const MODEL = {
  engine: "transformers.js@4.3.2",
  id: "Xenova/clip-vit-base-patch32",
  revision: "6b7c523703ae26e39be4b03774966f8571c7f523",
  dtype: "q8",
  dimensions: 512,
  preprocessing: "contain-white-224-and-three-square-vertical-tiles-v1",
} as const;
export const MODEL_KEY = JSON.stringify(MODEL);
export const MAX_SCREENS = 1000;
export const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/);
const label = z.string().trim().min(1).max(500);
const webUrl = z
  .string()
  .url()
  .max(4000)
  .refine((value) => {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  });
export const manifestSchema = z.object({
  schema_version: z.literal(1),
  dataset: z.object({
    id: identifier,
    title: label,
    source_url: webUrl,
    license: label,
    license_url: webUrl,
    attribution: z.string().trim().min(1).max(5000),
    rights_basis: z.enum(["owned", "licensed", "written_permission"]),
    source_revision: z.string().max(200).optional(),
  }),
  screens: z
    .array(
      z.object({
        id: identifier,
        image: z.string().min(1).max(1000),
        title: label,
        product: label,
        platform: z.enum(["ios", "android", "web", "other"]),
        source_url: webUrl.optional(),
        tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
        text: z.string().max(12000).default(""),
      }),
    )
    .min(1)
    .max(MAX_SCREENS),
  flows: z
    .array(
      z.object({
        id: identifier,
        title: label,
        goal: z.string().max(5000),
        source_url: webUrl.optional(),
        complete: z.boolean(),
        steps: z
          .array(
            z.object({
              screen_id: identifier,
              action: z.string().max(3000).default(""),
              source_step: z.number().int().min(0).optional(),
            }),
          )
          .min(1)
          .max(200),
      }),
    )
    .max(2000),
});
export type Manifest = z.infer<typeof manifestSchema>;
export type ChunkVector = { region: string; vector: number[] };
export interface EmbeddingEngine {
  image(bytes: Uint8Array): Promise<ChunkVector[]>;
  text(text: string): Promise<number[]>;
  setup(): Promise<unknown>;
  close(): Promise<void>;
}
export function normalize(vector: ArrayLike<number>): number[] {
  if (
    vector.length !== MODEL.dimensions ||
    Array.from(vector).some((value) => !Number.isFinite(value))
  )
    throw Error("Invalid embedding dimensions or non-finite values.");
  const magnitude = Math.sqrt(Array.from(vector).reduce((sum, value) => sum + value * value, 0));
  if (magnitude < 1e-12) throw Error("Embedding vector is empty.");
  return Array.from(vector, (value) => value / magnitude);
}
