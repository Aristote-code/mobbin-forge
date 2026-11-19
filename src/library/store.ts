import { DatabaseSync } from "node:sqlite";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  manifestSchema,
  MODEL,
  MODEL_KEY,
  normalize,
  type ChunkVector,
  type EmbeddingEngine,
} from "./schema.js";
import { LocalEmbedder } from "./embedder.js";
import { imageSimilarity } from "./ranking.js";
import { fingerprint, nearDuplicate, type Fingerprint } from "./deduplication.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const exists = async (filename: string) => {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
};
function cosine(a: number[], b: number[]) {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}
function vectorBytes(values: number[]) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes;
}
function readVector(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (b.length !== MODEL.dimensions * 4) throw Error("Stored vector has incorrect dimensions.");
  return normalize(
    Array.from({ length: MODEL.dimensions }, (_, index) => b.readFloatLE(index * 4)),
  );
}
export class LocalLibrary {
  readonly directory: string;
  private engine: EmbeddingEngine;
  private fingerprints = new Map<string, Promise<Fingerprint>>();
  constructor(directory?: string, engine?: EmbeddingEngine) {
    this.directory = path.resolve(
      directory ?? process.env.MOBBIN_LIBRARY_DIR ?? path.join(homedir(), ".mobbin-mcp", "library"),
    );
    this.engine = engine ?? new LocalEmbedder(path.join(this.directory, "models"));
  }
  private filename() {
    return path.join(this.directory, "library.sqlite");
  }
  async close() {
    this.fingerprints.clear();
    await this.engine.close();
  }
  private database() {
    const db = new DatabaseSync(this.filename(), { readOnly: true });
    const meta = db.prepare("SELECT value FROM metadata WHERE key='model'").get() as
      | { value: string }
      | undefined;
    if (meta?.value !== MODEL_KEY) {
      db.close();
      throw Error(
        "Library embedding model does not match this build. Re-import the manifest with the current model.",
      );
    }
    return db;
  }
  async status() {
    if (!(await exists(this.filename())))
      return {
        available: false,
        screens: 0,
        flows: 0,
        model: MODEL,
        next_action: "Run library setup, then library import /absolute/path/manifest.json.",
      };
    const db = this.database();
    try {
      const metadata = Object.fromEntries(
        (
          db.prepare("SELECT key,value FROM metadata").all() as Array<{
            key: string;
            value: string;
          }>
        ).map((row) => [row.key, row.value]),
      );
      const counts = db
        .prepare(
          "SELECT (SELECT count(*) FROM screens) AS screens, (SELECT count(*) FROM assets) AS distinct_images, (SELECT count(*) FROM flows) AS flows, (SELECT count(*) FROM vectors) AS vectors",
        )
        .get() as Record<string, number>;
      return {
        available: true,
        ...counts,
        dataset: JSON.parse(metadata.dataset),
        model: MODEL,
        imported_at: metadata.imported_at,
        manifest_sha256: metadata.manifest_sha256,
      };
    } finally {
      db.close();
    }
  }

