/** Opt-in network check: npm run test:live (uses ~/.mobbin-mcp/auth.json). */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const researchDirectory = await mkdtemp(path.join(tmpdir(), "mobbin-live-research-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  stderr: "pipe",
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    MOBBIN_RESEARCH_DIR: researchDirectory,
  },
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
  assert.ok(tools.some((tool) => tool.name === "mobbin_search_sections"));
  assert.ok(tools.some((tool) => tool.name === "mobbin_get_saved"));
  assert.ok(tools.some((tool) => tool.name === "mobbin_search_visual_references"));
  assert.ok(tools.some((tool) => tool.name === "mobbin_get_visual_comparison"));
  assert.ok(
    (await client.listPrompts()).prompts.some(
      (prompt) => prompt.name === "mobbin_visual_reference_search",
    ),
  );
  assert.equal(
    (appScreens._meta?.ui as { resourceUri: string })?.resourceUri,
    "ui://mobbin-forge/gallery.html",
  );
  const gallery = await client.readResource({ uri: "ui://mobbin-forge/gallery.html" });
  assert.equal(gallery.contents[0].mimeType, "text/html;profile=mcp-app");
  console.log(
    `Discovered ${tools.length} MCP tools; gallery resource and complete screen listings available.`,
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 120_000,
    });
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
  const capabilities = await call("mobbin_get_capabilities", {});
  console.log(`Deep Search access: ${capabilities.structuredContent?.deepSearch}`);
  if (capabilities.structuredContent?.deepSearch === false) {
    const denied = await client.callTool({
      name: "mobbin_search_screens",
      arguments: { query: "login", mode: "deep", page_size: 1 },
    });
    assert.equal(denied.isError, true);
    assert.match(text(denied), /not enabled/);
    console.log("Deep Search account-access guard passed without running a Deep Search.");
  }
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
  const visualSource = await call("mobbin_prepare_visual_search", { image_base64: img.data });
  assert.equal(
    (visualSource.content as Array<{ type: string }>).filter((block) => block.type === "image")
      .length,
    1,
  );
  assert.equal((visualSource.structuredContent!.source as { kind: string }).kind, "inline_image");
  console.log("Native visual-search tools/prompt and real screenshot preparation passed.");
  // Local-only research writes use an isolated temporary directory, never the user's records.
  const project = (
    await call("mobbin_set_project_profile", {
      name: "Live research verification",
      audience: "Example users",
      goals: ["Verify evidence-backed research"],
    })
  ).structuredContent!.project as { id: string };
  const benchmark = (
    await call("mobbin_create_benchmark", {
      project_id: project.id,
      title: "Live image reference",
      question: "Can a live reference be retained?",
      criteria: [
        { key: "evidence", label: "Evidence", question: "Does the source remain linked?" },
      ],
    })
  ).structuredContent!.benchmark as { id: string };
  await call("mobbin_add_benchmark_reference", {
    benchmark_id: benchmark.id,
    expected_revision: 1,
    label: "Live screen",
    product: "Duolingo",
    platform: "ios",
    source_kind: "mobbin_screen",
    source_url: "https://mobbin.com",
    captured_by: "mobbin",
    steps: [{ label: "Screen", stage: "Unclassified", source_url: url, image_url: url }],
  });
  await call("mobbin_record_benchmark_finding", {
    benchmark_id: benchmark.id,
    expected_revision: 2,
    kind: "hypothesis",
    confidence: "low",
    text: "A product comparison needs additional references and actual visual inspection.",
  });
  const packet = await call("mobbin_get_benchmark", { benchmark_id: benchmark.id });
  assert.equal((packet.structuredContent!.active_findings as unknown[]).length, 1);
  assert.match(
    text(await call("mobbin_get_benchmark", { benchmark_id: benchmark.id, format: "markdown" })),
    /Duolingo/,
  );
  await call("mobbin_delete_research", {
    kind: "benchmarks",
    id: benchmark.id,
    expected_revision: 3,
  });
  await call("mobbin_delete_research", { kind: "projects", id: project.id, expected_revision: 1 });
  console.log(
    "Local project, live reference, research memory, comparison packet, export, and cleanup passed.",
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
    ["mobbin_search_screens", { query: "banking onboarding with a progress bar", page_size: 2 }],
    ["mobbin_search_flows", { query: "creating an account", page_size: 2 }],
    ["mobbin_search_sections", { query: "pricing", page_size: 2 }],
    ["mobbin_get_saved", { content_type: "sections", platform: "sites", page_size: 2 }],
    ["mobbin_get_saved", { content_type: "screens", platform: "mobile", page_size: 2 }],
    [
      "mobbin_get_comments",
      { content_type: "screens", content_id: "81b520ac-e864-4e64-bc18-f16caca3b124" },
    ],
  ] as const) {
    const result = await call(name, args);
    assert.ok(text(result).length > 0);
    if ("page_size" in args && args.page_size && result.structuredContent) {
      const rows = result.structuredContent.items ?? result.structuredContent.flows;
      if (Array.isArray(rows))
        assert.ok(rows.length <= args.page_size, `${name} exceeded requested page_size`);
    }
    if (
      (name === "mobbin_search_screens" || name === "mobbin_search_sections") &&
      "query" in args
    ) {
      assert.ok(
        (result.structuredContent!.items as unknown[]).length > 0,
        `${name} returned no results for the known query`,
      );
    }
    console.log(`${name}: passed`);
  }
} finally {
  try {
    await client.close();
  } finally {
    await rm(researchDirectory, { recursive: true, force: true });
  }
}
