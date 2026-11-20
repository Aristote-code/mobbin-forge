import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  CATALOG_TAXONOMY,
  buildAutomaticDescription,
  completeFlowMemberships,
  catalogReferenceId,
  headingText,
  type OcrEvidence,
  type PromptVector,
} from "../src/library/catalog.js";
import { MODEL, MODEL_KEY, type Manifest, type EmbeddingEngine } from "../src/library/schema.js";
import { LocalLibrary } from "../src/library/store.js";
import { UIKnowledge } from "../src/library/knowledge.js";
import {
  automaticEvidenceSchema,
  MAX_KNOWLEDGE_REFERENCES,
} from "../src/library/knowledge-schema.js";

const vector = (n: number) => Array.from({ length: MODEL.dimensions }, (_, i) => (i === n ? 1 : 0));
const bounds = { x: 0.1, y: 0.1, width: 0.2, height: 0.03 };
const ocr: OcrEvidence = {
  engine: "Mock local OCR",
  revision: 3,
  width: 200,
  height: 400,
  coordinate_space: "normalized top-left original raster",
  recognition_languages: ["en-US"],
  text_truncated: false,
  text: [
    { text: "Settings", confidence: 0.99, bounds },
    { text: "Save", confidence: 0.99, bounds: { ...bounds, y: 0.8 } },
    { text: "Name", confidence: 0.99, bounds: { ...bounds, y: 0.4 } },
  ],
  rectangles: [{ confidence: 0.8, bounds: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 } }],
};
const prompts: PromptVector[] = [
  { kind: "pattern", label: "settings", vector: vector(0) },
  { kind: "pattern", label: "time-selection", vector: vector(1) },
  { kind: "component", label: "card", vector: vector(0) },
  { kind: "layout", label: "single-column", vector: vector(0) },
];
const manifest: Manifest = {
  schema_version: 1,
  dataset: {
    id: "test",
    title: "Owned",
    source_url: "https://example.org/",
    license: "Owned",
    license_url: "https://example.org/rights",
    attribution: "Owned fixtures",
    rights_basis: "owned",
  },
  screens: [
    {
      id: "screen-a",
      title: "Task goal says time picker",
      product: "Example A",
      platform: "android",
      image: "a.png",
      text: "Time picker task goal is not visual evidence",
      tags: [],
    },
  ],
  flows: [
    {
      id: "flow-a",
      title: "Flow",
      goal: "Goal metadata is not visual evidence",
      complete: true,
      steps: [
        { screen_id: "screen-a", source_step: 0, action: "First" },
        { screen_id: "screen-a", source_step: 3, action: "Repeated occurrence" },
      ],
    },
    {
      id: "flow-b",
      title: "Other context",
      goal: "Other",
      complete: true,
      steps: [{ screen_id: "screen-a", source_step: 7, action: "Other action" }],
    },
  ],
};
const make = (sha = "a".repeat(64), manifestSha = "b".repeat(64)) =>
  buildAutomaticDescription({
    screen: manifest.screens[0],
    sourceSha: sha,
    manifestSha,
    ocr,
    vectors: [{ region: "full", vector: vector(0) }],
    prompts,
    flows: completeFlowMemberships(manifest).get("screen-a")!,
  });

test("automatic descriptions label provenance and keep text geometry distinct from actual component bounds", () => {
  const input = make();
  const evidence = input.automation_evidence!;
  assert.equal(input.annotation.basis, "local_automated");
  assert.equal(input.annotation.image_inspected, false);
  assert.equal(evidence.model_key, MODEL_KEY);
  const action = evidence.component_candidates.find((c) => c.label === "Save")!;
  assert.equal(action.type, "button");
  assert.equal(action.bounds_scope, "text_only");
  assert.match(action.evidence, /unverified/);
  const rect = evidence.component_candidates.find((c) => c.basis === "rectangle_detector")!;
  assert.equal(rect.type, "container-candidate");
  assert.equal(rect.bounds_scope, "rectangle_only");
  assert.ok(
    !evidence.pattern_candidates.some(
      (c) => c.label === "time-selection" && c.basis === "visible_text_rule",
    ),
  );
  assert.ok(
    evidence.pattern_candidates.some(
      (c) => c.label === "settings" && c.basis === "visible_text_rule",
    ),
  );
  assert.ok(input.visual_details.every((d) => d.basis === "estimated"));
  assert.match(evidence.limitations.join(" "), /not visually reviewed/);
  assert.equal(catalogReferenceId("screen-a"), input.reference_id);
  assert.ok(MAX_KNOWLEDGE_REFERENCES >= 1000 + 11);
});