  async importManifest(
    filename: string,
    options: { replace?: boolean; progress?: (value: Record<string, unknown>) => void } = {},
  ) {
    if (!path.isAbsolute(filename)) throw Error("Manifest path must be absolute.");
    if ((await stat(filename)).size > 25 * 1024 * 1024) throw Error("Manifest exceeds 25 MiB.");
    const raw = await readFile(filename),
      manifestHash = hash(raw);
    const manifest = manifestSchema.parse(JSON.parse(raw.toString()));
    const ids = new Set(manifest.screens.map((screen) => screen.id));
    if (ids.size !== manifest.screens.length) throw Error("Screen IDs must be unique.");
    if (new Set(manifest.flows.map((flow) => flow.id)).size !== manifest.flows.length)
      throw Error("Flow IDs must be unique.");
    for (const flow of manifest.flows) {
      if (flow.steps.some((step) => !ids.has(step.screen_id)))
        throw Error(`Flow ${flow.id} references a missing screen.`);
      const numbers = flow.steps
        .map((step) => step.source_step)
        .filter((step) => step !== undefined);
      if (numbers.some((number, index) => index > 0 && number <= numbers[index - 1]))
        throw Error(`Flow ${flow.id} has unordered source step numbers.`);
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = path.join(this.directory, ".import.lock");
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      throw Error(
        "A library import is already running, or a stopped import left .import.lock. Confirm no importer is running before removing it.",
        { cause: error },
      );
    }
    const staging = path.join(this.directory, `library-${randomUUID()}.staging.sqlite`);
    let db: DatabaseSync | undefined;
    try {
      if ((await exists(this.filename())) && !options.replace) {
        const current = await this.status();
        if ("manifest_sha256" in current && current.manifest_sha256 === manifestHash)
          return { ...current, unchanged: true };
        if (!options.replace)
          throw Error(
            "A different library is already installed. Use --replace to atomically replace it; the previous library remains readable during import.",
          );
      }
      const root = await realpath(path.dirname(filename));
      const cache = path.join(this.directory, "embedding-cache");
      await mkdir(cache, { recursive: true, mode: 0o700 });
      const handle = await open(staging, "wx", 0o600);
      await handle.close();
      db = new DatabaseSync(staging);
      db.exec(`PRAGMA journal_mode=DELETE;
        CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE assets(hash TEXT PRIMARY KEY,bytes BLOB NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL);
        CREATE TABLE vectors(hash TEXT NOT NULL,region TEXT NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(hash,region));
        CREATE TABLE screens(id TEXT PRIMARY KEY,asset_hash TEXT NOT NULL,product TEXT NOT NULL,platform TEXT NOT NULL,record TEXT NOT NULL);
        CREATE TABLE flows(id TEXT PRIMARY KEY,record TEXT NOT NULL);
        CREATE TABLE flow_steps(flow_id TEXT NOT NULL,position INTEGER NOT NULL,screen_id TEXT NOT NULL,action TEXT NOT NULL,PRIMARY KEY(flow_id,position));
        CREATE INDEX step_screen ON flow_steps(screen_id);
        CREATE VIRTUAL TABLE screen_text USING fts5(screen_id UNINDEXED,content);
        BEGIN IMMEDIATE;`);
      const addAsset = db.prepare("INSERT INTO assets VALUES(?,?,?,?)");
      const addVector = db.prepare("INSERT INTO vectors VALUES(?,?,?)");
      const addScreen = db.prepare("INSERT INTO screens VALUES(?,?,?,?,?)");
      const addText = db.prepare("INSERT INTO screen_text VALUES(?,?)");
      const imported = new Set<string>();
      for (const [index, screen] of manifest.screens.entries()) {
        if (path.isAbsolute(screen.image))
          throw Error("Manifest image paths must be relative to the manifest folder.");
        const imagePath = await realpath(path.resolve(root, screen.image));
        const relative = path.relative(root, imagePath);
        if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
          throw Error("Manifest image resolves outside its import folder.");
        const stats = await stat(imagePath);
        if (!stats.isFile() || stats.size > MAX_IMAGE_BYTES)
          throw Error(`Image ${screen.id} must be a regular file of at most 20 MiB.`);
        const bytes = await readFile(imagePath);
        const metadata = await sharp(bytes, { limitInputPixels: 24_000_000 }).metadata();
        if (
          !["png", "jpeg", "webp", "avif", "gif"].includes(metadata.format ?? "") ||
          !metadata.width ||
          !metadata.height ||
          metadata.width < 64 ||
          metadata.height < 64
        )
          throw Error(`Invalid raster screenshot ${screen.id}.`);
        const assetHash = hash(bytes);
        if (!imported.has(assetHash)) {
          const cacheFile = path.join(cache, `${assetHash}-${hash(MODEL_KEY).slice(0, 16)}.json`);
          let vectors: ChunkVector[] | undefined;
          try {
            const cached = JSON.parse(await readFile(cacheFile, "utf8"));
            if (cached.model === MODEL_KEY && cached.hash === assetHash) vectors = cached.vectors;
          } catch {
            /* Recompute missing/incomplete caches; never substitute random vectors. */
          }
          if (!vectors) {
            vectors = await this.engine.image(bytes);
            const temp = `${cacheFile}.${randomUUID()}.tmp`;
            await writeFile(temp, JSON.stringify({ model: MODEL_KEY, hash: assetHash, vectors }), {
              mode: 0o600,
            });
            await rename(temp, cacheFile);
          }
          if (
            !Array.isArray(vectors) ||
            !vectors.length ||
            vectors.length > 4 ||
            vectors[0].region !== "full" ||
            new Set(vectors.map((v) => v.region)).size !== vectors.length
          )
            throw Error(
              "Invalid cached embedding chunks; remove the affected cache file and retry.",
            );
          addAsset.run(assetHash, bytes, metadata.width, metadata.height);
          for (const vector of vectors)
            addVector.run(assetHash, vector.region, vectorBytes(normalize(vector.vector)));
          imported.add(assetHash);
        }
        const { image: _image, ...record } = screen;
        void _image;
        addScreen.run(
          screen.id,
          assetHash,
          screen.product,
          screen.platform,
          JSON.stringify(record),
        );
        addText.run(
          screen.id,
          [screen.title, screen.product, screen.tags.join(" "), screen.text].join(" "),
        );
        if ((index + 1) % 20 === 0 || index + 1 === manifest.screens.length)
          options.progress?.({
            screens: index + 1,
            total: manifest.screens.length,
            distinct_images: imported.size,
          });
      }
      const addFlow = db.prepare("INSERT INTO flows VALUES(?,?)"),
        addStep = db.prepare("INSERT INTO flow_steps VALUES(?,?,?,?)");
      for (const flow of manifest.flows) {
        addFlow.run(flow.id, JSON.stringify(flow));
        for (const [position, step] of flow.steps.entries())
          addStep.run(flow.id, position, step.screen_id, step.action);
      }
      const addMeta = db.prepare("INSERT INTO metadata VALUES(?,?)");
      for (const [key, value] of Object.entries({
        schema: "1",
        model: MODEL_KEY,
        dataset: JSON.stringify(manifest.dataset),
        imported_at: new Date().toISOString(),
        manifest_sha256: manifestHash,
      }))
        addMeta.run(key, value);
      db.exec("COMMIT");
      db.close();
      db = undefined;
      await rename(staging, this.filename());
      await chmod(this.filename(), 0o600);
      return await this.status();
    } finally {
      if (db) db.close();
      await rm(staging, { force: true });
      await rm(staging + "-journal", { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }

  async search(input: {
    query?: string;
    image?: Uint8Array;
    limit?: number;
    product?: string;
    platform?: string;
    image_matching?: "balanced" | "layout";
    deduplicate?: boolean;
    exclude_screen_id?: string;
  }) {
    if (Boolean(input.query?.trim()) === Boolean(input.image))
      throw Error("Supply exactly one text query or image.");
    if (input.image_matching && !input.image)
      throw Error("image_matching applies only to image queries.");
    if (input.image_matching && !["balanced", "layout"].includes(input.image_matching))
      throw Error("Unknown image matching strategy.");
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw Error("Search limit must be 1–20.");
    if (!(await exists(this.filename())))
      throw Error("No local library is installed. Run library setup and library import first.");
    if (input.image) {
      if (!input.image.length || input.image.length > MAX_IMAGE_BYTES)
        throw Error("Query screenshot must be at most 20 MiB.");
      const metadata = await sharp(input.image, { limitInputPixels: 24_000_000 }).metadata();
      if (
        !["png", "jpeg", "webp", "avif", "gif"].includes(metadata.format ?? "") ||
        !metadata.width ||
        !metadata.height ||
        metadata.width < 64 ||
        metadata.height < 64
      )
        throw Error("Use a raster screenshot at least 64 pixels wide/high.");
    }
    const imageHash = input.image ? hash(input.image) : undefined;
    const queryVectors = input.image
      ? await this.engine.image(input.image)
      : [{ region: "full", vector: await this.engine.text(input.query!.trim()) }];
    for (const item of queryVectors) item.vector = normalize(item.vector);
    const db = this.database();
    try {
      const filters: string[] = [],
        params: string[] = [];
      if (input.product) {
        filters.push("product=? COLLATE NOCASE");
        params.push(input.product);
      }
      if (input.platform) {
        filters.push("platform=?");
        params.push(input.platform);
      }
      if (input.exclude_screen_id) {
        const source = db
          .prepare("SELECT asset_hash FROM screens WHERE id=?")
          .get(input.exclude_screen_id) as { asset_hash: string } | undefined;
        if (!source) throw Error("Local source screen not found.");
        filters.push("asset_hash!=?");
        params.push(source.asset_hash);
      }
      const rows = db
        .prepare(
          `SELECT id,asset_hash,record FROM screens${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}`,
        )
        .all(...params) as Array<{ id: string; asset_hash: string; record: string }>;
      const vectors = new Map<string, ChunkVector[]>();
      for (const row of db.prepare("SELECT hash,region,vector FROM vectors").all() as Array<{
        hash: string;
        region: string;
        vector: Uint8Array;
      }>) {
        if (!vectors.has(row.hash)) vectors.set(row.hash, []);
        vectors.get(row.hash)!.push({ region: row.region, vector: readVector(row.vector) });
      }
      const scored = rows
        .map((row) => {
          const chunks = vectors.get(row.asset_hash)!;
          const score = input.image
            ? imageSimilarity(queryVectors, chunks, input.image_matching)
            : Math.max(...chunks.map((chunk) => cosine(queryVectors[0].vector, chunk.vector)));
          return {
            ...row,
            cosine: score,
            exact_file_match: Boolean(imageHash && imageHash === row.asset_hash),
          };
        })
        .sort(
          (a, b) =>
            Number(b.exact_file_match) - Number(a.exact_file_match) ||
            b.cosine - a.cosine ||
            a.id.localeCompare(b.id),
        );
      const semanticRanks = new Map(scored.map((row, index) => [row.id, index + 1]));
      const textRanks = new Map<string, number>();
      const terms = input.query?.match(/[\p{L}\p{N}]{2,}/gu)?.slice(0, 16) ?? [];
      if (terms.length) {
        const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
        const hits = db
          .prepare(
            "SELECT screen_id FROM screen_text WHERE screen_text MATCH ? ORDER BY bm25(screen_text) LIMIT 1000",
          )
          .all(match) as Array<{ screen_id: string }>;
        const allowed = new Set(rows.map((row) => row.id));
        hits
          .filter((hit) => allowed.has(hit.screen_id))
          .forEach((hit, index) => textRanks.set(hit.screen_id, index + 1));
      }
      const ranked = scored
        .map((row) => ({
          ...row,
          rank_score:
            1 / (60 + semanticRanks.get(row.id)!) +
            (textRanks.has(row.id) ? 1 / (60 + textRanks.get(row.id)!) : 0),
        }))
        .sort(
          (a, b) =>
            Number(b.exact_file_match) - Number(a.exact_file_match) ||
            b.rank_score - a.rank_score ||
            b.cosine - a.cosine ||
            a.id.localeCompare(b.id),
        );
      const enabled = input.deduplicate !== false;
      const pool = ranked.slice(0, enabled ? Math.min(100, Math.max(40, limit * 5)) : limit);
      const groups: Array<{
        representative: (typeof ranked)[number];
        members: (typeof ranked)[number][];
        fingerprint?: Fingerprint;
      }> = [];
      const byHash = new Map<string, (typeof groups)[number]>();
      const getFingerprint = async (assetHash: string) => {
        let pending = this.fingerprints.get(assetHash);
        if (!pending) {
          const asset = db.prepare("SELECT bytes FROM assets WHERE hash=?").get(assetHash) as {
            bytes: Uint8Array;
          };
          pending = fingerprint(asset.bytes);
          if (this.fingerprints.size >= 256)
            this.fingerprints.delete(this.fingerprints.keys().next().value!);
          this.fingerprints.set(assetHash, pending);
          pending.catch(() => this.fingerprints.delete(assetHash));
        }
        return pending;
      };
      const fingerprintErrors: Array<{ screen_id: string; error: string }> = [];
      for (const row of pool) {
        if (enabled && byHash.has(row.asset_hash)) continue;
        let visual: Fingerprint | undefined;
        if (enabled) {
          try {
            visual = await getFingerprint(row.asset_hash);
          } catch (error) {
            fingerprintErrors.push({
              screen_id: row.id,
              error: error instanceof Error ? error.message : "Fingerprint unavailable",
            });
          }
        }
        const match = visual
          ? groups.find((group) => group.fingerprint && nearDuplicate(group.fingerprint, visual!))
          : undefined;
        const group = match ?? { representative: row, members: [], fingerprint: visual };
        if (!match) groups.push(group);
        if (enabled) byHash.set(row.asset_hash, group);
        else group.members.push(row);
      }
      // Preserve every exact-file alias in the filtered corpus, even outside the candidate window.
      if (enabled) for (const row of ranked) byHash.get(row.asset_hash)?.members.push(row);
      const selected = groups.slice(0, limit);
      const results = selected.map((group) => {
        const row = group.representative;

        const { text, ...record } = JSON.parse(row.record);
        return {
          ...record,
          text_excerpt: String(text ?? "").slice(0, 500),
          exact_file_match: row.exact_file_match,
          cosine_similarity: row.cosine,
          rank_score: row.rank_score,
          duplicate_screen_ids: group.members
            .filter((member) => member.id !== row.id)
            .map((member) => member.id),
          flow_ids: [
            ...new Set(
              group.members.flatMap((member) =>
                (
                  db
                    .prepare(
                      "SELECT DISTINCT flow_id FROM flow_steps WHERE screen_id=? ORDER BY flow_id",
                    )
                    .all(member.id) as Array<{ flow_id: string }>
                ).map((value) => value.flow_id),
              ),
            ),
          ].sort(),
        };
      });
      return {
        mode: input.image ? "local_image_vectors" : "local_text_vectors_and_keywords",
        results,
        deduplication: {
          enabled,
          candidate_window: pool.length,
          unique_groups: groups.length,
          fingerprint_errors: fingerprintErrors,
          suppressed_in_window: enabled ? pool.length - groups.length : 0,
          note: "Near-duplicate pixel heuristic, not semantic equivalence. No records deleted. IDs and flow references include grouped aliases. Disable deduplicate to inspect every ranked frame; grouping is bounded to the candidate window.",
        },
        image_matching: input.image ? (input.image_matching ?? "balanced") : undefined,
        searched_screens: rows.length,
        model: MODEL,
        score_note:
          "Cosine similarity and reciprocal-rank scores are retrieval signals, not calibrated match percentages or UX quality scores.",
      };
    } finally {
      db.close();
    }
  }

  async screen(id: string) {
    const db = this.database();
    try {
      const row = db
        .prepare(
          "SELECT s.record,a.bytes,a.width,a.height FROM screens s JOIN assets a ON a.hash=s.asset_hash WHERE s.id=?",
        )
        .get(id) as
        | { record: string; bytes: Uint8Array; width: number; height: number }
        | undefined;
      if (!row) throw Error("Local screen not found.");
      const bytes = await sharp(row.bytes)
        .rotate()
        .resize({ width: 1000, height: 1800, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
      return {
        screen: JSON.parse(row.record),
        width: row.width,
        height: row.height,
        image: { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/webp" },
        flow_ids: (
          db
            .prepare("SELECT DISTINCT flow_id FROM flow_steps WHERE screen_id=? ORDER BY flow_id")
            .all(id) as Array<{ flow_id: string }>
        ).map((row) => row.flow_id),
      };
    } finally {
      db.close();
    }
  }
  async flow(id: string) {
    const db = this.database();
    try {
      const row = db.prepare("SELECT record FROM flows WHERE id=?").get(id) as
        | { record: string }
        | undefined;
      if (!row) throw Error("Local flow not found.");
      return {
        flow: JSON.parse(row.record),
        dataset: JSON.parse(
          (db.prepare("SELECT value FROM metadata WHERE key='dataset'").get() as { value: string })
            .value,
        ),
        coverage_note:
          "Flow steps/actions are imported annotations. Complete describes the provided trajectory, not every possible path through an application.",
      };
    } finally {
      db.close();
    }
  }
}
