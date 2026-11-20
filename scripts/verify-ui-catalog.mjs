/** Verify full export coverage and exercise bulk JSON through the real local MCP. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { automaticEvidenceSchema } from "../dist/library/knowledge-schema.js";
import { manifestSchema } from "../dist/library/schema.js";
import { LocalLibrary } from "../dist/library/store.js";
import { UIKnowledge } from "../dist/library/knowledge.js";
import {
  CATALOG_VERSION,
  completeFlowMemberships,
  catalogReferenceId,
} from "../dist/library/catalog.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = process.env.MOBBIN_LIBRARY_DIR ?? path.join(os.homedir(), ".mobbin-mcp/library");
const manifestBytes = await fs.readFile(
  process.env.MOBBIN_CATALOG_MANIFEST ??
    path.join(os.homedir(), ".mobbin-mcp/pilot/openmobile/manifest.json"),
);
const manifest = manifestSchema.parse(JSON.parse(manifestBytes));
const sha = createHash("sha256").update(manifestBytes).digest("hex");
const out = path.join(root, "output/verification/ui-catalog");
await fs.mkdir(out, { recursive: true });
const coverage = JSON.parse(await fs.readFile(path.join(directory, "catalog/coverage.json")));
assert.equal(coverage.pipeline_version, CATALOG_VERSION);
assert.equal(coverage.completed, 1000);
assert.equal(coverage.distinct_source_ids, 1000);
assert.equal(coverage.source_manifest_sha256, sha);
assert.deepEqual(coverage.errors, []);
assert.deepEqual(coverage.missing, []);
const index = JSON.parse(await fs.readFile(path.join(directory, "catalog/index.json")));
assert.equal(index.records.length, 1000);
assert.equal(new Set(index.records.map((r) => r.screen_id)).size, 1000);
const lines = (await fs.readFile(path.join(directory, "catalog/screens.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((s) => JSON.parse(s));
assert.equal(lines.length, 1000);
assert.equal(new Set(lines.map((r) => r.source.screen_id)).size, 1000);
const flows = completeFlowMemberships(manifest);
const sourceDb = new DatabaseSync(path.join(directory, "library.sqlite"), { readOnly: true });
const sources = new Map(
  sourceDb
    .prepare("SELECT id,asset_hash FROM screens")
    .all()
    .map((r) => [r.id, r.asset_hash]),
);
sourceDb.close();
let textRegions = 0,
  memberships = 0;
const records = [];
for (const screen of manifest.screens) {
  const record = JSON.parse(
    await fs.readFile(path.join(directory, "catalog/screens", screen.id + ".json")),
  );
  assert.equal(record.reference_id, catalogReferenceId(screen.id));
  assert.equal(record.source.screen_id, screen.id);
  assert.equal(record.source.manifest_sha256, sha);
  assert.equal(record.annotation.basis, "local_automated");
  assert.equal(record.annotation.image_inspected, false);
  const evidence = automaticEvidenceSchema.parse(record.automation_evidence);
  assert.equal(evidence.source_asset_sha256, sources.get(screen.id));
  assert.equal(evidence.source_manifest_sha256, sha);
  assert.deepEqual(
    evidence.flow_memberships,
    JSON.parse(JSON.stringify(flows.get(screen.id) ?? [])),
  );
  assert(
    record.patterns.length > 0 && record.components.length > 0 && record.visual_details.length > 0,
  );
  assert(
    record.measured.width > 0 && record.measured.height > 0 && record.measured.palette.length > 0,
  );
  textRegions += evidence.ocr.text.length;
  memberships += evidence.flow_memberships.length;
  records.push(record);
}
const library = new LocalLibrary(directory);
const knowledge = new UIKnowledge(library);
const rebuild = await knowledge.rebuildKeywords();
// A label outside the title/excerpt still has to be searchable in its own full OCR text.
const db = new DatabaseSync(path.join(directory, "knowledge.sqlite"), { readOnly: true });
let checked = 0;
for (const record of records) {
  for (const row of record.automation_evidence.ocr.text.slice(8)) {
    const word = row.text.match(/[A-Za-z]{6,}/)?.[0];
    if (!word) continue;
    assert(
      db
        .prepare(
          "SELECT reference_id FROM knowledge_text WHERE reference_id=? AND knowledge_text MATCH ?",
        )
        .get(record.reference_id, '"' + word + '"'),
    );
    checked++;
    break;
  }
  if (checked >= 20) break;
}
db.close();
assert.equal(checked, 20);
const client = new Client({ name: "full-ui-catalog-verification", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist/index.js"), "library", "serve"],
  stderr: "pipe",
  env: {
    PATH: process.env.PATH ?? "",
    HOME: os.homedir(),
    ...(process.env.MOBBIN_LIBRARY_DIR
      ? { MOBBIN_LIBRARY_DIR: process.env.MOBBIN_LIBRARY_DIR }
      : {}),
  },
});
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  assert(!r.isError, JSON.stringify(r));
  return r;
};
try {
  await client.connect(transport);
  const status = (await call("mobbin_ui_knowledge_status", {})).structuredContent;
  assert.equal(status.automatic_references, 1000);
  assert(status.agent_reviewed_references >= 9);
  const source = (await call("mobbin_local_library_status", {})).structuredContent;
  assert.equal(source.screens, 1000);
  assert.equal(source.flows, 115);
  assert.equal(source.manifest_sha256, sha);
  const auto = (
    await call("mobbin_search_ui_knowledge", {
      query: "settings save",
      annotation_scope: "automated",
      limit: 4,
    })
  ).structuredContent;
  assert(
    auto.results.length > 0 &&
      auto.results.every(
        (r) =>
          r.reference.annotation.basis === "local_automated" &&
          !r.reference.automation_evidence &&
          r.reference.automation_summary,
      ),
  );
  const reviewed = (
    await call("mobbin_search_ui_knowledge", {
      component: "card",
      annotation_scope: "reviewed",
      limit: 10,
    })
  ).structuredContent;
  assert(
    reviewed.results.length >= 3 &&
      reviewed.results.every(
        (r) =>
          r.reference.annotation.basis !== "local_automated" &&
          r.reference.annotation.image_inspected,
      ),
  );
  const sample = await call("mobbin_get_ui_reference", { reference_id: records[50].reference_id });
  assert(sample.content.some((b) => b.type === "image"));
  assert(sample.structuredContent.reference.automation_evidence.ocr.text.length > 0);
  const compare = await call("mobbin_compare_ui_references", {
    source_reference_id: records[50].reference_id,
    candidate_reference_ids: [
      auto.results.find((r) => r.reference_id !== records[50].reference_id).reference_id,
      "missing-catalog-reference",
    ],
  });
  assert.equal(compare.structuredContent.visual_judgment, "pending_agent_inspection");
  assert.equal(compare.structuredContent.candidates[1].image_status, "unavailable");
  const cells = [];
  const samples = [];
  for (let i = 0; i < 8; i++) {
    const record = records[Math.floor((i * records.length) / 8)];
    const image = (await library.screen(record.source.screen_id)).image;
    const bbox = record.automation_evidence.ocr.text
      .map(
        (t) =>
          `<rect x="${t.bounds.x * 180}" y="${t.bounds.y * 400}" width="${t.bounds.width * 180}" height="${t.bounds.height * 400}" fill="none" stroke="#00ff66" stroke-width="0.65"/>`,
      )
      .join("");
    const png = await sharp(Buffer.from(image.data, "base64"))
      .resize(180, 400, { fit: "fill" })
      .composite([{ input: Buffer.from(`<svg width="180" height="400">${bbox}</svg>`) }])
      .png()
      .toBuffer();
    const left = (i % 4) * 188,
      top = Math.floor(i / 4) * 430 + 25;
    cells.push({ input: png, left, top });
    cells.push({
      input: Buffer.from(
        `<svg width="180" height="25"><rect width="180" height="25" fill="white"/><text x="4" y="17" font-size="13">Screen ${Math.floor((i * records.length) / 8)} | OCR ${record.automation_evidence.ocr.text.length}</text></svg>`,
      ),
      left,
      top: top - 25,
    });
    samples.push({
      screen_id: record.source.screen_id,
      reference_id: record.reference_id,
      patterns: record.patterns,
      components: record.components.map((c) => c.type),
      summary: record.summary,
    });
  }
  await sharp({ create: { width: 752, height: 860, channels: 3, background: "#ddd" } })
    .composite(cells)
    .png()
    .toFile(path.join(out, "ocr-spot-check.png"));
  await fs.writeFile(path.join(out, "spot-check.json"), JSON.stringify(samples, null, 2));
  const receipt = {
    passed: true,
    source_screens: 1000,
    json_records: records.length,
    ocr_text_regions: textRegions,
    provided_flow_memberships: memberships,
    deep_ocr_keyword_checks: checked,
    keyword_rebuild: rebuild,
    status,
    source_status: source,
    automatic_search: auto,
    reviewed_search: reviewed,
    limitations:
      "All 1,000 files are present. Machine-generated labels are unreviewed candidates, not verified UI component trees or design tokens. Eight sampled OCR overlays are for inspection, not a relevance benchmark.",
  };
  await fs.writeFile(path.join(out, "acceptance.json"), JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify({
      passed: true,
      json_records: 1000,
      ocr_text_regions: textRegions,
      provided_flow_memberships: memberships,
      reviewed_references: status.agent_reviewed_references,
      receipt: path.join(out, "acceptance.json"),
    }),
  );
} finally {
  await client.close();
  await library.close();
}
