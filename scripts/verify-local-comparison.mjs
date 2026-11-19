/** Real, offline stdio acceptance against the existing pinned pilot and benchmark images. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "output/verification/local-comparison");
await fs.mkdir(out, { recursive: true });
const spec = JSON.parse(await fs.readFile(path.join(root, "test/fixtures/local-relevance.json")));
const client = new Client({ name: "local-comparison-acceptance", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist/index.js"), "library", "serve"],
  stderr: "pipe",
  env: {
    PATH: process.env.PATH ?? "",
    HOME: homedir(),
    ...(process.env.MOBBIN_LIBRARY_DIR
      ? { MOBBIN_LIBRARY_DIR: process.env.MOBBIN_LIBRARY_DIR }
      : {}),
  },
});
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  assert(!r.isError, JSON.stringify(r));
  return r;
}
try {
  await client.connect(transport);
  const status = (await call("mobbin_local_library_status", {})).structuredContent;
  assert.equal(status.manifest_sha256, spec.index_manifest_sha256);
  assert((await client.listTools()).tools.some((t) => t.name === "mobbin_compare_local_screens"));
  assert(
    (await client.listPrompts()).prompts.some(
      (p) => p.name === "mobbin_local_reference_comparison",
    ),
  );
  const queries = [];
  for (const q of spec.queries) {
    const image_path = path.join(root, "output/verification/relevance", q.image);
    const before = (
      await call("mobbin_search_local_library", { image_path, limit: 4, deduplicate: false })
    ).structuredContent;
    const started = Date.now();
    const after = (await call("mobbin_search_local_library", { image_path, limit: 4 }))
      .structuredContent;
    assert.equal(
      after.results[0].id,
      before.results[0].id,
      "Grouping must preserve highest-ranked reference",
    );
    assert.equal(new Set(after.results.map((r) => r.id)).size, after.results.length);
    assert(
      after.results.every(
        (r) => !after.results.some((other) => r.duplicate_screen_ids.includes(other.id)),
      ),
    );
    const beforeIds = before.results.map((r) => r.id),
      afterIds = after.results.map((r) => r.id);
    queries.push({
      id: q.id,
      before: beforeIds,
      after: afterIds,
      shortlist_changed: beforeIds.join() !== afterIds.join(),
      deduplication: after.deduplication,
      elapsed_ms: Date.now() - started,
      groups: after.results.map((r) => ({
        screen_id: r.id,
        duplicate_screen_ids: r.duplicate_screen_ids,
        flow_ids: r.flow_ids,
      })),
      unjudged_top3_ids: afterIds.slice(0, 3).filter((id) => q.judgments[id] === undefined),
    });
    console.log(q.id, after.deduplication.suppressed_in_window, "grouped");
  }
  const contactControls = queries.find((q) => q.id === "q09");
  const contactA = "screen-f4ffab004e5169dd947de3f5279ed77f84874a5e8857daccb0c0e0d4eb6c2235";
  const contactB = "screen-90b0cd8aee284bf57e69b65ee10ee6d422040c500b7e6e71b5fa120706cc5845";
  assert(
    contactControls.after.includes(contactA) && contactControls.after.includes(contactB),
    "Different selected tabs must remain separate references",
  );
  const q = spec.queries.find((q) => q.id === "q10");
  const comparison = await call("mobbin_compare_local_screens", {
    image_path: path.join(root, "output/verification/relevance", q.image),
    image_matching: "layout",
    limit: 4,
  });
  const packet = comparison.structuredContent;
  assert.equal(packet.visual_judgment, "pending_agent_inspection");
  assert.equal(packet.candidates.length, 4);
  const images = comparison.content.filter((b) => b.type === "image");
  assert.equal(images.length, 5);
  for (const [i, img] of images.entries())
    await fs.writeFile(
      path.join(out, i === 0 ? "source.webp" : `candidate-${i}.webp`),
      Buffer.from(img.data, "base64"),
    );
  const cells = await Promise.all(
    images.map(async (img, i) => ({
      input: await sharp(Buffer.from(img.data, "base64"))
        .resize(220, 490, { fit: "contain", background: "white" })
        .png()
        .toBuffer(),
      left: i * 226,
      top: 26,
    })),
  );
  for (let i = 0; i < images.length; i++)
    cells.push({
      input: Buffer.from(
        `<svg width="220" height="26"><rect width="220" height="26" fill="white"/><text x="4" y="19" font-size="18">${i === 0 ? "SOURCE" : `CANDIDATE ${i}`}</text></svg>`,
      ),
      left: i * 226,
      top: 0,
    });
  await sharp({
    create: { width: images.length * 226, height: 516, channels: 3, background: "#ddd" },
  })
    .composite(cells)
    .png()
    .toFile(path.join(out, "comparison.png"));
  const chosen = packet.candidates[0].screen_id;
  const explicit = await call("mobbin_compare_local_screens", {
    source_screen_id: chosen,
    candidate_ids: [packet.candidates[1].screen_id, "missing-screen"],
  });
  assert.equal(explicit.structuredContent.candidates[1].image_status, "unavailable");
  assert.equal(explicit.content.filter((b) => b.type === "image").length, 2);
  const sourceAuto = (
    await call("mobbin_compare_local_screens", { source_screen_id: chosen, limit: 2 })
  ).structuredContent;
  assert(!sourceAuto.candidates.some((c) => c.screen_id === chosen));
  const summary = {
    passed: true,
    query_count: queries.length,
    changed_shortlists: queries.filter((q) => q.shortlist_changed).length,
    suppressed_in_24_candidate_windows: queries.reduce(
      (sum, q) => sum + q.deduplication.suppressed_in_window,
      0,
    ),
    unjudged_new_top3_candidates: queries.reduce((sum, q) => sum + q.unjudged_top3_ids.length, 0),
    note: "Suppression counts overlap across queries. New candidates are unjudged: do not infer a relevance gain. Existing 24 queries are a regression set, not a fresh held-out test.",
    inference:
      "Local cached CLIP; worker disables fetch; no Mobbin credentials or inference service configured",
    status,
    queries,
    comparison: packet,
  };
  await fs.writeFile(path.join(out, "acceptance.json"), JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify({
      passed: true,
      query_count: summary.query_count,
      changed_shortlists: summary.changed_shortlists,
      suppressed_in_24_candidate_windows: summary.suppressed_in_24_candidate_windows,
      receipt: path.join(out, "acceptance.json"),
    }),
  );
} finally {
  await client.close();
}
