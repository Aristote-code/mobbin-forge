import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LocalLibrary } from "../src/library/store.js";
import { UIKnowledge } from "../src/library/knowledge.js";
import { createLibraryServer } from "../src/library/cli.js";
import { MODEL, type EmbeddingEngine } from "../src/library/schema.js";
import type { KnowledgeInput } from "../src/library/knowledge-schema.js";

const red = await sharp({ create: { width: 200, height: 400, channels: 3, background: "red" } })
  .png()
  .toBuffer();
const blue = await sharp({ create: { width: 200, height: 400, channels: 3, background: "blue" } })
  .png()
  .toBuffer();
const vector = (n: number) => Array.from({ length: MODEL.dimensions }, (_, i) => (i === n ? 1 : 0));
function engine(): EmbeddingEngine {
  return {
    setup: async () => MODEL,
    close: async () => {},
    text: async (t) => vector(t.includes("blue") ? 1 : 0),
    image: async (bytes) => {
      const { channels } = await sharp(bytes).stats();
      return [{ region: "full", vector: vector(channels[2].mean > channels[0].mean ? 1 : 0) }];
    },
  };
}
const annotations = {
  title: "Membership card",
  product: "Example A",
  summary: "A membership card with a primary action.",
  patterns: ["membership"],
  components: [{ type: "card", description: "Membership card with a heading and action." }],
  observations: ["Red rectangular surface."],
  interpretations: ["Could provide access to a membership."],
  visual_details: [{ attribute: "font_family", value: "Sans serif", basis: "estimated" as const }],
  annotation: { author: "test user", basis: "user_provided" as const, image_inspected: true },
  rights: { basis: "owned" as const, attribution: "Owned test raster", license: "Owned test" },
};
const make = (image = red, extra: Partial<KnowledgeInput> = {}): KnowledgeInput => ({
  ...annotations,
  image_base64: image.toString("base64"),
  ...extra,
});
async function fixture(t: { after: (f: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), "ui-knowledge-"));
  const lib = new LocalLibrary(root, engine());
  t.after(async () => {
    await lib.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, lib, store: new UIKnowledge(lib) };
}

test("UI knowledge persists real component crops, measured palette, estimates and rights across reopen", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.store.status()).references, 0);
  const saved = await f.store.save(
    make(red, { reference_id: "red-card", crop: { x: 0.1, y: 0.25, width: 0.8, height: 0.5 } }),
  );
  assert.equal(saved.kind, "component");
  assert.equal(saved.measured.width, 160);
  assert.equal(saved.measured.height, 200);
  assert.equal(saved.measured.palette[0].hex, "#ff0000");
  assert.equal(saved.source.rights.basis, "owned");
  assert.equal(saved.source.flow_contexts.length, 0);
  assert.equal(saved.visual_details[0].basis, "estimated");
  const reopened = new UIKnowledge(f.lib);
  const got = await reopened.get(saved.reference_id);
  const meta = await sharp(got.bytes).metadata();
  assert.equal(meta.width, 160);
  assert.equal(meta.height, 200);
  assert.equal((await stat(path.join(f.root, "knowledge.sqlite"))).mode & 0o777, 0o600);
  assert.deepEqual(got.record, saved);
  assert.equal((await reopened.status()).component_references, 1);
});

test("image/text search uses component crops and annotation filters, preserves exact-image usages", async (t) => {
  const f = await fixture(t);
  await f.store.save(
    make(red, { reference_id: "red-card", crop: { x: 0.1, y: 0.25, width: 0.8, height: 0.5 } }),
  );
  await f.store.save(
    make(blue, {
      reference_id: "blue-card",
      product: "Example B",
      summary: "Blue price comparison card",
      patterns: ["pricing"],
    }),
  );
  const sameCrop = await sharp(red)
    .extract({ left: 20, top: 100, width: 160, height: 200 })
    .png()
    .toBuffer();
  await f.store.save(
    make(sameCrop, { reference_id: "red-card-other-context", product: "Example C" }),
  );
  const image = await f.store.search({
    image: red,
    crop: { x: 0.1, y: 0.25, width: 0.8, height: 0.5 },
  });
  assert.equal(image.results[0].exact_image_match, true);
  assert.equal(image.results.length, 2);
  assert.ok(image.results[0].related_reference_ids.length === 1);
  assert.equal(
    (await f.store.search({ query: "blue pricing" })).results[0].reference_id,
    "blue-card",
  );
  assert.equal(
    (await f.store.search({ component: "CARD", pattern: "PRICING" })).results[0].reference_id,
    "blue-card",
  );
  assert.equal((await f.store.search({ pattern: "not-present" })).results.length, 0);
  assert.equal(
    (await f.store.search({ product: "Example B", kind: "component" })).results.length,
    0,
  );
  assert.equal((await f.store.search({ result_mode: "app_diverse" })).results.length, 2);
  await assert.rejects(f.store.search({ query: "card", image: red }), /not both/);
  await assert.rejects(
    f.store.search({ query: "card", crop: { x: 0, y: 0, width: 1, height: 1 } }),
    /requires an image/,
  );
});