test("heading rules ignore toolbar icon glyphs OCR attaches to a title but keep the raw text", () => {
  assert.equal(headingText("< Edit Event"), "Edit Event");
  assert.equal(headingText("× Create contact"), "Create contact");
  assert.equal(headingText("x Create contact"), "Create contact");
  assert.equal(headingText("Xbox"), "Xbox");
  for (const title of ["< Edit Event", "× Create contact", "x Create contact"]) {
    const input = buildAutomaticDescription({
      screen: manifest.screens[0],
      sourceSha: "a".repeat(64),
      manifestSha: "b".repeat(64),
      ocr: { ...ocr, text: [{ text: title, confidence: 0.95, bounds }] },
      vectors: [{ region: "full", vector: vector(0) }],
      prompts,
      flows: [],
    });
    assert.deepEqual(input.patterns, ["form-entry"], title);
    assert.equal(input.automation_evidence!.ocr.text[0].text, title);
  }
});

test("flow evidence includes every occurrence and does not invent links at trace boundaries", () => {
  const flows = completeFlowMemberships(manifest).get("screen-a")!;
  assert.equal(flows.length, 3);
  assert.equal(flows[0].previous_screen_id, undefined);
  assert.equal(flows[0].next_screen_id, "screen-a");
  assert.equal(flows[1].source_step, 3);
  assert.equal(flows[1].next_screen_id, undefined);
  assert.equal(flows[2].flow_id, "flow-b");
  assert.equal(flows[2].source_step, 7);
});

test("blank OCR preserves unknown detail and unreviewed visual candidates without fabricated text", () => {
  const input = buildAutomaticDescription({
    screen: manifest.screens[0],
    sourceSha: "a".repeat(64),
    manifestSha: "b".repeat(64),
    ocr: { ...ocr, text: [], rectangles: [] },
    vectors: [{ region: "full", vector: vector(0) }],
    prompts,
    flows: [],
  });
  assert.match(input.summary, /no reliable text/);
  assert.equal(input.automation_evidence!.ocr.text.length, 0);
  assert.equal(input.automation_evidence!.flow_memberships.length, 0);
  assert.equal(input.annotation.image_inspected, false);
  assert.ok(
    input.automation_evidence!.pattern_candidates.every((p) => p.basis === "clip_similarity"),
  );
  assert.throws(() =>
    automaticEvidenceSchema.parse({ ...input.automation_evidence, source_asset_sha256: "bad" }),
  );
  assert.ok(Object.keys(CATALOG_TAXONOMY.component).includes("card"));
});

test("automatic knowledge requires matching indexed evidence, stays searchable separately and preserves curated entries", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ui-catalog-"));
  const engine: EmbeddingEngine = {
    setup: async () => MODEL,
    close: async () => {},
    image: async () => [{ region: "full", vector: vector(0) }],
    text: async () => vector(0),
  };
  const lib = new LocalLibrary(root, engine);
  t.after(async () => {
    await lib.close();
    await rm(root, { recursive: true, force: true });
  });
  const image = await sharp({ create: { width: 200, height: 400, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  await writeFile(path.join(root, "a.png"), image);
  const mf = path.join(root, "manifest.json");
  await writeFile(mf, JSON.stringify(manifest));
  const status = await lib.importManifest(mf);
  const store = new UIKnowledge(lib);
  const sha = createHash("sha256").update(image).digest("hex");
  const auto = make(sha, status.manifest_sha256!);
  await store.save({
    ...auto,
    reference_id: "aaa-curated",
    annotation: { author: "Native reviewer", basis: "agent_inspected", image_inspected: true },
    automation_evidence: undefined,
  });
  await store.save(auto);
  assert.equal((await store.status()).automatic_references, 1);
  assert.equal((await store.status()).agent_reviewed_references, 1);
  const reviewed = await store.search({ query: "settings", annotation_scope: "reviewed" });
  assert.equal(reviewed.results.length, 1);
  assert.equal(reviewed.results[0].reference_id, "aaa-curated");
  const automated = await store.search({ query: "settings", annotation_scope: "automated" });
  assert.equal(automated.results.length, 1);
  assert.equal(automated.results[0].reference.automation_summary!.ocr_regions, 3);
  assert.ok(!("automation_evidence" in automated.results[0].reference));
  assert.equal((await store.rebuildKeywords()).indexed_references, 2);
  const full = await store.get(auto.reference_id!);
  assert.equal(full.record.automation_evidence!.ocr.text[1].text, "Save");
  assert.equal(full.record.automation_evidence!.flow_memberships.length, 3);
  await assert.rejects(
    store.save({
      ...auto,
      reference_id: "wrong",
      automation_evidence: { ...auto.automation_evidence!, source_asset_sha256: "f".repeat(64) },
    }),
    /does not match/,
  );
  await assert.rejects(
    store.save({
      ...auto,
      reference_id: "false-review",
      annotation: { ...auto.annotation, image_inspected: true },
    }),
    /cannot claim/,
  );
  await assert.rejects(
    store.save({ ...auto, reference_id: "no-evidence", automation_evidence: undefined }),
    /require machine evidence/,
  );
  assert.equal((await store.status()).references, 2);
});
