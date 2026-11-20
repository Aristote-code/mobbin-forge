import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResearchStore } from "../src/research/store.js";
import { benchmarkMarkdown, comparisonPacket } from "../src/research/report.js";
import { createLocalServer } from "../src/index.js";
import type { MobbinApiClient } from "../src/services/api-client.js";

const profile = {
  name: "Example product",
  audience: "New customers",
  goals: ["Reach a useful first action"],
  constraints: ["Use existing components"],
  components: ["PrimaryButton"],
};
const brief = {
  title: "Compare sign-up",
  question: "When should account creation appear?",
  criteria: [
    { key: "friction", label: "Friction", question: "How many required actions are shown?" },
  ],
};
const reference = {
  label: "First session",
  product: "Example A",
  platform: "web" as const,
  source_kind: "user_reference" as const,
  source_url: "https://example.com/flow",
  captured_by: "agent-browser" as const,
  steps: [
    {
      label: "Welcome",
      stage: "Introduction",
      source_url: "https://example.com/welcome",
      image_url: "https://example.com/welcome.png",
    },
  ],
};

async function temporary(t: { after: (callback: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), "mobbin-research-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("research persists across restarts, snapshots project context, and stays separated by directory", async (t) => {
  const directory = await temporary(t);
  const store = new ResearchStore(path.join(directory, "alice"));
  const p = await store.setProject(profile);
  const b = await store.createBenchmark({ ...brief, project_id: p.id });
  const other = new ResearchStore(path.join(directory, "bob"));
  assert.deepEqual((await other.list("benchmarks")).items, []);
  await assert.rejects(other.get("benchmarks", b.id), /not found/);
  await store.setProject({ ...profile, name: "Renamed" }, p.id, 1);
  const reopened = await new ResearchStore(path.join(directory, "alice")).get("benchmarks", b.id);
  assert.equal(reopened.project_snapshot!.name, "Example product");
  assert.equal(reopened.project_snapshot!.revision, 1);
  assert.equal((await store.get("projects", p.id)).revision, 2);
  if (process.platform !== "win32")
    assert.equal(
      (await stat(path.join(store.directory, "benchmarks", `${b.id}.json`))).mode & 0o777,
      0o600,
    );
});

