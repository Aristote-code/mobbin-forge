import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLocalServer } from "../src/index.js";
import { MobbinApiClient } from "../src/services/api-client.js";
import { appPageScreenSchema } from "../src/services/schemas.js";
import {
  GalleryImages,
  galleryResult,
  GALLERY_URI,
  type GalleryItem,
} from "../src/services/gallery.js";

const image = await sharp({
  create: { width: 1180, height: 2556, channels: 3, background: "green" },
})
  .webp()
  .toBuffer();
const url =
  "https://bytescale.mobbin.com/FW25bBB/image/mobbin.com/prod/content/app_screens/test.png";
function fakeClient() {
  let downloads = 0;
  const client = new MobbinApiClient({} as never);
  client.fetchScreenImage = async (imageUrl) => {
    downloads++;
    if (imageUrl.endsWith("missing")) throw Error("missing");
    return {
      buffer: image,
      base64: image.toString("base64"),
      mimeType: "image/webp",
      sizeBytes: image.length,
      width: 1180,
      height: 2556,
      resolvedUrl: imageUrl,
    };
  };
  return { client, downloads: () => downloads };
}

test("gallery shares image work, returns compact thumbnails, and retries failures", async () => {
  const fake = fakeClient();
  const images = new GalleryImages(fake.client);
  const [a, b] = await Promise.all([images.get(url), images.get(url)]);
  assert.equal(fake.downloads(), 1);
  assert.deepEqual(a, b);
  const metadata = await sharp(Buffer.from(a.thumbnail.split(",")[1], "base64")).metadata();
  assert.ok(metadata.width! <= 320);
  assert.ok(metadata.height! <= 700);
  assert.equal(a.width, 1180);
  assert.equal(a.image_url, url);
  await assert.rejects(images.get(url + "missing"));
  await assert.rejects(images.get(url + "missing"));
  assert.equal(fake.downloads(), 3);
});

test("one unavailable preview does not erase the gallery or remaining images", async () => {
  const fake = fakeClient();
  const images = new GalleryImages(fake.client);
  const items: GalleryItem[] = ["missing", "2", "3", "4"].map((id) => ({
    id,
    title: id,
    app_name: "Test",
    platform: "ios",
    screen_url: url + id,
    restricted: true,
    patterns: [],
    elements: [],
  }));
  const result = await galleryResult(
    {
      title: "Test",
      items,
      page_index: 0,
      has_next_page: false,
      tool: "mobbin_get_app_screens",
      arguments: {},
    },
    "All four",
    images,
  );
  assert.equal(result.content.filter((c) => c.type === "image").length, 2);
  assert.equal((result.structuredContent!.items as GalleryItem[]).length, 4);
  assert.equal(items[0].error, "missing");
  assert.equal(fake.downloads(), 3);
});

test("MCP exposes app metadata, renders the bundled resource, and pages without hiding restricted screens", async () => {
  const fake = fakeClient();
  const screens = Array.from({ length: 5 }, (_, index) =>
    appPageScreenSchema.parse({
      id: String(index),
      screenUrl: url + index,
      restricted: true,
      appName: "Test",
      width: 1180,
      height: 2556,
    }),
  );
  fake.client.getAppPage = async () => ({
    screens,
    flows: [],
    appName: "Test",
    slug: "test",
    totalScreens: 5,
    restrictedScreens: 5,
    availableScreens: 0,
  });
  const server = await createLocalServer(fake.client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "gallery-test", version: "1" });
  await client.connect(a);
  try {
    const { tools } = await client.listTools();
    const collectionTool = tools.find((tool) => tool.name === "mobbin_get_collection")!;
    assert.ok(
      (collectionTool.inputSchema.properties!.content_type as { enum: string[] }).enum.includes(
        "sections",
      ),
    );

    assert.equal(
      (
        tools.find((tool) => tool.name === "mobbin_get_app_screens")!._meta!.ui as {
          resourceUri: string;
        }
      ).resourceUri,
      GALLERY_URI,
    );
    const ui = await client.readResource({ uri: GALLERY_URI });
    assert.equal(ui.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.ok("text" in ui.contents[0] && ui.contents[0].text.includes("Filter this page"));
    assert.ok("text" in ui.contents[0] && !ui.contents[0].text.includes("/* GALLERY_SCRIPT */"));
    const result = await client.callTool({
      name: "mobbin_get_app_screens",
      arguments: { app_id: "688f6e68-12be-4b63-80b7-8377c8482911", page_size: 2, page_index: 1 },
    });
    assert.ok(!result.isError);
    const data = result.structuredContent!;
    assert.equal(data.total, 5);
    assert.equal(data.has_next_page, true);
    assert.deepEqual(
      (data.items as GalleryItem[]).map((item) => item.id),
      ["2", "3"],
    );
    assert.equal(result.content.filter((c) => c.type === "image").length, 2);
    const last = await client.callTool({
      name: "mobbin_get_app_screens",
      arguments: { app_id: "688f6e68-12be-4b63-80b7-8377c8482911", page_size: 2, page_index: 2 },
    });
    assert.equal(last.structuredContent!.has_next_page, false);
    const empty = await client.callTool({
      name: "mobbin_get_app_screens",
      arguments: {
        app_id: "688f6e68-12be-4b63-80b7-8377c8482911",
        page_size: 2,
        include_restricted: false,
      },
    });
    assert.equal(empty.structuredContent!.total, 0);
  } finally {
    await client.close();
    await server.close();
  }
});
