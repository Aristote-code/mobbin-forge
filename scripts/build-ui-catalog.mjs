/** Generate all 1,000 authorized screen descriptions using only local evidence. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { runOcrCache, directory, cacheDirectory } from "./cache-ui-ocr.mjs";
import { LocalLibrary } from "../dist/library/store.js";
import { UIKnowledge } from "../dist/library/knowledge.js";
import { MODEL_KEY, manifestSchema, normalize } from "../dist/library/schema.js";
import {
  CATALOG_VERSION,
  CATALOG_TAXONOMY,
  buildAutomaticDescription,
  completeFlowMemberships,
  catalogReferenceId,
} from "../dist/library/catalog.js";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const prepared = await runOcrCache();
const manifest = manifestSchema.parse(prepared.manifest);
const exportDir = path.join(directory, "catalog");
await fs.mkdir(path.join(exportDir, "screens"), { recursive: true, mode: 0o700 });
const sourceDb = new DatabaseSync(path.join(directory, "library.sqlite"), { readOnly: true });
if (sourceDb.prepare("SELECT value FROM metadata WHERE key='model'").get().value !== MODEL_KEY)
  throw Error("Source embedding model mismatch.");
const sources = sourceDb.prepare("SELECT id,asset_hash FROM screens").all();
const byId = new Map(sources.map((r) => [r.id, r.asset_hash]));
const vectors = new Map();
for (const row of sourceDb.prepare("SELECT hash,region,vector FROM vectors").all()) {
  const b = Buffer.from(row.vector);
  const vector = normalize(Array.from({ length: 512 }, (_, i) => b.readFloatLE(i * 4)));
  const list = vectors.get(row.hash) ?? [];
  list.push({ region: row.region, vector });
  vectors.set(row.hash, list);
}
sourceDb.close();
const library = new LocalLibrary();
const knowledge = new UIKnowledge(library);
globalThis.fetch = async () => {
  throw Error("Network forbidden during catalog inference");
};
async function atomic(file, record) {
  const tmp = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}
const taxonomyKey = hash(MODEL_KEY + JSON.stringify(CATALOG_TAXONOMY));
const promptFile = path.join(directory, "catalog-cache/prompts.json");
try {
  let prompts;
  try {
    const saved = JSON.parse(await fs.readFile(promptFile));
    if (saved.key === taxonomyKey) prompts = saved.prompts;
  } catch {}
  if (!prompts) {
    prompts = [];
    for (const [kind, labels] of Object.entries(CATALOG_TAXONOMY))
      for (const [label, description] of Object.entries(labels)) {
        prompts.push({
          kind,
          label,
          vector: await library.textVector("A screenshot of " + description + "."),
        });
      }
    await atomic(promptFile, { key: taxonomyKey, prompts });
  }
  prompts.forEach((p) => (p.vector = normalize(p.vector)));
  const flows = completeFlowMemberships(manifest);
  const records = new Array(manifest.screens.length);
  const errors = [];
  let next = 0,
    done = 0,
    reused = 0;
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (next < manifest.screens.length) {
        const index = next++;
        const screen = manifest.screens[index];
        try {
          const sha = byId.get(screen.id);
          if (!sha) throw Error("Source screen not installed.");
          const id = catalogReferenceId(screen.id);
          let record;
          try {
            const existing = (await knowledge.get(id)).record;
            if (existing.annotation.basis !== "local_automated") {
              record = existing;
              reused++;
            } else if (
              existing.automation_evidence?.pipeline_version === CATALOG_VERSION &&
              existing.automation_evidence?.model_key === MODEL_KEY &&
              existing.automation_evidence?.source_asset_sha256 === sha &&
              existing.source.manifest_sha256 === prepared.metadata.manifest_sha256
            ) {
              record = existing;
              reused++;
            }
          } catch (e) {
            if (!/not found|No UI knowledge saved/.test(String(e))) throw e;
          }
          if (!record) {
            const cached = JSON.parse(await fs.readFile(path.join(cacheDirectory, sha + ".json")));
            if (
              cached.cache_key !== prepared.cacheKey ||
              cached.source_sha256 !== sha ||
              !cached.result.ok
            )
              throw Error("OCR evidence cache mismatch.");
            const { ok, ...ocr } = cached.result;
            void ok;
            const input = buildAutomaticDescription({
              screen,
              sourceSha: sha,
              manifestSha: prepared.metadata.manifest_sha256,
              ocr,
              vectors: vectors.get(sha),
              prompts,
              flows: flows.get(screen.id) ?? [],
            });
            let current;
            try {
              current = (await knowledge.get(id)).record;
            } catch (e) {
              if (!/not found|No UI knowledge saved/.test(String(e))) throw e;
            }
            if (current?.annotation.basis === "local_automated")
              input.expected_revision = current.revision;
            else if (current)
              throw Error("Reference was reviewed concurrently; preserve it and rerun.");
            record = await knowledge.save(input);
          }
          if (record.source.screen_id !== screen.id) throw Error("Saved source ID differs.");
          const filename = path.join(exportDir, "screens", screen.id + ".json");
          await atomic(filename, record);
          records[index] = record;
          done++;
          if (done % 25 === 0)
            console.log(
              JSON.stringify({ phase: "structured_json", completed: done, total: 1000, reused }),
            );
        } catch (e) {
          errors.push({ screen_id: screen.id, error: String(e) });
        }
      }
    }),
  );
  const missing = manifest.screens.filter((_, i) => !records[i]).map((s) => s.id);
  const coverage = {
    pipeline_version: CATALOG_VERSION,
    generated_at: new Date().toISOString(),
    source_manifest_sha256: prepared.metadata.manifest_sha256,
    expected: 1000,
    completed: done,
    reused,
    distinct_source_ids: new Set(records.filter(Boolean).map((r) => r.source.screen_id)).size,
    automatic_unreviewed: records.filter((r) => r?.annotation.basis === "local_automated").length,
    text_regions: records.reduce((s, r) => s + (r?.automation_evidence?.ocr.text.length ?? 0), 0),
    empty_ocr: records
      .filter((r) => r?.automation_evidence?.ocr.text.length === 0)
      .map((r) => r.source.screen_id),
    flow_memberships: records.reduce(
      (s, r) => s + (r?.automation_evidence?.flow_memberships.length ?? 0),
      0,
    ),
    missing,
    errors,
    keyword_index: await knowledge.rebuildKeywords(),
    knowledge_status: await knowledge.status(),
    limitations:
      "Complete file coverage, not verified semantic completeness. Automatic roles and patterns are unreviewed suggestions. No original fonts/CSS/tokens or unseen interactions are claimed.",
  };
  await atomic(path.join(exportDir, "coverage.json"), coverage);
  if (errors.length || missing.length || done !== 1000)
    throw Error(
      "Catalog incomplete. Successful records are saved and resumable; inspect coverage.json.",
    );
  await fs.writeFile(
    path.join(exportDir, "screens.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    { mode: 0o600 },
  );
  await atomic(path.join(exportDir, "index.json"), {
    source_manifest_sha256: prepared.metadata.manifest_sha256,
    records: records.map((r) => ({
      screen_id: r.source.screen_id,
      reference_id: r.reference_id,
      revision: r.revision,
      file: "screens/" + r.source.screen_id + ".json",
      annotation_basis: r.annotation.basis,
    })),
  });
  console.log(
    JSON.stringify({
      passed: true,
      completed: done,
      records: path.join(exportDir, "screens.jsonl"),
      coverage: path.join(exportDir, "coverage.json"),
    }),
  );
} finally {
  await library.close();
}
