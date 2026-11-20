import { z } from "zod";

const shortText = z.string().trim().min(1).max(300);
const text = z.string().trim().min(1).max(6000);
export const recordId = z.string().uuid();
export const revision = z.number().int().min(1);
export const researchUrl = z
  .string()
  .max(4000)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  }, "Use an HTTP(S) URL without embedded credentials.");

export const projectInput = z.object({
  name: shortText,
  audience: text,
  goals: z.array(shortText).min(1).max(20),
  constraints: z.array(shortText).max(30).default([]),
  principles: z.array(shortText).max(30).default([]),
  components: z.array(shortText).max(60).default([]),
});
export const projectSchema = projectInput.extend({
  id: recordId,
  revision,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const criterionSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,59}$/),
  label: shortText,
  question: text,
});
export const benchmarkInput = z.object({
  project_id: recordId.optional(),
  title: shortText,
  question: text,
  criteria: z.array(criterionSchema).min(1).max(12),
});

export const referenceInput = z.object({
  label: shortText,
  product: shortText,
  platform: z.enum(["ios", "android", "web", "other"]),
  source_kind: z.enum(["mobbin_screen", "mobbin_flow", "mobbin_section", "user_reference"]),
  source_url: researchUrl,
  captured_by: z.enum(["mobbin", "playwright", "agent-browser", "manual"]),
  captured_at: z.string().datetime().optional(),
  steps: z
    .array(
      z.object({
        label: shortText,
        stage: shortText.describe(
          "Explicit alignment label, e.g. permissions. Reuse labels across references; do not infer missing stages.",
        ),
        source_url: researchUrl,
        image_url: researchUrl.optional(),
        notes: text.optional(),
      }),
    )
    .min(1)
    .max(30),
});
export const referenceSchema = referenceInput.extend({
  id: recordId,
  added_at: z.string().datetime(),
  provenance: z.literal("agent_supplied"),
  steps: z
    .array(referenceInput.shape.steps.element.extend({ id: recordId }))
    .min(1)
    .max(30),
});

export const findingInput = z.object({
  kind: z.enum(["observation", "interpretation", "hypothesis", "preference"]),
  text,
  criterion_key: criterionSchema.shape.key.optional(),
  step_ids: z.array(recordId).max(30).default([]),
  inspected_step_ids: z
    .array(recordId)
    .max(30)
    .default([])
    .describe(
      "Steps the agent actually inspected. This is an agent report, not server verification.",
    ),
  confidence: z.enum(["low", "medium", "high"]),
  decision: z.enum(["undecided", "adopt", "reject"]).default("undecided"),
  recommended_change: text.optional(),
  experiment: z
    .object({
      hypothesis: text,
      primary_metric: shortText,
      guardrail_metric: shortText,
    })
    .optional(),
  supersedes: recordId.optional(),
});
export const findingSchema = findingInput.extend({
  id: recordId,
  added_at: z.string().datetime(),
  attribution: z.literal("agent_authored"),
});

export const benchmarkSchema = benchmarkInput.extend({
  id: recordId,
  revision,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  project_snapshot: projectSchema.nullable(),
  references: z.array(referenceSchema).max(20),
  findings: z.array(findingSchema).max(300),
});
export type Project = z.infer<typeof projectSchema>;
export type Benchmark = z.infer<typeof benchmarkSchema>;
export type ReferenceInput = z.input<typeof referenceInput>;
export type FindingInput = z.input<typeof findingInput>;
