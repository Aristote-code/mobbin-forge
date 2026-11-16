import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  benchmarkInput,
  findingInput,
  projectInput,
  recordId,
  referenceInput,
  revision,
} from "./schemas.js";
import { ResearchStore } from "./store.js";
import { benchmarkMarkdown, comparisonPacket } from "./report.js";

const readOnly = { readOnlyHint: true, openWorldHint: false };
const write = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: false,
};
const result = (value: Record<string, unknown>, message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  structuredContent: value,
});
async function guarded(action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : "Research operation failed.",
        },
      ],
    };
  }
}

/** Research stays local and browser-neutral. Analysis is performed by the MCP host's agent. */
export function registerResearchTools(server: McpServer, store: ResearchStore) {
  server.registerTool(
    "mobbin_set_project_profile",
    {
      description:
        "Create or replace a local project profile for any user's product: audience, goals, constraints, principles, and component names. Optional for benchmarking. To update, supply project_id and its current expected_revision. Does not change Mobbin account data.",
      inputSchema: projectInput.extend({
        project_id: recordId.optional(),
        expected_revision: revision.optional(),
      }).shape,
      annotations: write,
    },
    (args) =>
      guarded(async () => {
        const project = await store.setProject(args, args.project_id, args.expected_revision);
        return result(
          { project },
          `Saved local project ${project.name}. ID ${project.id}; revision ${project.revision}.`,
        );
      }),
  );

  server.registerTool(
    "mobbin_list_research",
    {
      description:
        "Find local projects or benchmark research, including saved decisions and rejected approaches. Keyword search requires every whitespace-separated term; it is not semantic search. Lists compact summaries; read records by ID. Data belongs to the configured local user's research directory.",
      inputSchema: {
        kind: z.enum(["projects", "benchmarks"]).default("benchmarks"),
        query: z.string().max(300).default(""),
        project_id: recordId.optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: readOnly,
    },
    (args) =>
      guarded(async () => {
        if (args.kind === "projects" && args.project_id)
          throw Error("project_id filtering applies only to benchmarks.");
        const records = await store.list(
          args.kind,
          args.query,
          args.project_id,
          args.offset,
          args.limit,
        );
        return result(records, JSON.stringify(records));
      }),
  );

  server.registerTool(
    "mobbin_get_project_profile",
    {
      description:
        "Read a local project profile and current revision before updating it or using its goals and constraints in research.",
      inputSchema: { project_id: recordId },
      annotations: readOnly,
    },
    (args) =>
      guarded(async () => {
        const project = await store.get("projects", args.project_id);
        return result({ project }, JSON.stringify(project));
      }),
  );

  server.registerTool(
    "mobbin_create_benchmark",
    {
      description:
        "Start persistent local UI/UX research for any product or a general design question. Supply explicit evaluation criteria with unique keys. Optionally snapshots a project profile so later profile edits do not rewrite past research. Use existing search tools to find references, then add them with mobbin_add_benchmark_reference.",
      inputSchema: benchmarkInput.shape,
      annotations: write,
    },
    (args) =>
      guarded(async () => {
        const benchmark = await store.createBenchmark(args);
        return result(
          { benchmark },
          `Created benchmark ${benchmark.id}; revision ${benchmark.revision}. Add references from search results or the user's own captures.`,
        );
      }),
  );

  server.registerTool(
    "mobbin_add_benchmark_reference",
    {
      description:
        "Attach an ordered flow or screen/section reference to local benchmark research. Accepts links from Mobbin, Playwright, Agent Browser, or manual research. Reuse stage labels to align equivalent steps. URLs and capture metadata are agent-supplied, not independently verified. This tool does not browse, fetch external URLs, or inspect images. Read the source/image first before claiming an observation. Returns generated reference/step IDs for citations.",
      inputSchema: referenceInput.extend({ benchmark_id: recordId, expected_revision: revision })
        .shape,
      annotations: write,
    },
    (args) =>
      guarded(async () => {
        const benchmark = await store.addReference(args.benchmark_id, args.expected_revision, args);
        return result(
          {
            benchmark_id: benchmark.id,
            revision: benchmark.revision,
            reference: benchmark.references.at(-1)!,
          },
          `Reference saved. Benchmark revision ${benchmark.revision}. Use the returned step IDs when recording findings.`,
        );
      }),
  );

  server.registerTool(
    "mobbin_record_benchmark_finding",
    {
      description:
        "Persist an agent-authored observation, interpretation, hypothesis, or preference with cited step IDs, confidence, adoption/rejection decision, optional proposed change, and experiment metrics. Observations require the agent to report an inspected cited step. This is an attestation, not server verification. Screenshots do not prove conversion or retention. To revise a finding, cite its ID in supersedes; history remains available. Does not post comments to Mobbin.",
      inputSchema: findingInput.extend({ benchmark_id: recordId, expected_revision: revision })
        .shape,
      annotations: write,
    },
    (args) =>
      guarded(async () => {
        const benchmark = await store.addFinding(args.benchmark_id, args.expected_revision, args);
        return result(
          {
            benchmark_id: benchmark.id,
            revision: benchmark.revision,
            finding: benchmark.findings.at(-1)!,
          },
          `Finding saved. Benchmark revision ${benchmark.revision}.`,
        );
      }),
  );

  server.registerTool(
    "mobbin_get_benchmark",
    {
      description:
        "Read persistent research as a structured comparison packet or an exportable Markdown brief. Aligns ordered steps by supplied stage labels; includes criteria, source citations, project snapshot, decisions, and experiment hypotheses. Missing coverage means not provided, not absent from the product. The server does not invent comparisons, score UX, or call another AI model. Use the host agent to inspect evidence and make recommendations.",
      inputSchema: {
        benchmark_id: recordId,
        format: z.enum(["packet", "markdown"]).default("packet"),
        include_history: z
          .boolean()
          .default(false)
          .describe(
            "Include superseded findings in packet output. Active findings are always returned.",
          ),
      },
      annotations: readOnly,
    },
    (args) =>
      guarded(async () => {
        const benchmark = await store.get("benchmarks", args.benchmark_id);
        if (args.format === "markdown")
          return {
            content: [{ type: "text", text: benchmarkMarkdown(benchmark) }],
            structuredContent: {
              benchmark_id: benchmark.id,
              revision: benchmark.revision,
              format: "markdown",
            },
          };
        return result(
          comparisonPacket(benchmark, args.include_history),
          `Research packet for ${benchmark.title}, revision ${benchmark.revision}. Structured content includes the project, ordered evidence, stage/criteria matrices, and active findings. Inspect sources before forming conclusions.`,
        );
      }),
  );

  server.registerTool(
    "mobbin_delete_research",
    {
      description:
        "Permanently delete one local project profile or benchmark when explicitly requested. Requires its current revision. Deleting a project leaves existing benchmark snapshots intact. Does not delete Mobbin collections or saved items.",
      inputSchema: {
        kind: z.enum(["projects", "benchmarks"]),
        id: recordId,
        expected_revision: revision,
      },
      annotations: { ...write, destructiveHint: true },
    },
    (args) =>
      guarded(async () => {
        return result(
          await store.remove(args.kind, args.id, args.expected_revision),
          "Local research record deleted.",
        );
      }),
  );
}
