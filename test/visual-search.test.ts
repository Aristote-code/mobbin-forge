import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLocalServer } from "../src/index.js";
import { ResearchStore } from "../src/research/store.js";
import { VisualSearch } from "../src/visual/search.js";
import type { MobbinApiClient } from "../src/services/api-client.js";

const screenshot = await sharp({
  create: { width: 800, height: 1600, channels: 3, background: "#dce8f5" },
})
  .png()
  .toBuffer();
const base64 = screenshot.toString("base64");
const brief = {
  screen_type: "Account settings",
  layout: "Stacked cards with a bottom navigation bar",
  components: ["List", "Toggle"],
  style: "Light background",
  interaction_goal: "Manage account preferences",
};

function fakeClient() {
  const searches: Array<Record<string, unknown>> = [],
    downloads: string[] = [];
  const row = (id: string) => ({
    id,
    appName: `Product ${id}`,
    platform: "ios",
    screenUrl: `https://bytescale.mobbin.com/${id}.png`,
    screenPatterns: ["Settings"],
    screenElements: ["Toggle"],
  });
  const client = {
    searchScreens: async (args: Record<string, unknown>) => {
      searches.push(args);
      const q = String(args.query);
      if (q === "fails") throw Error("private backend diagnostic");
      return { value: { data: q === "second" ? [row("b"), row("c")] : [row("a"), row("b")] } };
    },
    searchSections: async (args: Record<string, unknown>) => {
      searches.push(args);
      return {
        value: {
          data: [
            {
              id: "section-a",
              siteName: "Example Site",
              imageUrl: "https://bytescale.mobbin.com/section.png",
              page_and_section_patterns: ["Pricing"],
            },
          ],
        },
      };
    },
    fetchScreenImage: async (url: string) => {
      downloads.push(url);
      if (url.includes("b.png") && downloads.filter((item) => item === url).length === 1)
        throw Error("image failed");
      return { buffer: screenshot, resolvedUrl: url, width: 800, height: 1600 };
    },
  } as unknown as MobbinApiClient;
  return { client, searches, downloads };
}

async function directory(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), "mobbin-visual-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("source loading returns real image pixels and supports conversation-native attachments without claiming to read them", async (t) => {
  const root = await directory(t),
    fake = fakeClient();
  await writeFile(path.join(root, "source.png"), screenshot);
  const visual = new VisualSearch(fake.client, { imageRoot: root });
  const local = await visual.prepare({ image_path: path.join(root, "source.png") });
  const inline = await visual.prepare({ image_base64: base64 });
  assert.equal(local.source.sha256, inline.source.sha256);
  assert.equal(local.source.original_width, 800);
  const metadata = await sharp(Buffer.from(local.preview!.data, "base64")).metadata();
  assert.equal(metadata.width, 800);
  assert.equal(metadata.height, 1600);
  const attachment = await visual.prepare({
    attachment_label: "Screenshot supplied in this conversation",
  });
  assert.equal(attachment.preview, undefined);
  assert.equal(attachment.source.kind, "conversation_attachment");
  assert.equal(attachment.source.source_image_in_packet, false);
  assert.equal(fake.downloads.length, 0);
  const remote = await visual.prepare({
    mobbin_image_url: "https://bytescale.mobbin.com/source.png",
  });
  assert.equal(remote.source.sha256, local.source.sha256);
  assert.equal(fake.downloads.length, 1);
});

