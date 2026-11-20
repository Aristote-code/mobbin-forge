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
export const automaticEvidenceSchema = z.object({
  pipeline_version: z.string().max(100),
  generated_at: z.string().max(100),
  source_manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_asset_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  model_key: z.string().max(2000),
  ocr: z.object({
    engine: z.string().max(300),
    revision: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    coordinate_space: z.string().max(200),
    recognition_languages: z.array(z.string().max(50)).max(20),
    text_truncated: z.boolean(),
    text: z
      .array(
        z.object({
          text: z.string().max(2000),
          confidence: z.number().min(0).max(1),
          bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
        }),
      )
      .max(500),
    rectangles: z
      .array(
        z.object({
          confidence: z.number().min(0).max(1),
          bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
        }),
      )
      .max(25),
  }),
  pattern_candidates: z
    .array(
      z.object({
        label: z.string().max(100),
        score: z.number().min(-1.001).max(1.001).optional(),
        basis: z.enum(["visible_text_rule", "clip_similarity"]),
        evidence: z.array(z.string().max(400)).max(10),
      }),
    )
    .max(20),
  component_candidates: z
    .array(
      z.object({
        type: z.string().max(100),
        label: z.string().max(2000).optional(),
        score: z.number().min(-1.001).max(1.001).optional(),
        bounds: z
          .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
          .optional(),
        bounds_scope: z.enum(["text_only", "rectangle_only", "unlocalized"]),
        basis: z.enum(["visible_text_rule", "rectangle_detector", "clip_similarity"]),
        evidence: z.string().max(500),
      }),
    )
    .max(100),
  layout_candidate: z.object({
    label: z.string().max(100),
    score: z.number().min(-1.001).max(1.001),
  }),
  flow_memberships: z
    .array(
      z.object({
        flow_id: identifier,
        title: z.string().max(500),
        goal: z.string().max(5000),
        position: z.number().int().min(0),
        source_step: z.number().int().min(0).optional(),
        action: z.string().max(3000),
        previous_screen_id: identifier.optional(),
        next_screen_id: identifier.optional(),
        provided_trajectory_complete: z.boolean(),
      }),
    )
    .max(1000),
  limitations: z.array(z.string().max(1000)).max(20),
});

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
      basis: z.enum(["agent_inspected", "user_provided", "local_automated"]),
      image_inspected: z.boolean(),
    })
    .refine(
      (a) => a.basis !== "agent_inspected" || a.image_inspected,
      "Agent annotations require image inspection attestation.",
    ),
  automation_evidence: automaticEvidenceSchema.optional(),
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

export type AutomaticEvidence = z.infer<typeof automaticEvidenceSchema>;
export const MAX_KNOWLEDGE_REFERENCES = 10000;
