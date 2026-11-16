# Local research workflows

These tools work for any product, industry, or research question. A project profile is optional. The existing coding agent conducts searches, inspects images/pages, and reasons about design; the MCP persists that work and constructs a sourced comparison packet. It does not need another LLM API key.

## Tools

| Tool | Purpose |
| --- | --- |
| `mobbin_set_project_profile` | Create a profile or replace it using `project_id` and `expected_revision`. Supply `name`, `audience`, `goals`, and optional `constraints`, `principles`, and `components`. |
| `mobbin_get_project_profile` | Read a profile and its current revision. |
| `mobbin_list_research` | List `projects` or `benchmarks`. Supports keyword `query`, benchmark `project_id` filter, `offset`, and `limit`. Returns compact summaries and `next_offset`. |
| `mobbin_create_benchmark` | Supply `title`, `question`, and `criteria` containing unique `key`, `label`, and `question` fields. Optional `project_id` snapshots its current profile. |
| `mobbin_add_benchmark_reference` | Attach one ordered reference using `benchmark_id`, `expected_revision`, `label`, `product`, `platform`, `source_kind`, `source_url`, `captured_by`, optional `captured_at`, and `steps`. Each step has `label`, `stage`, `source_url`, optional `image_url`, and optional `notes`. |
| `mobbin_record_benchmark_finding` | Append a finding using `benchmark_id`, `expected_revision`, `kind`, `text`, and `confidence`; optional fields include `criterion_key`, `step_ids`, `inspected_step_ids`, `decision`, `recommended_change`, `experiment`, and `supersedes`. |
| `mobbin_get_benchmark` | Return a `packet` (default) or `markdown`. Packet `include_history: true` includes superseded findings. |
| `mobbin_delete_research` | Explicitly delete one local record with `kind`, `id`, and its current `expected_revision`. |

Capture provenance values are `mobbin`, `playwright`, `agent-browser`, and `manual`. Platforms are `ios`, `android`, `web`, and `other`. Source kinds are `mobbin_screen`, `mobbin_flow`, `mobbin_section`, and `user_reference`. URLs must be HTTP(S), without embedded credentials. Tools store reference links; they do not fetch arbitrary URLs, upload local files, control a browser, or copy cookies.

Findings have a `kind` of `observation`, `interpretation`, `hypothesis`, or `preference`; confidence is `low`, `medium`, or `high`. Decisions are `undecided`, `adopt`, or `reject`. An optional `experiment` contains `hypothesis`, `primary_metric`, and `guardrail_metric`; it describes a proposed test and does not launch one.

## Example workflow

1. Ask the user for their actual product context if a tailored recommendation needs it. Save an optional project profile. Do not assume a particular app or audience.
2. Create a benchmark with explicit criteria, for example `clarity` and `required_effort`.
3. Use existing Mobbin search and flow tools to find relevant references. Inspect their source pages or full images. Existing tools remain available unchanged.
4. Add each reference with its steps in their actual order. Reuse stage labels such as `introduction`, `account_creation`, and `permissions` for equivalent stages. Stage matching is case-insensitive and trims surrounding spaces. It does not infer semantic equivalence or reorder the original flow.
5. Use returned step IDs as citations. Observations and interpretations require cited steps belonging to the same benchmark. For an observation, every cited step must also appear in `inspected_step_ids`. This is an agent-reported inspection claim, not a claim that the server verified the image.
6. Record recommendations as interpretations/hypotheses rather than established outcomes. Save preferences and rejected approaches so they can be found later.
7. Retrieve a comparison packet. It contains the profile snapshot, reference sequences, active findings, stage coverage, and criterion-to-finding links. Matrices point to IDs to avoid repeating full images and findings throughout the response.
8. Ask the agent to explain the evidence and draft a small implementation brief using the project's existing components. Request `format: "markdown"` for a portable brief; the tool returns text without writing an arbitrary output file.

Each successful write returns the new revision. Use that value for the next write. Conflicting edits fail; read the record and reconcile before retrying. After an uncertain write, inspect the record rather than blindly repeating it.

To correct a finding, append a replacement with `supersedes` set to the current finding's ID. The old finding remains in history and is excluded from active comparisons. Deleting a project profile leaves existing benchmark profile snapshots intact.

## Personal storage and distribution

Default research location: `~/.mobbin-mcp/research`. No project is preconfigured. Each OS user's installation uses their own directory. You can distribute this MCP to many users; each installation retains its own local research and Mobbin session.

For separate local workspaces, set an absolute `MOBBIN_RESEARCH_DIR` in each MCP process configuration:

```toml
[mcp_servers.mobbin]
command = "node"
args = ["/absolute/path/to/mobbin-forge/dist/index.js"]
env = { MOBBIN_RESEARCH_DIR = "/absolute/path/to/private/research" }
tool_timeout_sec = 120
```

The directory applies to the whole process. Choosing a project ID does not establish an authorization boundary. Two processes deliberately pointed at the same directory can read its records. This release is a local stdio MCP, not an authenticated shared HTTP service. A future hosted service must resolve storage and Mobbin sessions from an authenticated principal on the server; accepting a caller-supplied tenant/project ID is insufficient.

Records use JSON files, private file modes, atomic replacement, revision checks, and cross-process lock directories. A stopped process can leave a `.json.lock` directory. Only remove it locally after confirming no process still owns the write. Invalid/corrupt records raise an error rather than being silently overwritten or omitted. The store is designed for modest personal research libraries, not a large shared database.

Record limits: 2 MiB per record, 12 criteria, 20 references per benchmark, 30 ordered steps per reference, and 300 findings. Listing is paginated; keyword search requires every whitespace-separated term and includes historical findings. It is lexical search, not semantic/vector search. Review links before sharing exported research; account-specific links may not work for another reader.

## Verification and remaining work

`npm test` covers persistence after reopening the store/server, separate research directories, optimistic concurrency, lock contention, citations, inspection attestations, history, stage coverage, exports, corrupt records, and all eight research tools through MCP.

`npm run test:live` additionally attaches a real Mobbin image reference to temporary local research and removes those records afterward. Existing signed-in read/search/image checks remain in the same script. It does not post comments or create Mobbin collections.

Version 1.6 adds [native agent-driven screenshot comparisons](visual-search.md). An independent visual index, automatic capture, semantic research search, competitor version monitoring, hosted multi-tenant authentication, and analytics integrations remain future work. A useful evaluation set should measure reference relevance, citation accuracy, unknown-stage handling, time to a useful brief, and accepted recommendations—not just successful tool calls.