test("invalid source combinations, non-images, malformed base64 and paths outside the configured root are rejected", async (t) => {
  const root = await directory(t),
    allowed = path.join(root, "allowed"),
    visual = new VisualSearch(fakeClient().client, { imageRoot: allowed });
  await mkdir(allowed);
  await writeFile(path.join(root, "outside.png"), screenshot);
  await writeFile(path.join(allowed, "not-image.png"), "not an image");
  await symlink(path.join(root, "outside.png"), path.join(allowed, "escape.png"));
  await assert.rejects(visual.prepare({}), /exactly one/);
  await assert.rejects(
    visual.prepare({ attachment_label: "one", image_base64: base64 }),
    /exactly one/,
  );
  await assert.rejects(visual.prepare({ image_path: "relative.png" }), /absolute/);
  await assert.rejects(visual.prepare({ image_path: path.join(allowed, "escape.png") }), /outside/);
  await assert.rejects(visual.prepare({ image_path: path.join(allowed, "not-image.png") }));
  await assert.rejects(visual.prepare({ image_base64: "not base64" }), /base64/);
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1600"><rect width="800" height="1600"/></svg>',
  ).toString("base64");
  await assert.rejects(visual.prepare({ image_base64: svg }), /vector/);
  const tiny = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  await assert.rejects(visual.prepare({ image_base64: tiny.toString("base64") }), /too small/);
});

