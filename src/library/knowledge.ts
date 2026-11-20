import { DatabaseSync } from "node:sqlite";
import { access, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { knowledgeInput, cropSchema, type Crop, type KnowledgeInput } from "./knowledge-schema.js";
import { MAX_KNOWLEDGE_REFERENCES, type AutomaticEvidence } from "./knowledge-schema.js";
import { MODEL_KEY, normalize, type ChunkVector } from "./schema.js";
import type { LocalLibrary } from "./store.js";
import { loadLocalImage, localPreview } from "./images.js";
import { imageSimilarity } from "./ranking.js";
import { appKey, selectAppDiverse } from "./diversity.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const key = (value: string) => value.normalize("NFKC").trim().toLowerCase();
type FlowContext = {
  flow_id: string;
  title: string;
  matching_position: number;
  total_steps: number;
  steps: Array<{ screen_id: string; action: string; position: number }>;
  snapshot_at: string;
};
export type KnowledgeRecord = {
  reference_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  kind: "screen" | "component";
  title: string;
  product: string;
  summary: string;
  patterns: string[];
  components: KnowledgeInput["components"];
  observations: string[];
  interpretations: string[];
  visual_details: KnowledgeInput["visual_details"];
  annotation: KnowledgeInput["annotation"];
  automation_evidence?: AutomaticEvidence;
  source: {
    screen_id?: string;
    manifest_sha256?: string;
    source_image_sha256: string;
    source_url?: string;
    original_width: number;
    original_height: number;
    crop?: Crop;
    coordinate_space: string;
    rights: NonNullable<KnowledgeInput["rights"]>;
    flow_ids: string[];
    flow_contexts: FlowContext[];
    flow_errors: Array<{ flow_id: string; error: string }>;
  };
  measured: {
    width: number;
    height: number;
    palette: Array<{ hex: string; fraction: number }>;
    palette_note: string;
  };
};

export async function referenceRaster(bytes: Uint8Array, region?: Crop) {
  await localPreview(bytes); // shared format, byte and pixel limits, even for explicit comparisons
  let image = sharp(bytes, { limitInputPixels: 24_000_000 })
    .rotate()
    .flatten({ background: "white" })
    .removeAlpha();
  const oriented = await image.png().toBuffer({ resolveWithObject: true });
  image = sharp(oriented.data);
  if (region) {
    const crop = cropSchema.parse(region);
    const left = Math.floor(crop.x * oriented.info.width),
      top = Math.floor(crop.y * oriented.info.height);
    const width = Math.min(
      oriented.info.width - left,
      Math.round(crop.width * oriented.info.width),
    );
    const height = Math.min(
      oriented.info.height - top,
      Math.round(crop.height * oriented.info.height),
    );
    if (width < 64 || height < 64)
      throw Error("Component crop must be at least 64×64 rendered pixels.");
    image = image.extract({ left, top, width, height });
  }
  const result = await image.png().toBuffer({ resolveWithObject: true });
  if (result.data.length > 20 * 1024 * 1024)
    throw Error("Normalized reference exceeds 20 MiB; use a smaller image or crop.");
  return { ...result, source_width: oriented.info.width, source_height: oriented.info.height };
}
async function palette(bytes: Uint8Array) {
  const { data } = await sharp(bytes)
    .resize(64, 64, { fit: "inside" })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bins = new Map<string, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 3) {
    const bin = [data[i], data[i + 1], data[i + 2]].map((c) => Math.floor(c / 32)).join(":");
    const item = bins.get(bin) ?? { count: 0, r: 0, g: 0, b: 0 };
    item.count++;
    item.r += data[i];
    item.g += data[i + 1];
    item.b += data[i + 2];
    bins.set(bin, item);
  }
  return [...bins.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((b) => ({
      hex:
        "#" +
        [b.r, b.g, b.b]
          .map((c) =>
            Math.round(c / b.count)
              .toString(16)
              .padStart(2, "0"),
          )
          .join(""),
      fraction: Number((b.count / (data.length / 3)).toFixed(4)),
    }));
}

/** Additive per-installation knowledge index. It never alters imported screenshots or flows. */
export class UIKnowledge {
  constructor(readonly library: LocalLibrary) {}
  private filename() {
    return path.join(this.library.directory, "knowledge.sqlite");
  }
  private async database(write = false) {
    if (!write) {
      try {
        await access(this.filename());
      } catch {
        return undefined;
      }
    }
    if (write) await mkdir(this.library.directory, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.filename(), { readOnly: !write });
    try {
      db.exec("PRAGMA busy_timeout=5000");
      if (write) {
        await chmod(this.filename(), 0o600);
        db.exec(`CREATE TABLE IF NOT EXISTS references_ui(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,record TEXT NOT NULL,image BLOB NOT NULL,hash TEXT NOT NULL,model TEXT NOT NULL,vectors TEXT NOT NULL);
          CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_text USING fts5(reference_id UNINDEXED,content);
          CREATE INDEX IF NOT EXISTS reference_image_model ON references_ui(hash,model);`);
      }
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  async status() {
    const db = await this.database();
    if (!db)
      return {
        references: 0,
        annotated_screens: 0,
        patterns: [],
        components: [],
        note: "No UI knowledge saved yet. Existing screenshots are not automatically labeled.",
      };
    try {
      const records = (
        db.prepare("SELECT record FROM references_ui").all() as Array<{ record: string }>
      ).map((r) => JSON.parse(r.record) as KnowledgeRecord);
      return {
        references: records.length,
        annotated_screens: new Set(records.map((r) => r.source.screen_id).filter(Boolean)).size,
        patterns: [...new Set(records.flatMap((r) => r.patterns))].sort(),
        components: [...new Set(records.flatMap((r) => r.components.map((c) => c.type)))].sort(),
        automatic_references: records.filter((r) => r.annotation.basis === "local_automated")
          .length,
        agent_reviewed_references: records.filter(
          (r) => r.annotation.basis === "agent_inspected" && r.annotation.image_inspected,
        ).length,
        component_references: records.filter((r) => r.kind === "component").length,
        note: "Coverage includes explicit references and clearly labeled unreviewed local-automated records. Inferred patterns/roles are candidates, not verified UI trees. Flow snapshots are excerpts; automation evidence retains all provided flow memberships.",
      };
    } finally {
      db.close();
    }
  }
  async save(raw: KnowledgeInput) {
    const input = knowledgeInput.parse(raw);
    if (
      input.annotation.basis === "local_automated" &&
      (!input.automation_evidence || input.annotation.image_inspected)
    )
      throw Error(
        "Automatic annotations require machine evidence and cannot claim agent image inspection.",
      );
    if (
      [input.screen_id, input.image_path, input.image_base64].filter((v) => v !== undefined)
        .length !== 1
    )
      throw Error("Supply exactly one screen_id, image_path or image_base64.");
    if (input.kind === "screen" && input.crop)
      throw Error("A cropped reference must have kind=component.");
    const sourceStatus = input.screen_id ? await this.library.status() : undefined;
    const sourceScreen = input.screen_id ? await this.library.screen(input.screen_id) : undefined;
    if (!sourceScreen && (!input.rights || !input.product))
      throw Error("Custom image references require product and rights/provenance.");
    if (input.annotation.basis === "local_automated") {
      if (!sourceScreen || !sourceStatus || !("manifest_sha256" in sourceStatus))
        throw Error("Automatic batch annotations require an indexed source.");
      if (
        input.automation_evidence!.source_manifest_sha256 !== sourceStatus.manifest_sha256 ||
        input.automation_evidence!.source_asset_sha256 !== sourceScreen.asset_sha256
      )
        throw Error("Automatic evidence does not match the source image and manifest.");
    }
    const bytes = sourceScreen
      ? Buffer.from(sourceScreen.image.data, "base64")
      : (await loadLocalImage(input))!;
    const raster = await referenceRaster(bytes, input.crop);
    const stamp = new Date().toISOString();
    let rights = input.rights;
    if (sourceScreen) {
      const status = sourceStatus!;
      if (!("dataset" in status)) throw Error("Source dataset provenance is unavailable.");
      const dataset = status.dataset as {
        rights_basis: NonNullable<KnowledgeInput["rights"]>["basis"];
        attribution: string;
        license: string;
        source_url: string;
      };
      rights = {
        basis: dataset.rights_basis,
        attribution: dataset.attribution,
        license: dataset.license,
        source_url: sourceScreen.screen.source_url ?? dataset.source_url,
      };
    }
    const flow_contexts: FlowContext[] = [],
      flow_errors: Array<{ flow_id: string; error: string }> = [];
    for (const id of sourceScreen?.flow_ids.slice(0, 2) ?? []) {
      try {
        const { flow } = await this.library.flow(id);
        const steps = flow.steps as Array<{ screen_id: string; action: string }>;
        const position = steps.findIndex((s) => s.screen_id === input.screen_id);
        if (position < 0) throw Error("Source is not in referenced flow.");
        flow_contexts.push({
          flow_id: id,
          title: flow.title,
          matching_position: position,
          total_steps: steps.length,
          steps: steps.slice(Math.max(0, position - 1), position + 2).map((s, i) => ({
            screen_id: s.screen_id,
            action: s.action.slice(0, 600),
            position: Math.max(0, position - 1) + i,
          })),
          snapshot_at: stamp,
        });
      } catch (error) {
        flow_errors.push({
          flow_id: id,
          error: error instanceof Error ? error.message : "Flow unavailable",
        });
      }
    }
    if (sourceStatus && "manifest_sha256" in sourceStatus) {
      const after = await this.library.status();
      if (!("manifest_sha256" in after) || after.manifest_sha256 !== sourceStatus.manifest_sha256)
        throw Error(
          "Source library changed during annotation; inspect the source again and retry.",
        );
    }
    const rasterHash = hash(raster.data);
    const cacheDb = await this.database();
    let cachedVectors: ChunkVector[] | undefined;
    if (cacheDb) {
      try {
        const cached = cacheDb
          .prepare("SELECT vectors FROM references_ui WHERE hash=? AND model=? LIMIT 1")
          .get(rasterHash, MODEL_KEY) as { vectors: string } | undefined;
        if (cached) cachedVectors = JSON.parse(cached.vectors) as ChunkVector[];
      } finally {
        cacheDb.close();
      }
    }
    const vectors = (cachedVectors ?? (await this.library.imageVectors(raster.data))).map((v) => ({
      ...v,
      vector: normalize(v.vector),
    }));
    const record: KnowledgeRecord = {
      reference_id: input.reference_id ?? `ui-${randomUUID()}`,
      revision: 1,
      created_at: stamp,
      updated_at: stamp,
      kind: input.kind ?? (input.crop ? "component" : "screen"),
      title: input.title,
      product: input.product ?? sourceScreen!.screen.product,
      summary: input.summary,
      patterns: input.patterns,
      components: input.components,
      observations: input.observations,
      interpretations: input.interpretations,
      visual_details: input.visual_details,
      annotation: input.annotation,
      automation_evidence: input.automation_evidence,
      source: {
        screen_id: input.screen_id,
        manifest_sha256:
          sourceStatus && "manifest_sha256" in sourceStatus
            ? sourceStatus.manifest_sha256
            : undefined,
        source_image_sha256: hash(bytes),
        source_url: rights!.source_url,
        original_width: raster.source_width,
        original_height: raster.source_height,
        crop: input.crop,
        coordinate_space: sourceScreen
          ? "Normalized coordinates on the rendered local-screen preview (max 1000×1800), not original device pixels."
          : "Normalized coordinates on the oriented supplied raster.",
        rights: rights!,
        flow_ids: sourceScreen?.flow_ids ?? [],
        flow_contexts,
        flow_errors,
      },
      measured: {
        width: raster.info.width,
        height: raster.info.height,
        palette: await palette(raster.data),
        palette_note:
          "Approximate palette sampled from a 64px raster and quantized RGB bins; not original design tokens.",
      },
    };
    const content = knowledgeSearchContent(record);
    const db = (await this.database(true))!;
    try {
      db.exec("BEGIN IMMEDIATE");
      const current = db
        .prepare("SELECT revision,record FROM references_ui WHERE id=?")
        .get(record.reference_id) as { revision: number; record: string } | undefined;
      if ((current?.revision ?? 0) !== (input.expected_revision ?? 0))
        throw Error("Knowledge revision conflict: read the current reference before updating it.");
      if (
        !current &&
        (db.prepare("SELECT count(*) AS n FROM references_ui").get() as { n: number }).n >=
          MAX_KNOWLEDGE_REFERENCES
      )
        throw Error(
          "Knowledge capacity is 10,000 references, including curated components and automatic screen records.",
        );
      if (current) {
        record.revision = current.revision + 1;
        record.created_at = (JSON.parse(current.record) as KnowledgeRecord).created_at;
      }
      const serialized = JSON.stringify(record);
      db.prepare("INSERT OR REPLACE INTO references_ui VALUES(?,?,?,?,?,?,?)").run(
        record.reference_id,
        record.revision,
        serialized,
        raster.data,
        rasterHash,
        MODEL_KEY,
        JSON.stringify(vectors),
      );
      db.prepare("DELETE FROM knowledge_text WHERE reference_id=?").run(record.reference_id);
      db.prepare("INSERT INTO knowledge_text VALUES(?,?)").run(record.reference_id, content);
      db.exec("COMMIT");
      return JSON.parse(serialized) as KnowledgeRecord;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* no active transaction */
      }
      throw error;
    } finally {
      db.close();
    }
  }
  /** Explicit maintenance step used after a bulk generation; preserves all records/images. */
  async rebuildKeywords() {
    const db = (await this.database(true))!;
    try {
      db.exec("BEGIN IMMEDIATE");
      const records = db.prepare("SELECT id,record FROM references_ui").all() as Array<{
        id: string;
        record: string;
      }>;
      db.exec("DELETE FROM knowledge_text");
      const insert = db.prepare("INSERT INTO knowledge_text VALUES(?,?)");
      for (const item of records)
        insert.run(item.id, knowledgeSearchContent(JSON.parse(item.record) as KnowledgeRecord));
      db.exec("COMMIT");
      return { indexed_references: records.length };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* no transaction */
      }
      throw error;
    } finally {
      db.close();
    }
  }
  async get(id: string) {
    const db = await this.database();
    if (!db) throw Error("No UI knowledge saved yet.");
    try {
      const row = db.prepare("SELECT record,image FROM references_ui WHERE id=?").get(id) as
        | { record: string; image: Uint8Array }
        | undefined;
      if (!row) throw Error("UI reference not found.");
      return {
        record: JSON.parse(row.record) as KnowledgeRecord,
        image: await localPreview(row.image),
        bytes: Buffer.from(row.image),
      };
    } finally {
      db.close();
    }
  }
  async search(input: {
    query?: string;
    image?: Uint8Array;
    crop?: Crop;
    pattern?: string;
    component?: string;
    product?: string;
    kind?: "screen" | "component";
    result_mode?: "closest" | "app_diverse";
    limit?: number;
    exclude_reference_id?: string;
    annotation_scope?: "all" | "reviewed" | "automated";
  }) {
    if (input.query !== undefined && input.image)
      throw Error("Use a text query or image, not both.");
    if (input.crop && !input.image) throw Error("Query crop requires an image.");
    if (input.query !== undefined && (!input.query.trim() || input.query.length > 500))
      throw Error("Query must contain 1–500 characters.");
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw Error("Limit must be 1–20.");
    if (input.result_mode && !["closest", "app_diverse"].includes(input.result_mode))
      throw Error("Unknown result mode.");
    if (
      input.annotation_scope &&
      !["all", "reviewed", "automated"].includes(input.annotation_scope)
    )
      throw Error("Unknown annotation scope.");
    const db = await this.database();
    if (!db)
      return {
        results: [],
        searched_references: 0,
        note: "No UI knowledge saved yet; annotate or add references first.",
      };
    try {
      const excluded = input.exclude_reference_id
        ? (db
            .prepare("SELECT hash FROM references_ui WHERE id=?")
            .get(input.exclude_reference_id) as { hash: string } | undefined)
        : undefined;
      if (input.exclude_reference_id && !excluded) throw Error("Source UI reference not found.");
      const rows = (
        db.prepare("SELECT id,record,hash,model,vectors FROM references_ui").all() as Array<{
          id: string;
          record: string;
          hash: string;
          model: string;
          vectors: string;
        }>
      )
        .map((r) => ({ ...r, reference: JSON.parse(r.record) as KnowledgeRecord }))
        .filter(
          (r) =>
            (!excluded || r.hash !== excluded.hash) &&
            (!input.annotation_scope ||
              input.annotation_scope === "all" ||
              (input.annotation_scope === "automated"
                ? r.reference.annotation.basis === "local_automated"
                : r.reference.annotation.basis !== "local_automated" &&
                  r.reference.annotation.image_inspected)) &&
            (!input.pattern || r.reference.patterns.some((p) => key(p) === key(input.pattern!))) &&
            (!input.component ||
              r.reference.components.some((c) => key(c.type) === key(input.component!))) &&
            (!input.product || appKey(r.reference.product) === appKey(input.product)) &&
            (!input.kind || r.reference.kind === input.kind),
        );
      if (rows.some((r) => r.model !== MODEL_KEY))
        throw Error(
          "Knowledge embedding fingerprint differs; re-save references with the current model.",
        );
      const raster = input.image ? await referenceRaster(input.image, input.crop) : undefined;
      const queryVectors = raster
        ? await this.library.imageVectors(raster.data)
        : input.query
          ? [{ region: "full", vector: await this.library.textVector(input.query) }]
          : undefined;
      queryVectors?.forEach((v) => (v.vector = normalize(v.vector)));
      const queryHash = raster ? hash(raster.data) : undefined;
      const scored = rows
        .map((r) => {
          const vectors = JSON.parse(r.vectors) as ChunkVector[];
          vectors.forEach((v) => (v.vector = normalize(v.vector)));
          return {
            ...r,
            exact: Boolean(queryHash && queryHash === r.hash),
            cosine: queryVectors
              ? raster
                ? imageSimilarity(queryVectors, vectors)
                : Math.max(
                    ...vectors.map((v) =>
                      v.vector.reduce((s, x, i) => s + x * queryVectors[0].vector[i], 0),
                    ),
                  )
              : 0,
          };
        })
        .sort(
          (a, b) =>
            Number(b.exact) - Number(a.exact) || b.cosine - a.cosine || a.id.localeCompare(b.id),
        );
      const keywords = new Map<string, number>();
      const terms = input.query?.match(/[\p{L}\p{N}]{2,}/gu)?.slice(0, 16) ?? [];
      if (terms.length) {
        const allowed = new Set(rows.map((r) => r.id));
        (
          db
            .prepare(
              "SELECT reference_id FROM knowledge_text WHERE knowledge_text MATCH ? ORDER BY bm25(knowledge_text)",
            )
            .all(terms.map((t) => `"${t}"`).join(" OR ")) as Array<{ reference_id: string }>
        )
          .filter((r) => allowed.has(r.reference_id))
          .forEach((r, i) => keywords.set(r.reference_id, i + 1));
      }
      const ranked = scored
        .map((r, i) => ({
          ...r,
          score: 1 / (61 + i) + (keywords.has(r.id) ? 1 / (60 + keywords.get(r.id)!) : 0),
        }))
        .sort(
          (a, b) =>
            Number(b.exact) - Number(a.exact) || b.score - a.score || a.id.localeCompare(b.id),
        );
      const seen = new Set<string>();
      const distinct = ranked.filter((r) => {
        if (seen.has(r.hash)) return false;
        seen.add(r.hash);
        return true;
      });
      const selected =
        input.result_mode === "app_diverse"
          ? selectAppDiverse(distinct, (r) => r.reference.product, limit, 1)
          : distinct.slice(0, limit);
      return {
        results: selected.map((r) => ({
          reference_id: r.id,
          related_reference_ids: ranked
            .filter((other) => other.hash === r.hash && other.id !== r.id)
            .map((other) => other.id),
          related_flow_ids: [
            ...new Set(
              ranked
                .filter((other) => other.hash === r.hash)
                .flatMap((other) => other.reference.source.flow_ids),
            ),
          ],
          reference: compactKnowledge(r.reference),
          cosine_similarity: r.cosine,
          rank_score: r.score,
          exact_image_match: r.exact,
        })),
        searched_references: rows.length,
        result_mode: input.result_mode ?? "closest",
        annotation_scope: input.annotation_scope ?? "all",
        note: "Annotation-assisted local retrieval; curated entries are user/agent authored; automated entries are unreviewed OCR/CLIP/rule candidates. Scores are not match percentages. Exact stored-image duplicates are grouped. Flow context is a saved excerpt, not verified navigation. Inspect returned images before recommending a reference.",
      };
    } finally {
      db.close();
    }
  }
}

/** Keep bulk OCR boxes out of every search/comparison response; get returns the full JSON. */
export function compactKnowledge(record: KnowledgeRecord) {
  const { automation_evidence, ...reference } = record;
  return {
    ...reference,
    automation_summary: automation_evidence
      ? {
          pipeline_version: automation_evidence.pipeline_version,
          ocr_regions: automation_evidence.ocr.text.length,
          ocr_excerpt: automation_evidence.ocr.text
            .map((t) => t.text)
            .join(" | ")
            .slice(0, 600),
          pattern_candidates: automation_evidence.pattern_candidates,
          layout_candidate: automation_evidence.layout_candidate,
          flow_memberships: automation_evidence.flow_memberships.length,
          note: "Machine-generated, unreviewed candidates. Use get for full OCR boxes, component evidence and all provided flow memberships.",
        }
      : undefined,
  };
}

export function knowledgeSearchContent(record: KnowledgeRecord) {
  return [
    record.title,
    record.summary,
    ...record.patterns,
    ...record.components.flatMap((c) => [c.type, c.description]),
    ...record.observations,
    ...record.interpretations,
    ...record.visual_details.flatMap((v) => [v.attribute, v.value]),
    ...(record.automation_evidence?.ocr.text.map((t) => t.text) ?? []),
  ].join("\n");
}