test("research rejects stale and concurrent edits instead of losing data", async (t) => {
  const directory = await temporary(t);
  const store = new ResearchStore(directory);
  const b = await store.createBenchmark(brief);
  const outcomes = await Promise.allSettled([
    store.addReference(b.id, 1, reference),
    new ResearchStore(directory).addReference(b.id, 1, { ...reference, product: "Example B" }),
  ]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(
    String((outcomes.find((r) => r.status === "rejected") as PromiseRejectedResult).reason),
    /busy|Revision conflict/,
  );
  assert.equal((await store.get("benchmarks", b.id)).references.length, 1);
  await assert.rejects(store.addReference(b.id, 1, reference), /Revision conflict/);
  await assert.rejects(store.remove("benchmarks", b.id, 1), /Revision conflict/);
});

test("findings enforce evidence ownership, inspection claims, criteria, and preserved revision history", async (t) => {
  const store = new ResearchStore(await temporary(t));
  let b = await store.createBenchmark(brief);
  b = await store.addReference(b.id, b.revision, reference);
  const step = b.references[0].steps[0].id;
  const observation = {
    kind: "observation" as const,
    text: "The welcome step has one primary action.",
    criterion_key: "friction",
    confidence: "high" as const,
    step_ids: [step],
    inspected_step_ids: [step],
  };
  await assert.rejects(
    store.addFinding(b.id, b.revision, { ...observation, step_ids: [] }),
    /Inspected steps|require cited/,
  );
  await assert.rejects(
    store.addFinding(b.id, b.revision, { ...observation, inspected_step_ids: [] }),
    /inspected/,
  );
  await assert.rejects(
    store.addFinding(b.id, b.revision, { ...observation, criterion_key: "unknown" }),
    /Unknown benchmark criterion/,
  );
  const other = await store.createBenchmark(brief);
  await assert.rejects(store.addFinding(other.id, 1, observation), /does not belong/);
  b = await store.addFinding(b.id, b.revision, observation);
  const original = b.findings[0].id;
  b = await store.addFinding(b.id, b.revision, {
    ...observation,
    supersedes: original,
    text: "Corrected reading",
    decision: "reject",
  });
  assert.equal(b.findings.length, 2);
  assert.equal(comparisonPacket(b, true).finding_history!.length, 2);
  assert.equal(comparisonPacket(b).finding_history, undefined);
  assert.deepEqual(
    comparisonPacket(b).active_findings.map((f) => f.text),
    ["Corrected reading"],
  );
  await assert.rejects(
    store.addFinding(b.id, b.revision, { ...observation, supersedes: original }),
    /already superseded/,
  );
  assert.equal((await store.list("benchmarks", "corrected reject")).items.length, 1);
  b = await store.addFinding(b.id, b.revision, {
    kind: "hypothesis",
    text: "A deferred sign-up might help activation.",
    confidence: "low",
    experiment: {
      hypothesis: "Deferring sign-up improves first action completion.",
      primary_metric: "First action completion",
      guardrail_metric: "Account recovery failure",
    },
  });
  assert.equal(b.findings.at(-1)!.step_ids.length, 0);
});

test("comparison packets preserve ordered flows, unknown coverage, citations and portable Markdown", async (t) => {
  const store = new ResearchStore(await temporary(t));
  let b = await store.createBenchmark(brief);
  b = await store.addReference(b.id, b.revision, reference);
  b = await store.addReference(b.id, b.revision, {
    ...reference,
    product: "Example B",
    captured_by: "playwright",
    steps: [
      { label: "Create account", stage: "Account", source_url: "https://example.org/signup" },
      {
        label: "Welcome second",
        stage: " introduction ",
        source_url: "https://example.org/welcome",
      },
    ],
  });
  const packet = comparisonPacket(b);
  assert.equal(packet.stage_matrix.length, 2);
  assert.equal(packet.stage_matrix[0].references[1].step_ids[0], b.references[1].steps[1].id);
  assert.equal(packet.stage_matrix[1].references[0].coverage, "not_provided");
  assert.equal(packet.benchmark.references[1].steps[0].label, "Create account");
  const step = b.references[0].steps[0].id;
  b = await store.addFinding(b.id, b.revision, {
    kind: "interpretation",
    confidence: "medium",
    text: "A visible action may clarify the next step.",
    step_ids: [step],
    criterion_key: "friction",
    recommended_change: "Reuse PrimaryButton.",
    experiment: {
      hypothesis: "A clearer action increases completion.",
      primary_metric: "Completion",
      guardrail_metric: "Error rate",
    },
  });
  assert.equal(comparisonPacket(b).criteria_matrix[0].references[0].finding_ids.length, 1);
  const markdown = benchmarkMarkdown(b);
  for (const expected of [
    "Not provided",
    "https://example.com/welcome",
    "Reuse PrimaryButton",
    "Error rate",
    "do not establish conversion",
    "agent-supplied",
  ])
    assert.ok(markdown.includes(expected), expected);
  await store.remove("benchmarks", b.id, b.revision);
  await assert.rejects(store.get("benchmarks", b.id), /not found/);
});

test("invalid identifiers, duplicate criteria, unsafe links and corrupt files fail without overwriting research", async (t) => {
  const directory = await temporary(t),
    store = new ResearchStore(directory);
  await assert.rejects(store.get("benchmarks", "../../auth"));
  await assert.rejects(
    store.createBenchmark({ ...brief, criteria: [brief.criteria[0], brief.criteria[0]] }),
    /unique/,
  );
  const b = await store.createBenchmark(brief);
  await assert.rejects(
    store.addReference(b.id, 1, { ...reference, source_url: "javascript:alert(1)" }),
  );
  await assert.rejects(
    store.addReference(b.id, 1, { ...reference, source_url: "https://user:secret@example.com" }),
  );
  const filename = path.join(directory, "benchmarks", `${b.id}.json`);
  await writeFile(filename, "{invalid");
  await assert.rejects(store.addReference(b.id, 1, reference));
  assert.equal(await readFile(filename, "utf8"), "{invalid");
  await assert.rejects(store.list("benchmarks"));
  await mkdir(filename + ".lock");
  await assert.rejects(store.remove("benchmarks", b.id, 1), /busy/);
});

test("all eight research tools work through MCP and survive a fresh server/store instance without browser or AI API calls", async (t) => {
  const directory = await temporary(t);
  const connect = async () => {
    const server = await createLocalServer({} as MobbinApiClient, new ResearchStore(directory));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "research-test", version: "1" });
    await client.connect(a);
    return { server, client };
  };
  let connection = await connect();
  t.after(async () => {
    await connection.client.close();
    await connection.server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await connection.client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return result;
  };
  const tools = (await connection.client.listTools()).tools;
  assert.equal(tools.filter((t) => /research|benchmark|project_profile/.test(t.name)).length, 8);
  const p = (await call("mobbin_set_project_profile", profile)).structuredContent!.project as {
    id: string;
  };
  await call("mobbin_get_project_profile", { project_id: p.id });
  const b = (await call("mobbin_create_benchmark", { ...brief, project_id: p.id }))
    .structuredContent!.benchmark as { id: string };
  const ref = (
    await call("mobbin_add_benchmark_reference", {
      ...reference,
      benchmark_id: b.id,
      expected_revision: 1,
    })
  ).structuredContent!.reference as { steps: Array<{ id: string }> };
  await call("mobbin_record_benchmark_finding", {
    benchmark_id: b.id,
    expected_revision: 2,
    kind: "observation",
    text: "One primary action is visible.",
    confidence: "high",
    step_ids: [ref.steps[0].id],
    inspected_step_ids: [ref.steps[0].id],
  });
  await connection.client.close();
  await connection.server.close();
  connection = await connect();
  const packet = (await call("mobbin_get_benchmark", { benchmark_id: b.id })).structuredContent!;
  assert.equal((packet.active_findings as unknown[]).length, 1);
  const markdown = await call("mobbin_get_benchmark", { benchmark_id: b.id, format: "markdown" });
  assert.match(JSON.stringify(markdown.content), /One primary action/);
  const found = (await call("mobbin_list_research", { query: "primary action" }))
    .structuredContent!;
  assert.equal((found.items as unknown[]).length, 1);
  const bad = await connection.client.callTool({
    name: "mobbin_add_benchmark_reference",
    arguments: { ...reference, benchmark_id: b.id, expected_revision: 1 },
  });
  assert.equal(bad.isError, true);
  await call("mobbin_delete_research", { kind: "projects", id: p.id, expected_revision: 1 });
  assert.ok(
    (
      (await call("mobbin_get_benchmark", { benchmark_id: b.id })).structuredContent!.benchmark as {
        project_snapshot: unknown;
      }
    ).project_snapshot,
  );
  await call("mobbin_delete_research", { kind: "benchmarks", id: b.id, expected_revision: 3 });
});