test("visual retrieval sends only text standard-search queries, diversifies/deduplicates candidates and preserves partial failures", async () => {
  const fake = fakeClient(),
    visual = new VisualSearch(fake.client);
  const { source } = await visual.prepare({ image_base64: base64 });
  const found = await visual.search({
    source_id: source.id,
    source_inspected: true,
    brief,
    queries: ["first", "second", "fails"],
    max_candidates: 3,
  });
  assert.deepEqual(
    found.candidates.map((c) => c.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(found.candidates[1].retrieved_by, ["second", "first"]);
  assert.equal(found.search_errors.length, 1);
  assert.ok(!JSON.stringify(found).includes("private backend diagnostic"));
  assert.ok(!JSON.stringify(fake.searches).includes(base64));
  assert.ok(fake.searches.every((call) => call.mode === "standard" && call.pageSize === 3));
  assert.equal(found.ranking, "unranked_retrieval");
  assert.equal(fake.downloads.length, 0);
  await assert.rejects(
    visual.search({ source_id: source.id, source_inspected: false as true, brief }),
  );
  await assert.rejects(
    visual.search({ source_id: source.id, source_inspected: true, brief, queries: ["fails"] }),
    /All visual-reference/,
  );
});

test("comparison image failures stay explicit, retries work, and successful downloads are shared", async () => {
  const fake = fakeClient(),
    visual = new VisualSearch(fake.client);
  const { source } = await visual.prepare({ image_base64: base64 });
  const found = await visual.search({
    source_id: source.id,
    source_inspected: true,
    brief,
    queries: ["first"],
  });
  const initial = await visual.comparison(found.id, ["a", "b"]);
  assert.deepEqual(
    initial.candidates.map((c) => c.image_returned),
    [true, false],
  );
  assert.ok(initial.source_preview);
  const [retry, same] = await Promise.all([
    visual.comparison(found.id, ["a", "b"]),
    visual.comparison(found.id, ["a", "b"]),
  ]);
  assert.ok(retry.candidates.every((c) => c.image_returned));
  assert.ok(same.candidates.every((c) => c.image_returned));
  assert.equal(fake.downloads.filter((url) => url.includes("a.png")).length, 1);
  assert.equal(fake.downloads.filter((url) => url.includes("b.png")).length, 2);
  await assert.rejects(visual.comparison(found.id, ["a", "a"]), /distinct/);
  await assert.rejects(visual.comparison(found.id, ["foreign-candidate"]), /does not belong/);
  await assert.rejects(visual.comparison(found.id, []), /one to four/);
});

test("sources/searches are bounded, expire, and cannot be reused in another server session", async () => {
  let now = Date.now();
  const fake = fakeClient(),
    visual = new VisualSearch(fake.client, { now: () => now });
  const { source } = await visual.prepare({ attachment_label: "Attached screenshot" });
  const found = await visual.search({ source_id: source.id, source_inspected: true, brief });
  const other = new VisualSearch(fake.client);
  await assert.rejects(other.comparison(found.id, ["a"]), /another server session/);
  now += 20 * 60_000;
  await assert.rejects(visual.comparison(found.id, ["a"]), /expired/);
  await assert.rejects(
    visual.search({ source_id: source.id, source_inspected: true, brief }),
    /expired/,
  );
  const oldest = await visual.prepare({ attachment_label: "Oldest source" });
  for (let n = 0; n < 12; n++) await visual.prepare({ attachment_label: `Other source ${n}` });
  await assert.rejects(
    visual.search({ source_id: oldest.source.id, source_inspected: true, brief }),
    /expired/,
  );
});

test("website sections use the correct retrieval route and accept web-only platform", async () => {
  const fake = fakeClient(),
    visual = new VisualSearch(fake.client);
  const { source } = await visual.prepare({ attachment_label: "Pricing screenshot" });
  await assert.rejects(
    visual.search({
      source_id: source.id,
      source_inspected: true,
      brief,
      content_type: "sections",
    }),
    /platform=web/,
  );
  const found = await visual.search({
    source_id: source.id,
    source_inspected: true,
    brief,
    content_type: "sections",
    platform: "web",
    queries: ["pricing"],
  });
  assert.equal(found.candidates[0].product, "Example Site");
  assert.match(found.candidates[0].source_url, /\/sites\/sections\/section-a$/);
  assert.equal(fake.searches.length, 1);
  assert.equal(
    (await visual.comparison(found.id, ["section-a"])).candidates[0].image_returned,
    true,
  );
});

test("MCP exposes the native workflow prompt and correctly labeled source/candidate image batches with no AI calls", async (t) => {
  const root = await directory(t),
    fake = fakeClient(),
    visual = new VisualSearch(fake.client);
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("Unexpected external API call");
  });
  const server = await createLocalServer(fake.client, new ResearchStore(root), visual);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "native-vision-test", version: "1" });
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
  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.some((prompt) => prompt.name === "mobbin_visual_reference_search"));
  const prompt = await client.getPrompt({
    name: "mobbin_visual_reference_search",
    arguments: { goal: "Similar layout" },
  });
  assert.match(JSON.stringify(prompt), /calling agent's own image understanding/);
  const prepared = await call("mobbin_prepare_visual_search", { image_base64: base64 });
  assert.equal(
    (prepared.content as Array<{ type: string }>).filter((c) => c.type === "image").length,
    1,
  );
  assert.ok(!JSON.stringify(prepared.structuredContent).includes(base64));
  const sourceId = (prepared.structuredContent!.source as { id: string }).id;
  const found = await call("mobbin_search_visual_references", {
    source_id: sourceId,
    source_inspected: true,
    brief,
    queries: ["first"],
  });
  const packet = await call("mobbin_get_visual_comparison", {
    search_id: found.structuredContent!.id,
    candidate_ids: ["a", "b"],
  });
  const content = packet.content as Array<{ type: string; text?: string }>;
  assert.equal(content.filter((c) => c.type === "image").length, 2);
  assert.match(content[0].text!, /SOURCE:/);
  assert.match(content[2].text!, /CANDIDATE: a/);
  assert.equal(content[3].type, "image");
  assert.match(content[4].text!, /CANDIDATE: b/);
  assert.deepEqual(packet.structuredContent!.image_returned_candidate_ids, ["a"]);
  assert.ok(!JSON.stringify(packet.structuredContent).includes("data:image"));
  assert.ok(!(packet.structuredContent!.candidates as Array<Record<string, unknown>>)[0].preview);
  const bad = await client.callTool({
    name: "mobbin_get_visual_comparison",
    arguments: { search_id: found.structuredContent!.id, candidate_ids: ["not-from-search"] },
  });
  assert.equal(bad.isError, true);
  const attachment = await call("mobbin_prepare_visual_search", {
    attachment_label: "Conversation screenshot",
  });
  assert.equal(
    (attachment.content as Array<{ type: string }>).filter((c) => c.type === "image").length,
    0,
  );
});