test("knowledge updates require current revisions and stale writes preserve saved annotations", async (t) => {
  const f = await fixture(t);
  const first = await f.store.save(make(red, { reference_id: "card" }));
  const outcomes = await Promise.allSettled([
    f.store.save(make(red, { reference_id: "card", expected_revision: 1, title: "Version two" })),
    f.store.save(
      make(red, { reference_id: "card", expected_revision: 1, title: "Concurrent update" }),
    ),
  ]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((r) => r.status === "rejected").length, 1);
  const second = (await f.store.get("card")).record;
  assert.equal(second.revision, 2);
  assert.equal(second.created_at, first.created_at);
  await assert.rejects(f.store.save(make(red, { reference_id: "card" })), /revision conflict/);
  assert.equal((await f.store.get("card")).record.revision, 2);
  assert.equal((await f.store.status()).references, 1);
});

test("custom imports reject missing rights, invalid crops and false inspection attestations before saving", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.store.save(make(red, { rights: undefined })), /rights/);
  await assert.rejects(
    f.store.save(
      make(red, {
        annotation: { author: "agent", basis: "agent_inspected", image_inspected: false },
      }),
    ),
    /inspection/,
  );
  await assert.rejects(
    f.store.save(make(red, { crop: { x: 0.9, y: 0, width: 0.5, height: 1 } })),
    /fit inside/,
  );
  await assert.rejects(
    f.store.save(make(red, { crop: { x: 0, y: 0, width: 0.1, height: 0.1 } })),
    /64/,
  );
  await assert.rejects(
    f.store.save(make(red, { kind: "screen", crop: { x: 0, y: 0, width: 1, height: 1 } })),
    /component/,
  );
  assert.equal((await f.store.status()).references, 0);
});

test("indexed sources inherit licensing and retain bounded ordered flow snapshots across index replacement", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "red.png"), red);
  await writeFile(path.join(f.root, "blue.png"), blue);
  const manifest = {
    schema_version: 1,
    dataset: {
      id: "owned-test",
      title: "Owned test",
      source_url: "https://example.org",
      license: "Owned",
      license_url: "https://example.org/rights",
      attribution: "Owned fixtures",
      rights_basis: "owned",
    },
    screens: [
      { id: "red", image: "red.png", title: "Red", product: "Example A", platform: "android" },
      { id: "blue", image: "blue.png", title: "Blue", product: "Example B", platform: "android" },
    ],
    flows: [
      {
        id: "flow",
        title: "Red then blue",
        goal: "Switch",
        complete: true,
        steps: [
          { screen_id: "red", source_step: 0, action: "Open blue" },
          { screen_id: "blue", source_step: 1, action: "Finish" },
        ],
      },
    ],
  };
  const filename = path.join(f.root, "manifest.json");
  await writeFile(filename, JSON.stringify(manifest));
  await f.lib.importManifest(filename);
  const { image_base64, rights, product, ...input } = make();
  void image_base64;
  void rights;
  void product;
  const saved = await f.store.save({
    ...input,
    reference_id: "indexed-card",
    screen_id: "red",
    crop: { x: 0, y: 0, width: 1, height: 0.5 },
  });
  assert.equal(saved.source.rights.attribution, "Owned fixtures");
  assert.equal(saved.product, "Example A");
  assert.deepEqual(
    saved.source.flow_contexts[0].steps.map((s) => s.position),
    [0, 1],
  );
  assert.equal(saved.source.flow_contexts[0].matching_position, 0);
  await writeFile(filename, JSON.stringify({ ...manifest, flows: [] }));
  await f.lib.importManifest(filename, { replace: true });
  assert.equal((await f.store.get("indexed-card")).record.source.flow_contexts[0].flow_id, "flow");
  assert.equal((await f.lib.status()).screens, 2);
  assert.equal((await f.store.status()).annotated_screens, 1);
});

test("MCP supports inspect source, save, retrieve, search and partial comparison with no auth or network", async (t) => {
  const f = await fixture(t);
  const server = createLibraryServer(f.lib);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "ui-knowledge-test", version: "1" });
  await client.connect(a);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r));
    return r;
  };
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 10);
  assert.equal(
    tools.find((t) => t.name === "mobbin_save_ui_reference")!.annotations!.readOnlyHint,
    false,
  );
  const before = await call("mobbin_compare_ui_references", {
    image_base64: red.toString("base64"),
  });
  assert.equal(before.content.filter((b) => b.type === "image").length, 1);
  await call("mobbin_save_ui_reference", make(red, { reference_id: "red-card" }));
  await call(
    "mobbin_save_ui_reference",
    make(blue, { reference_id: "blue-card", product: "Example B" }),
  );
  const found = await call("mobbin_search_ui_knowledge", { query: "blue", component: "card" });
  assert.equal((found.structuredContent!.results as any[])[0].reference_id, "blue-card");
  const got = await call("mobbin_get_ui_reference", { reference_id: "red-card" });
  assert.equal(got.content.filter((b) => b.type === "image").length, 1);
  const compare = await call("mobbin_compare_ui_references", {
    source_reference_id: "red-card",
    candidate_reference_ids: ["blue-card", "missing"],
  });
  assert.equal(compare.structuredContent!.visual_judgment, "pending_agent_inspection");
  assert.equal(compare.content.filter((b) => b.type === "image").length, 2);
  assert.equal((compare.structuredContent!.candidates as any[])[1].image_status, "unavailable");
  const auto = await call("mobbin_compare_ui_references", { source_reference_id: "red-card" });
  assert.equal((auto.structuredContent!.candidates as any[])[0].reference_id, "blue-card");
  const prompt = await client.getPrompt({
    name: "mobbin_ui_pattern_search",
    arguments: { request: "Find membership card alternatives" },
  });
  assert.match(JSON.stringify(prompt), /normalized crop/);
});
