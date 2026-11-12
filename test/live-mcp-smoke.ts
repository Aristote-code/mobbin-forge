/** Opt-in network check: npm run test:live (uses ~/.mobbin-mcp/auth.json). */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import sharp from "sharp";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  stderr: "pipe",
});
const client = new Client({ name: "mobbin-live-smoke", version: "1.0.0" });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === "mobbin_get_screen_detail"));
  const appScreens = tools.find((t) => t.name === "mobbin_get_app_screens")!;
  assert.equal(
    (appScreens.inputSchema.properties?.include_restricted as { default: boolean }).default,
    true,
  );
  console.log(`Discovered ${tools.length} MCP tools; restricted screens included by default.`);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return result;
  };
  const text = (r: Awaited<ReturnType<typeof call>>) =>
    (r.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  const suggestions = text(await call("mobbin_quick_search", { query: "Duolingo" }));
  const appId = suggestions.match(/ID: ([0-9a-f-]+)/)?.[1];
  assert.ok(appId);
  const first = text(await call("mobbin_get_app_screens", { app_id: appId, page_size: 50 }));
  assert.equal((first.match(/\*\*Screen URL\*\*/g) ?? []).length, 50);
  console.log(first.split("\n").slice(0, 2).join("\n"));
  const total = Number(first.match(/— (\d+) screens total/)?.[1]);
  assert.ok(total > 50);
  const last = text(
    await call("mobbin_get_app_screens", {
      app_id: appId,
      page_size: 50,
      page_index: Math.ceil(total / 50) - 1,
    }),
  );
  assert.equal((last.match(/\*\*Screen URL\*\*/g) ?? []).length, total % 50 || 50);
  assert.ok(last.includes("RESTRICTED PREVIEW"));
  const url = last.match(/\*\*Screen URL\*\*: (https:\/\/\S+)/)?.[1];
  assert.ok(url);
  const detail = await call("mobbin_get_screen_detail", { screen_url: url, extract_colors: true });
  const img = (detail.content as Array<{ type: string; data: string }>).find(
    (c) => c.type === "image",
  );
  assert.ok(img);
  const metadata = await sharp(Buffer.from(img.data, "base64")).metadata();
  assert.ok(metadata.width! >= 256);
  console.log(
    `MCP image response: ${metadata.width}×${metadata.height}, color extraction succeeded.`,
  );
  const flows = text(await call("mobbin_get_app_flows", { app_id: appId, page_size: 2 }));
  assert.match(flows, /https:\/\/(?:bytescale\.mobbin\.com|ujasntkfphywizsdaapi\.supabase\.co)\//);
  const unavailable = await client.callTool({
    name: "mobbin_get_screen_detail",
    arguments: { screen_url: "https://example.com/image.png" },
  });
  assert.equal(unavailable.isError, true);
  console.log("First/last pages, full-size image, colors, flows, and image error handling passed.");
  for (const [name, args] of [
    ["mobbin_search_apps", { page_size: 2 }],
    ["mobbin_search_screens", { page_size: 2 }],
    ["mobbin_search_flows", { page_size: 2 }],
    ["mobbin_popular_apps", { limit_per_category: 1 }],
    ["mobbin_list_collections", {}],
    ["mobbin_get_filters", { kind: "patterns" }],
  ] as const) {
    const result = await call(name, args);
    assert.ok(text(result).length > 0);
    console.log(`${name}: passed`);
  }
} finally {
  await client.close();
}
