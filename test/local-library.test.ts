import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LocalLibrary } from "../src/library/store.js";
import { createLibraryServer } from "../src/library/cli.js";
import { manifestSchema, MODEL, type EmbeddingEngine } from "../src/library/schema.js";

const red = await sharp({ create: { width: 100, height: 200, channels: 3, background: "red" } })
  .png()
  .toBuffer();
const blue = await sharp({ create: { width: 100, height: 200, channels: 3, background: "blue" } })
  .png()
  .toBuffer();
const vector = (index: number) =>
  Array.from({ length: MODEL.dimensions }, (_, n) => (n === index ? 1 : 0));
function engine() {
  let images = 0;
  const fake: EmbeddingEngine = {
    setup: async () => MODEL,
    close: async () => {},
    text: async (text) => vector(text.includes("blue") ? 1 : 0),
    image: async (bytes) => {
      images++;
      return [
        {
          region: "full",
          vector: vector(
            createHash("sha256").update(bytes).digest("hex") ===
              createHash("sha256").update(blue).digest("hex")
              ? 1
              : 0,
          ),
        },
      ];
    },
  };
  return { fake, images: () => images };
}
const dataset = {
  id: "owned-test",
  title: "Owned test UI",
  source_url: "https://example.org/owned",
  license: "CC0-1.0",
  license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
  attribution: "Test fixtures generated for this repository",
  rights_basis: "owned" as const,
};
const manifest = {
  schema_version: 1 as const,
  dataset,
  screens: [
    {
      id: "red",
      image: "red.png",
      title: "Red feedback",
      product: "Example A",
      platform: "android" as const,
      tags: ["feedback"],
      text: "red warning panel",
    },
    {
      id: "blue",
      image: "blue.png",
      title: "Blue settings",
      product: "Example B",
      platform: "android" as const,
      tags: ["settings"],
      text: "blue account settings toggle",
    },
    {
      id: "red-alias",
      image: "red.png",
      title: "Red again",
      product: "Example A",
      platform: "android" as const,
      tags: [],
      text: "red feedback alternate context",
    },
  ],
  flows: [
    {
      id: "flow-a",
      title: "Feedback to settings",
      goal: "Review warning and open settings",
      complete: true,
      steps: [
        { screen_id: "red", source_step: 0, action: "Open settings" },
        { screen_id: "blue", source_step: 1, action: "Return" },
        { screen_id: "red-alias", source_step: 2, action: "Finish" },
      ],
    },
  ],
};
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), "mobbin-library-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "red.png"), red);
  await writeFile(path.join(root, "blue.png"), blue);
  const filename = path.join(root, "manifest.json");
  await writeFile(filename, JSON.stringify(manifest));
  const embeddings = engine(),
    library = new LocalLibrary(path.join(root, "index"), embeddings.fake);
  t.after(() => library.close());
  return { root, filename, library, embeddings };
}

test("library imports immutable local images, deduplicates assets/vectors, preserves ordered flow aliases and reopens", async (t) => {
  const f = await fixture(t);
  const status = await f.library.importManifest(f.filename);
  assert.equal(status.screens, 3);
  assert.equal(status.distinct_images, 2);
  assert.equal(status.flows, 1);
  assert.equal(status.vectors, 2);
  assert.equal(f.embeddings.images(), 2);
  const reopened = new LocalLibrary(path.join(f.root, "index"), f.embeddings.fake);
  assert.equal((await reopened.status()).screens, 3);
  assert.deepEqual(
    (await reopened.flow("flow-a")).flow.steps.map((step: { screen_id: string }) => step.screen_id),
    ["red", "blue", "red-alias"],
  );
  await writeFile(path.join(f.root, "red.png"), "changed original");
  const screen = await reopened.screen("red");
  assert.equal(screen.width, 100);
  assert.equal((await sharp(Buffer.from(screen.image.data, "base64")).metadata()).height, 200);
  assert.deepEqual(screen.flow_ids, ["flow-a"]);
});

test("local image/text vector search returns expected neighbors with keyword fusion and filters", async (t) => {
  const f = await fixture(t);
  await f.library.importManifest(f.filename);
  const image = await f.library.search({ image: blue });
  assert.equal(image.results[0].id, "blue");
  assert.ok(Math.abs(image.results[0].cosine_similarity - 1) < 1e-6);
  assert.equal((await f.library.search({ query: "blue settings" })).results[0].id, "blue");
  assert.deepEqual(
    (await f.library.search({ query: "blue", product: "example a" })).results
      .map((row) => row.id)
      .sort(),
    ["red", "red-alias"],
  );
  assert.equal((await f.library.search({ query: "blue", platform: "ios" })).results.length, 0);
  assert.ok((await f.library.search({ query: '"; DROP TABLE screens; --' })).results.length > 0);
  assert.equal((await f.library.status()).screens, 3);
  await assert.rejects(f.library.search({ query: "blue", image: red }), /exactly one/);
  await assert.rejects(f.library.search({ image: Buffer.from("not an image") }));
});

