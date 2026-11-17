/** Opt-in acceptance check using real local encoders and an already imported manifest. */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const manifestPath = path.resolve(
  process.argv[2] ?? path.join(homedir(), ".mobbin-mcp/pilot/openmobile/manifest.json"),
);
const manifestBytes = await readFile(manifestPath),
  manifest = JSON.parse(manifestBytes.toString());
const client = new Client({ name: "local-library-offline-acceptance", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "library", "serve"],
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
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  assert.ok(!result.isError, JSON.stringify(result));
  return result;
};
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 4);
  const status = (await call("mobbin_local_library_status", {})).structuredContent;
  assert.equal(status.manifest_sha256, createHash("sha256").update(manifestBytes).digest("hex"));
  assert.equal(status.screens, manifest.screens.length);
  const selfQueries = [];
  for (let n = 0; n < Math.min(8, manifest.screens.length); n++) {
    const screen = manifest.screens[Math.floor((n * manifest.screens.length) / 8)];
    const start = Date.now();
    const result = (
      await call("mobbin_search_local_library", {
        image_path: path.resolve(path.dirname(manifestPath), screen.image),
        limit: 5,
      })
    ).structuredContent;
    assert.equal(result.results[0].id, screen.id);
    assert.equal(result.results[0].exact_file_match, true);
    assert.ok(Math.abs(result.results[0].cosine_similarity - 1) < 0.0001);
    selfQueries.push({
      screen_id: screen.id,
      cosine: result.results[0].cosine_similarity,
      elapsed_ms: Date.now() - start,
    });
  }
  const textQueries = [];
  for (const query of ["calendar create event", "music playlist", "settings brightness"]) {
    const result = (await call("mobbin_search_local_library", { query, limit: 5 }))
      .structuredContent;
    assert.ok(result.results.length > 0);
    textQueries.push({
      query,
      top_products: result.results.map((row) => row.product),
      screen_ids: result.results.map((row) => row.id),
    });
  }
  const image = await call("mobbin_get_local_screen", { screen_id: manifest.screens[0].id });
  assert.ok(image.content.some((block) => block.type === "image"));
  if (manifest.flows.length) {
    const flow = manifest.flows[0],
      result = await call("mobbin_get_local_flow", {
        flow_id: flow.id,
        limit: 20,
        include_images: true,
      });
    assert.equal(result.structuredContent.total_steps, flow.steps.length);
    assert.deepEqual(
      result.structuredContent.flow.steps.map((step) => step.screen_id),
      flow.steps.slice(0, 20).map((step) => step.screen_id),
    );
    assert.ok(result.content.some((block) => block.type === "image"));
  }
  const directory = fileURLToPath(
    new URL("../output/verification/local-library/", import.meta.url),
  );
  await mkdir(directory, { recursive: true });
  const receipt = {
    status,
    selfQueries,
    textQueries,
    auth: "No Mobbin credentials supplied to library-only server",
    inference: "Cached local weights; inference worker disables fetch",
    limitations: "Self-query/transport correctness checks are not a general relevance benchmark.",
  };
  await writeFile(path.join(directory, "acceptance.json"), JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify({
      passed: true,
      screens: status.screens,
      distinct_images: status.distinct_images,
      flows: status.flows,
      vectors: status.vectors,
      self_queries: selfQueries.length,
      receipt: path.join(directory, "acceptance.json"),
    }),
  );
} finally {
  await client.close();
}
