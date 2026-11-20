import { z } from "zod";
import { identifier } from "./schema.js";

const tag = z.string().trim().min(1).max(100);
const detail = z.string().trim().min(1).max(1000);
const url = z
  .string()
  .url()
  .max(4000)
  .refine((value) => {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  });
export const cropSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine(
    (r) => r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001,
    "Crop must fit inside the image.",
  );
export const knowledgeInput = z.object({
  reference_id: identifier.optional(),
  expected_revision: z.number().int().min(0).optional(),
  screen_id: identifier.optional(),
  image_path: z.string().max(4000).optional(),
  image_base64: z.string().max(28_000_000).optional(),
  crop: cropSchema.optional(),
  kind: z.enum(["screen", "component"]).optional(),
  title: z.string().trim().min(1).max(500),
  product: z.string().trim().min(1).max(500).optional(),
  summary: detail,
  patterns: z.array(tag).min(1).max(30),
  components: z
    .array(z.object({ type: tag, description: detail }))
    .min(1)
    .max(30),
  observations: z.array(detail).min(1).max(30),
  interpretations: z.array(detail).max(20).default([]),
  visual_details: z
    .array(z.object({ attribute: tag, value: detail, basis: z.enum(["observed", "estimated"]) }))
    .max(30)
    .default([]),
  annotation: z
    .object({
      author: z.string().trim().min(1).max(200),
      basis: z.enum(["agent_inspected", "user_provided"]),
      image_inspected: z.boolean(),
    })
    .refine(
      (a) => a.basis !== "agent_inspected" || a.image_inspected,
      "Agent annotations require image inspection attestation.",
    ),
  rights: z
    .object({
      basis: z.enum(["owned", "licensed", "written_permission"]),
      attribution: detail,
      license: z.string().trim().min(1).max(500),
      source_url: url.optional(),
    })
    .optional(),
});
export type KnowledgeInput = z.infer<typeof knowledgeInput>;
export type Crop = z.infer<typeof cropSchema>;