test("failed replacement leaves the installed index intact and cached embeddings support resume", async (t) => {
  const f = await fixture(t);
  await f.library.importManifest(f.filename);
  assert.equal((await f.library.importManifest(f.filename)).unchanged, true);
  const next = { ...manifest, dataset: { ...dataset, title: "Replacement" } };
  await writeFile(f.filename, JSON.stringify(next));
  await assert.rejects(f.library.importManifest(f.filename), /--replace/);
  await f.library.importManifest(f.filename, { replace: true });
  assert.equal(f.embeddings.images(), 2);
  const before = await f.library.status();
  await writeFile(
    f.filename,
    JSON.stringify({
      ...next,
      screens: [...next.screens, { ...next.screens[0], id: "bad", image: "missing.png" }],
    }),
  );
  await assert.rejects(f.library.importManifest(f.filename, { replace: true }));
  assert.equal((await f.library.status()).manifest_sha256, before.manifest_sha256);
  assert.equal((await f.library.search({ image: blue })).results[0].id, "blue");
});

test("imports require rights/provenance, bounded screen counts, valid IDs, and closed flow references", async (t) => {
  const f = await fixture(t);
  assert.throws(() =>
    manifestSchema.parse({ ...manifest, dataset: { ...dataset, rights_basis: undefined } }),
  );
  assert.throws(() =>
    manifestSchema.parse({
      ...manifest,
      screens: Array.from({ length: 1001 }, (_, i) => ({
        ...manifest.screens[0],
        id: `screen-${i}`,
      })),
    }),
  );
  await writeFile(
    f.filename,
    JSON.stringify({
      ...manifest,
      flows: [{ ...manifest.flows[0], steps: [{ screen_id: "missing", source_step: 0 }] }],
    }),
  );
  await assert.rejects(f.library.importManifest(f.filename), /missing screen/);
  await writeFile(
    f.filename,
    JSON.stringify({ ...manifest, screens: [manifest.screens[0], manifest.screens[0]] }),
  );
  await assert.rejects(f.library.importManifest(f.filename), /unique/);
  assert.equal(f.embeddings.images(), 0);
  assert.equal((await f.library.status()).available, false);
});

test("imports reject symlink escapes and overlapping imports", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "nested"));
  await symlink(path.join(f.root, "red.png"), path.join(f.root, "nested", "escape.png"));
  const escaped = {
    ...manifest,
    screens: [{ ...manifest.screens[0], image: "escape.png" }],
    flows: [],
  };
  const file = path.join(f.root, "nested", "manifest.json");
  await writeFile(file, JSON.stringify(escaped));
  await assert.rejects(f.library.importManifest(file), /outside/);
  await mkdir(path.join(f.root, "index", ".import.lock"));
  await assert.rejects(f.library.importManifest(f.filename), /already running/);
});

test("library-only MCP serves actual screenshots, local search and paginated flows without auth or network", async (t) => {
  const f = await fixture(t);
  await f.library.importManifest(f.filename);
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("Unexpected network request");
  });
  const server = createLibraryServer(f.library),
    [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "local-library-test", version: "1" });
  await client.connect(a);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return result;
  };
  assert.equal((await client.listTools()).tools.length, 4);
  assert.equal((await call("mobbin_local_library_status", {})).structuredContent!.screens, 3);
  const found = await call("mobbin_search_local_library", {
    image_base64: blue.toString("base64"),
  });
  assert.equal((found.structuredContent!.results as Array<{ id: string }>)[0].id, "blue");
  const image = await call("mobbin_get_local_screen", { screen_id: "blue" });
  assert.equal(
    (image.content as Array<{ type: string }>).filter((block) => block.type === "image").length,
    1,
  );
  const flow = await call("mobbin_get_local_flow", {
    flow_id: "flow-a",
    offset: 1,
    limit: 1,
    include_images: true,
  });
  assert.equal(flow.structuredContent!.next_offset, 2);
  assert.equal(flow.structuredContent!.total_steps, 3);
  assert.equal(
    (flow.structuredContent!.flow as { steps: Array<{ screen_id: string }> }).steps[0].screen_id,
    "blue",
  );
  assert.equal(
    (flow.content as Array<{ type: string }>).filter((block) => block.type === "image").length,
    1,
  );
  const bad = await client.callTool({
    name: "mobbin_get_local_screen",
    arguments: { screen_id: "missing" },
  });
  assert.equal(bad.isError, true);
  assert.ok((await readFile(path.join(f.root, "index", "library.sqlite"))).length > 0);
});
