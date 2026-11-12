import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { MobbinApiClient } from "../src/services/api-client.js";
import type { MobbinAuth } from "../src/services/auth.js";
import { appPageScreenSchema } from "../src/services/schemas.js";
import { formatAppPageScreens } from "../src/utils/formatting.js";

const preview = "https://bytescale.mobbin.com/FW25bBB/image/mobbin.com/prod/file.webp?enc=opaque";
const path = "/mobbin.com/prod/content/app_screens/3b18d128-382c-4604-9f98-214c7d239779.png";
const original = `https://bytescale.mobbin.com/FW25bBB/image${path}?f=webp&w=1920&q=85&fit=shrink-cover`;
const client = () => new MobbinApiClient({} as MobbinAuth);
const image = await sharp({ create: { width: 400, height: 800, channels: 3, background: "red" } })
  .webp()
  .toBuffer();
const response = () =>
  new Response(new Uint8Array(image), { headers: { "Content-Type": "image/webp" } });
const discovery = (filePathNotFound = path) =>
  Response.json(
    { error: { code: "file_not_found", details: { filePathNotFound } } },
    { status: 404 },
  );

// Each test restores fetch; tests run sequentially to isolate network mocks.
test("encrypted previews resolve to full images and concurrent lookups are deduplicated", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/raw/")) return discovery();
    assert.equal(url, original);
    return response();
  });
  const c = client();
  const results = await Promise.all([c.fetchScreenImage(preview), c.fetchScreenImage(preview)]);
  assert.equal(requests.filter((url) => url.includes("/raw/")).length, 1);
  assert.ok(requests[0].endsWith("?enc=opaque"));
  for (const result of results) {
    assert.equal(result.resolvedUrl, original);
    assert.equal(result.width, 400);
    assert.equal(result.height, 800);
    assert.equal(result.mimeType, "image/webp");
  }
});

test("invalid discovery paths preserve the original URL and failed lookups can retry", async (t) => {
  let lookups = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    if (String(input).includes("/raw/")) {
      lookups++;
      return discovery("/mobbin.com/prod/content/app_logos/logo.png");
    }
    assert.equal(String(input), preview);
    return response();
  });
  const c = client();
  assert.equal((await c.fetchScreenImage(preview)).resolvedUrl, preview);
  await c.fetchScreenImage(preview);
  assert.equal(lookups, 2);
});

test("normal CDN URLs stay intact and Supabase paths convert", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    requests.push(String(input));
    return response();
  });
  await client().fetchScreenImage(original);
  await client().fetchScreenImage(
    `https://ujasntkfphywizsdaapi.supabase.co/storage/v1/object/public/content/app_screens/example.png`,
  );
  assert.equal(requests[0], original);
  assert.ok(requests[1].includes("/image/mobbin.com/prod/content/app_screens/example.png?"));
  assert.equal(requests.length, 2);
});

test("tiny previews and non-image payloads fail instead of returning misleading images", async (t) => {
  const tiny = await sharp({ create: { width: 15, height: 33, channels: 3, background: "white" } })
    .png()
    .toBuffer();
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(tiny)));
  await assert.rejects(client().fetchScreenImage(original), /tiny preview/);
  globalThis.fetch = async () => new Response("<html>Login</html>");
  await assert.rejects(client().fetchScreenImage(original), /unsupported image format/i);
});

test("untrusted URLs never reach the network", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("should not fetch");
  });
  for (const url of [
    "https://evil.test/image.png",
    "http://bytescale.mobbin.com/image.png",
    "https://bytescale.mobbin.com:8080/image.png",
    "https://user:pass@bytescale.mobbin.com/image.png",
  ]) {
    await assert.rejects(client().fetchScreenImage(url), /Untrusted image host/);
  }
});

test("restricted screens retain usable URLs and every requested page entry", () => {
  const screens = Array.from({ length: 50 }, (_, i) =>
    appPageScreenSchema.parse({
      id: String(i),
      screenUrl: preview + "x".repeat(700),
      restricted: true,
    }),
  );
  const formatted = formatAppPageScreens(screens);
  assert.equal((formatted.match(/\*\*Screen URL\*\*/g) ?? []).length, 50);
  assert.ok(formatted.includes(preview));
});

test("a failed discovered download falls back to the usable encrypted image", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/raw/")) return discovery();
    if (url === original) return new Response("not found", { status: 404 });
    assert.equal(url, preview);
    return response();
  });
  assert.equal((await client().fetchScreenImage(preview)).resolvedUrl, preview);
});
