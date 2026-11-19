/** Reproduce the fixed 24-screen benchmark. Downloads are explicit; inference is offline. */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { LocalEmbedder } from "../dist/library/embedder.js";
import { LocalLibrary } from "../dist/library/store.js";
import { MODEL } from "../dist/library/schema.js";
const dir = process.env.MOBBIN_LIBRARY_DIR ?? process.env.HOME + "/.mobbin-mcp/library";
const out = "output/verification/relevance";
await fs.mkdir(out, { recursive: true });
const spec = JSON.parse(
  await fs.readFile(new URL("../test/fixtures/local-relevance.json", import.meta.url)),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = await fs.readFile(
  process.env.HOME + "/.mobbin-mcp/pilot/openmobile/manifest.json",
);
assert.equal(
  hash(manifest),
  spec.index_manifest_sha256,
  "Benchmark needs the pinned 1,000-screen pilot manifest",
);
const indexed = JSON.parse(manifest);
assert(
  !spec.queries.some((q) => indexed.flows.some((f) => f.id === q.episode)),
  "Source episode overlaps index",
);
assert.equal(new Set(spec.queries.map((q) => q.sha256)).size, 24);
for (const q of spec.queries) {
  let bytes;
  try {
    bytes = await fs.readFile(path.join(out, q.image));
  } catch {}
  if (!bytes || hash(bytes) !== q.sha256) {
    if (!process.argv.includes("--download"))
      throw Error(`Missing ${q.id}; run with --download once.`);
    assert(
      q.source_url.startsWith(
        "https://huggingface.co/datasets/UI-MOPD/Uni-GUI-OpenMobile/resolve/774eb20f97724bf64faa9e66b1572f05b1688e38/",
      ),
    );
    const response = await fetch(q.source_url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error(`Screenshot download failed: ${response.status}`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > 20 * 1024 * 1024) throw Error("Screenshot too large");
    bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.length <= 20 * 1024 * 1024);
    assert.equal(hash(bytes), q.sha256, "Source checksum mismatch");
    await fs.writeFile(path.join(out, q.image), bytes, { mode: 0o600 });
  }
}
// Main-thread and worker network calls are both disabled for the actual benchmark.
globalThis.fetch = async () => {
  throw Error("Network forbidden during relevance evaluation");
};
const db = new DatabaseSync(dir + "/library.sqlite", { readOnly: true });
assert.equal(
  db.prepare("SELECT value FROM metadata WHERE key='manifest_sha256'").get().value,
  spec.index_manifest_sha256,
  "Installed index differs from benchmark corpus",
);
const engine = new LocalEmbedder(dir + "/models");
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const docs = new Map();
for (const row of db.prepare("select hash,region,vector from vectors").all()) {
  if (!docs.has(row.hash)) docs.set(row.hash, []);
  const b = Buffer.from(row.vector);
  const v = Array.from({ length: 512 }, (_, i) => b.readFloatLE(i * 4));
  const norm = Math.hypot(...v);
  docs.get(row.hash).push({ region: row.region, vector: v.map((x) => x / norm) });
}
const screens = db.prepare("select id,asset_hash,record from screens").all();
assert.equal(db.prepare("select count(*) as n from screens").get().n, 1000);
const installedHashes = new Set(screens.map((s) => s.asset_hash));
assert(!spec.queries.some((q) => installedHashes.has(q.sha256)), "Query file is already indexed");
let currentVectors;
const library = new LocalLibrary(dir, {
  image: async () => currentVectors,
  text: async () => {
    throw Error("Unexpected text inference");
  },
  setup: async () => MODEL,
  close: async () => {},
});
const records = [];
for (const q of spec.queries) {
  const vectors = await engine.image(await fs.readFile(out + "/" + q.image));
  currentVectors = vectors;
  const scores = screens.map((s) => {
    const chunks = docs.get(s.asset_hash),
      whole = chunks.find((c) => c.region === "full");
    const full = dot(vectors[0].vector, whole.vector);
    const parts = vectors.slice(1);
    const max =
      parts.reduce((sum, p) => sum + Math.max(...chunks.map((c) => dot(p.vector, c.vector))), 0) /
      parts.length;
    const aligned =
      parts.reduce(
        (sum, p, i) =>
          sum + dot(p.vector, (chunks.find((c) => c.region === p.region) ?? whole).vector),
        0,
      ) / parts.length;
    return {
      id: s.id,
      baseline: 0.6 * full + 0.4 * max,
      aligned: 0.6 * full + 0.4 * aligned,
      full,
    };
  });
  const rankings = {};
  for (const mode of ["baseline", "aligned", "full"])
    rankings[mode] = [...scores]
      .sort((a, b) => b[mode] - a[mode] || a.id.localeCompare(b.id))
      .slice(0, 5)
      .map((s) => ({ id: s.id, score: s[mode] }));
  for (const [mode, strategy] of [
    ["baseline", "balanced"],
    ["aligned", "layout"],
  ]) {
    const actual = await library.search({
      image: await fs.readFile(out + "/" + q.image),
      image_matching: strategy,
      limit: 5,
    });
    assert.deepEqual(
      actual.results.map((r) => r.id),
      rankings[mode].map((r) => r.id),
      `Production ranking differs for ${q.id}/${strategy}`,
    );
  }
  records.push({ ...q, rankings });
  console.log(q.id);
}
await fs.writeFile(out + "/rankings.json", JSON.stringify(records, null, 2));
await engine.close();
for (const split of ["development", "holdout"]) {
  const subset = records.filter((q) => q.split === split);
  for (let start = 0; start < subset.length; start += 4) {
    const rows = [];
    let width = 0;
    for (const [ri, q] of subset.slice(start, start + 4).entries()) {
      const ids = [
        ...new Set(Object.values(q.rankings).flatMap((r) => r.slice(0, 3).map((s) => s.id))),
      ];
      const cells = [
        { id: q.id, bytes: await fs.readFile(out + "/" + q.image) },
        ...ids.map((id) => ({
          id,
          bytes: db
            .prepare(
              "select bytes from assets where hash=(select asset_hash from screens where id=?)",
            )
            .get(id).bytes,
        })),
      ];
      for (const [ci, c] of cells.entries()) {
        const label = ci === 0 ? q.id : String(ids.indexOf(c.id) + 1);
        const png = await sharp(c.bytes)
          .resize(160, 356, { fit: "contain", background: "white" })
          .png()
          .toBuffer();
        rows.push({ input: png, left: ci * 166, top: ri * 386 + 24 });
        rows.push({
          input: Buffer.from(
            `<svg width="160" height="24"><rect width="160" height="24" fill="white"/><text x="5" y="18" font-size="18">${label}</text></svg>`,
          ),
          left: ci * 166,
          top: ri * 386,
        });
      }
      width = Math.max(width, cells.length * 166);
      q.pool = ids;
    }
    await sharp({ create: { width, height: 4 * 386, channels: 3, background: "#ddd" } })
      .composite(rows)
      .png()
      .toFile(out + `/${split}-${start / 4}.png`);
  }
}
await fs.writeFile(out + "/rankings.json", JSON.stringify(records, null, 2));
const metrics = {};
for (const split of ["development", "holdout"]) {
  metrics[split] = {};
  for (const mode of ["baseline", "aligned", "full"]) {
    const values = records
      .filter((q) => q.split === split)
      .map((q) => {
        const grades = q.rankings[mode].slice(0, 3).map((r) => {
          const grade = q.judgments[r.id];
          assert(
            Number.isInteger(grade),
            `Unjudged candidate ${q.id}/${r.id}; review before scoring`,
          );
          return grade;
        });
        return {
          id: q.id,
          grades,
          top1: Number(grades[0] === 2),
          success3: Number(grades.includes(2)),
          precision3: grades.filter((g) => g === 2).length / 3,
          meanGrade3: grades.reduce((a, b) => a + b, 0) / 3,
          dcg3: grades.reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0),
        };
      });
    metrics[split][mode] = {
      queries: values.length,
      ...Object.fromEntries(
        ["top1", "success3", "precision3", "meanGrade3", "dcg3"].map((k) => [
          k,
          values.reduce((s, v) => s + v[k], 0) / values.length,
        ]),
      ),
      per_query: values,
    };
  }
}
await fs.writeFile(
  out + "/metrics.json",
  JSON.stringify(
    {
      model: MODEL,
      network: "disabled during inference/evaluation",
      index_manifest_sha256: spec.index_manifest_sha256,
      metrics,
    },
    null,
    2,
  ),
);
for (const [split, modes] of Object.entries(metrics))
  for (const [mode, { per_query, ...summary }] of Object.entries(modes))
    console.log(split, mode, summary);
db.close();
await library.close();
