/** Opt-in real stdio acceptance using only an existing local pilot and cached CLIP. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "output/verification/app-diversity");
await fs.mkdir(out, { recursive: true });
const client = new Client({ name: "local-app-diversity-check", version: "1" });
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
const appKey = (s) => s.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
const sources = [
  ["tasks-date-picker", "screen-cad53f497fecd33225d65951f537ca1eae9407afeae6ff093a1eb44f76f5854d"],
  ["calendar-colors", "screen-e81f6ff0f140dab150116403f8863b3006502ac24a4aff4ed3c514967ab5df38"],
  ["music-dashboard", "screen-1d682d23ebc0ab83abb5dcffedf651cc0dad9bd477326673b7c6080c96f76169"],
  ["tasks-clock-dialog", "screen-13152397accf4c119d6d62208f1f47ea9f2941548b357a17694d652312d6e1c1"],
];
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  assert(!r.isError, JSON.stringify(r));
  return r;
};
async function sheet(result, file) {
  const imgs = result.content.filter((b) => b.type === "image");
  const cells = [];
  for (const [i, img] of imgs.entries()) {
    cells.push({
      input: await sharp(Buffer.from(img.data, "base64"))
        .resize(200, 445, { fit: "contain", background: "white" })
        .png()
        .toBuffer(),
      left: i * 206,
      top: 28,
    });
    cells.push({
      input: Buffer.from(
        `<svg width="200" height="28"><rect width="200" height="28" fill="white"/><text x="5" y="20" font-size="17">${i ? "MATCH " + i : "SOURCE"}</text></svg>`,
      ),
      left: i * 206,
      top: 0,
    });
  }
  await sharp({
    create: { width: imgs.length * 206, height: 473, channels: 3, background: "#ddd" },
  })
    .composite(cells)
    .png()
    .toFile(path.join(out, file));
}
try {
  await client.connect(transport);
  const cases = [];
  for (const [name, source_screen_id] of sources) {
    const closest = await call("mobbin_compare_local_screens", {
      source_screen_id,
      result_mode: "closest",
      limit: 4,
    });
    const diverse = await call("mobbin_compare_local_screens", {
      source_screen_id,
      result_mode: "app_diverse",
      limit: 4,
    });
    const broad = await call("mobbin_compare_local_screens", {
      source_screen_id,
      result_mode: "app_diverse",
      max_similarity_drop: 0.2,
      limit: 4,
    });
    const old = closest.structuredContent,
      packet = diverse.structuredContent;
    assert.equal(old.retrieval.selection.result_mode, "closest");
    assert.equal(packet.retrieval.selection.result_mode, "app_diverse");
    assert.equal(packet.retrieval.selection.returned_apps, packet.candidates.length);
    assert.equal(packet.retrieval.results[0].id, old.retrieval.results[0].id);
    assert(
      packet.retrieval.results.every(
        (row) => row.cosine_similarity >= old.retrieval.results[0].cosine_similarity - 0.1,
      ),
    );
    assert.equal(
      broad.structuredContent.retrieval.selection.returned_apps,
      broad.structuredContent.candidates.length,
    );
    assert(!packet.candidates.some((c) => c.screen_id === source_screen_id));
    assert(
      packet.candidates.every((c) => c.image_status === "available" && c.flow_contexts.length > 0),
    );
    assert.equal(
      diverse.content.filter((b) => b.type === "image").length,
      packet.candidates.length + 1,
    );
    await sheet(closest, name + "-closest.png");
    await sheet(diverse, name + "-diverse.png");
    await sheet(broad, name + "-broad.png");
    await fs.writeFile(
      path.join(out, name + ".json"),
      JSON.stringify(
        { closest: old, app_diverse: packet, broad: broad.structuredContent },
        null,
        2,
      ),
    );
    const summary = {
      name,
      source_screen_id,
      closest_apps: old.retrieval.selection.returned_apps,
      diverse_apps: packet.retrieval.selection.returned_apps,
      broad_apps: broad.structuredContent.retrieval.selection.returned_apps,
      closest_products: old.candidates.map((c) => c.screen.product),
      diverse_products: packet.candidates.map((c) => c.screen.product),
      flow_ids: packet.candidates.map((c) => c.flow_ids),
    };
    cases.push(summary);
    console.log(JSON.stringify(summary));
  }
  const pattern = (
    await call("mobbin_search_local_library", {
      query: "analog time picker dialog with clock face and confirm cancel buttons",
      result_mode: "app_diverse",
      limit: 4,
    })
  ).structuredContent;
  assert.equal(pattern.selection.returned_apps, 4);
  const sourceId = "screen-13152397accf4c119d6d62208f1f47ea9f2941548b357a17694d652312d6e1c1";
  const candidateIds = pattern.results
    .filter((row) => row.id !== sourceId)
    .slice(0, 3)
    .map((row) => row.id);
  const patternComparison = await call("mobbin_compare_local_screens", {
    source_screen_id: sourceId,
    candidate_ids: candidateIds,
  });
  assert.equal(
    patternComparison.content.filter((block) => block.type === "image").length,
    candidateIds.length + 1,
  );
  await sheet(patternComparison, "pattern-clock-comparison.png");
  await fs.writeFile(
    path.join(out, "pattern-clock-comparison.json"),
    JSON.stringify({ search: pattern, comparison: patternComparison.structuredContent }, null, 2),
  );
  const text = await call("mobbin_search_local_library", {
    query: "calendar create event",
    result_mode: "app_diverse",
    max_per_app: 2,
    limit: 10,
  });
  const counts = new Map();
  for (const r of text.structuredContent.results) {
    const key = appKey(r.product);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  assert([...counts.values()].every((n) => n <= 2));
  const filtered = await call("mobbin_search_local_library", {
    query: "calendar create event",
    product: "simple calendar pro",
    result_mode: "app_diverse",
    limit: 10,
  });
  assert(filtered.structuredContent.results.length <= 1);
  const receipt = {
    passed: true,
    cases,
    pattern_products: pattern.results.map((row) => row.product),
    text_apps: text.structuredContent.selection.returned_apps,
    filtered_count: filtered.structuredContent.results.length,
    limitations:
      "App diversity is based on imported labels. Visual relevance must be judged separately; this is not an unseen relevance benchmark.",
    inference:
      "Cached local CLIP with worker fetch disabled; no Mobbin credentials supplied, no AI API called.",
  };
  await fs.writeFile(path.join(out, "acceptance.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ passed: true, receipt: path.join(out, "acceptance.json") }));
} finally {
  await client.close();
}
