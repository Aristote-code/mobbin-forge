/** Development-only MCP Apps host. Serves on loopback and uses the real local MCP. */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
const client = new Client({ name: "gallery-preview", version: "1" });
const cached = process.argv.includes("--cached");
if (cached) {
  const { readFile } = await import("node:fs/promises");
  const { createLocalServer } = await import("../dist/index.js");
  const { MobbinApiClient } = await import("../dist/services/api-client.js");
  const { appPageScreenSchema } = await import("../dist/services/schemas.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const saved = JSON.parse(
    await readFile(new URL("../output/duolingo/manifest.json", import.meta.url), "utf8"),
  );
  const screens = saved.map((item) =>
    appPageScreenSchema.parse({
      id: item.listing.match(/\*\*Screen ID\*\*: (\S+)/)?.[1],
      appName: "Duolingo",
      screenUrl: item.detail.match(/\*\*Source URL\*\*: (\S+)/)?.[1],
      screenPatterns: [
        item.index === 1
          ? "Splash Screen"
          : item.index === 101
            ? "Lesson Feedback"
            : "Math Exercise",
      ],
      width: item.width,
      height: item.height,
      restricted: item.restricted,
    }),
  );
  const api = new MobbinApiClient({});
  api.getAppPage = async () => ({
    screens,
    flows: [],
    appName: "Duolingo · cached references",
    slug: "duolingo",
    totalScreens: screens.length,
    restrictedScreens: screens.filter((s) => s.restricted).length,
    availableScreens: screens.filter((s) => !s.restricted).length,
  });
  const localServer = await createLocalServer(api);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await localServer.connect(b);
  await client.connect(a);
} else {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
      stderr: "inherit",
    }),
  );
}
const ui = await client.readResource({ uri: "ui://mobbin-forge/gallery.html" });
const bundle = await build({
  entryPoints: ["scripts/gallery-host.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
const token = randomBytes(32).toString("hex");
const args = {
  app_id: process.env.GALLERY_APP_ID ?? "688f6e68-12be-4b63-80b7-8377c8482911",
  page_size: cached ? 2 : 6,
  page_index: cached ? 0 : 16,
};
let initial;
const allowed = new Set([
  "mobbin_get_app_screens",
  "mobbin_search_screens",
  "mobbin_get_gallery_image",
]);
const server = createServer(async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && pathname === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><html><head><meta charset="UTF-8"><meta name="preview-token" content="${token}"><title>Mobbin Forge live gallery</title><style>body{font:14px system-ui;background:#e8ece5;padding:20px;margin:0}header{margin:0 auto 14px;max-width:1100px}iframe{display:block;width:min(1100px,100%);height:1100px;margin:auto;border:1px solid #c7d1c0;border-radius:15px;background:#f5f7f3}</style></head><body><header><h1>Mobbin Forge · gallery preview</h1><p id="status">Connecting to the local MCP…</p></header><iframe id="gallery" title="Duolingo screen gallery"></iframe><script type="module" src="/host.js"></script></body></html>`,
      );
      return;
    }
    if (req.method === "GET" && pathname === "/host.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(bundle.outputFiles[0].text);
      return;
    }
    if (req.method === "GET" && pathname === "/gallery") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(ui.contents[0].text);
      return;
    }
    if (req.method === "GET" && pathname === "/initial") {
      initial ??= client.callTool({ name: "mobbin_get_app_screens", arguments: args });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ args, cached, result: await initial }));
      return;
    }
    if (req.method === "POST" && pathname === "/rpc") {
      if (req.headers["x-preview-token"] !== token) {
        res.writeHead(403);
        res.end();
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 20000) throw Error("Request too large");
      }
      const params = JSON.parse(body);
      if (!allowed.has(params.name)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const result = await client.callTool(params);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
      return;
    }
    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (error) {
    console.error(error.message);
    res.writeHead(500);
    res.end("Gallery request failed");
  }
});
await new Promise((resolve) => server.listen(43190, "127.0.0.1", resolve));
console.log(`${cached ? "Cached" : "Live"} gallery preview: http://127.0.0.1:43190`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    server.closeAllConnections();
    server.close();
    await client.close();
    process.exit(0);
  });
