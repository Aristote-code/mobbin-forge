/** Explicitly install inspected annotations for the pinned local pilot. Never downloads images. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "output/verification/ui-knowledge");
await fs.mkdir(out, { recursive: true });
const fixture = JSON.parse(
  await fs.readFile(path.join(root, "test/fixtures/ui-knowledge-pilot.json")),
);
const client = new Client({ name: "local-ui-knowledge-pilot", version: "1" });
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
        .resize(240, 340, { fit: "contain", background: "white" })
        .png()
        .toBuffer(),
      left: i * 246,
      top: 28,
    });
    cells.push({
      input: Buffer.from(
        `<svg width="240" height="28"><rect width="240" height="28" fill="white"/><text x="5" y="20" font-size="17">${i ? "REFERENCE " + i : "SOURCE"}</text></svg>`,
      ),
      left: i * 246,
      top: 0,
    });
  }
  await sharp({
    create: { width: imgs.length * 246, height: 368, channels: 3, background: "#ddd" },
  })
    .composite(cells)
    .png()
    .toFile(path.join(out, file));
}
try {
  await client.connect(transport);
  const original = (await call("mobbin_local_library_status", {})).structuredContent;
  assert.equal(
    original.manifest_sha256,
    "1216bab5dd4d22c02ac2c0690be1bf83ce0a45ee457584f809dabb206a711ad6",
    "Pilot source differs from inspected screenshots.",
  );
  const installed = [];
  for (const reference of fixture.references) {
    const exists = await client.callTool({
      name: "mobbin_get_ui_reference",
      arguments: { reference_id: reference.reference_id },
    });
    if (exists.isError) {
      const message = exists.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join();
      if (!/not found|No UI knowledge saved/.test(message)) throw Error(message);
      await call("mobbin_save_ui_reference", reference);
    }
    const got = await call("mobbin_get_ui_reference", { reference_id: reference.reference_id });
    assert(got.content.some((b) => b.type === "image"));
    const record = got.structuredContent.reference;
    assert(record.source.flow_contexts.length > 0);
    await fs.writeFile(
      path.join(out, reference.reference_id + ".webp"),
      Buffer.from(got.content.find((b) => b.type === "image").data, "base64"),
    );
    installed.push({
      reference_id: record.reference_id,
      revision: record.revision,
      kind: record.kind,
      product: record.product,
      dimensions: record.measured,
      flow_ids: record.source.flow_ids,
    });
    console.log(reference.reference_id, record.kind, record.product);
  }
  const text = (
    await call("mobbin_search_ui_knowledge", {
      query: "analog time picker confirmation dialog",
      component: "time-picker",
      annotation_scope: "reviewed",
      kind: "component",
      result_mode: "app_diverse",
      limit: 4,
    })
  ).structuredContent;
  assert.equal(text.results.length, 4);
  assert.equal(new Set(text.results.map((r) => r.reference.product)).size, 4);
  const comparison = await call("mobbin_compare_ui_references", {
    source_reference_id: "pilot-ui-v1-time-tasks",
    component: "time-picker",
    annotation_scope: "reviewed",
    result_mode: "app_diverse",
    limit: 3,
  });
  assert.equal(comparison.content.filter((b) => b.type === "image").length, 4);
  await sheet(comparison, "time-components.png");
  const card = await call("mobbin_compare_ui_references", {
    source_reference_id: "pilot-ui-v1-music-feature-card",
    component: "card",
    kind: "component",
    limit: 4,
  });
  assert(card.content.filter((b) => b.type === "image").length >= 3);
  await sheet(card, "card-components.png");
  const fixtureCrop = await call("mobbin_get_ui_reference", {
    reference_id: "pilot-ui-v1-music-feature-card",
  });
  const image = fixtureCrop.content.find((b) => b.type === "image");
  const imageSearch = (
    await call("mobbin_search_ui_knowledge", {
      image_base64: image.data,
      kind: "component",
      component: "card",
      limit: 3,
    })
  ).structuredContent;
  assert.equal(imageSearch.results[0].reference_id, "pilot-ui-v1-music-feature-card");
  const coverage = (await call("mobbin_ui_knowledge_status", {})).structuredContent;
  const after = (await call("mobbin_local_library_status", {})).structuredContent;
  assert.equal(after.screens, original.screens);
  assert.equal(after.flows, original.flows);
  assert.equal(after.manifest_sha256, original.manifest_sha256);
  const receipt = {
    passed: true,
    coverage,
    installed,
    text_search: text,
    image_search: imageSearch,
    time_comparison: comparison.structuredContent,
    card_comparison: card.structuredContent,
    inference:
      "Real cached local CLIP via stdio MCP; no Mobbin credentials, hosted database or paid AI API.",
    limitations:
      "Nine hand-reviewed references are a working pilot, not full-corpus automatic annotations or a held-out relevance benchmark. Card references illustrate different purposes, not interchangeable UI.",
  };
  await fs.writeFile(path.join(out, "acceptance.json"), JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify({
      passed: true,
      references: coverage.references,
      annotated_screens: coverage.annotated_screens,
      receipt: path.join(out, "acceptance.json"),
    }),
  );
} finally {
  await client.close();
}
