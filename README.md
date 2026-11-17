# mobbin-forge

[![npm version](https://img.shields.io/npm/v/mobbin-mcp.svg?color=F5A623)](https://www.npmjs.com/package/mobbin-mcp)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-working-F5A623.svg)](https://github.com/Aristote-code/mobbin-forge)

> The original mobbin-mcp is **archived and broken**. This fork fixes it.

An MCP server that works with [Mobbin](https://mobbin.com) — search screens, browse flows, inspect images, and retain benchmarking research without leaving Codex or another MCP client. Mobbin also offers an [official API and MCP](https://docs.mobbin.com/mcp/introduction). This independent server uses authenticated website routes instead.

The local build includes the image-resolution fix from `ScreenClear-for-Mobbin-1.1.1`. Encrypted CDN previews are resolved to their original screenshot paths before download. Discovery preserves the opaque `enc` parameter, validates the returned screenshot path, and falls back to the supplied URL if lookup or download fails. Tiny placeholders are reported as errors rather than returned as screenshots.

## Local vector search in 1.7

Build an authorized 1,000-screen pilot with real local image/text embeddings and preserved flow records. A pinned CLIP model runs on your CPU; SQLite stores images, region vectors, keyword text, and flow links. No paid AI API or database service is needed.

The bundled downloader samples the publisher-licensed **Uni-GUI-OpenMobile** dataset, preserves complete provided trajectories and attribution, and deduplicates repeated screenshot files. It does not crawl Mobbin. Model setup and dataset downloads need internet; normal local inference uses cached files with network fetches disabled in the worker.

```bash
npm install --include=optional
npm run build
node dist/index.js library setup
npm run pilot:download
node dist/index.js library import "$HOME/.mobbin-mcp/pilot/openmobile/manifest.json"
node dist/index.js library search calendar create event
```

Use `node dist/index.js library serve` as a standalone MCP without Mobbin authentication, or use the four local-library tools alongside the existing Mobbin tools. [Setup, manifest format, source licensing, limits, and validation](docs/local-library.md).

## Screenshot references in 1.6

Give your coding agent a screenshot and ask: **“Find real screens like this. Prioritize the layout and components, inspect the candidate images, and explain the closest references.”**

Three new MCP tools organize a native-vision workflow: prepare the screenshot, retrieve candidates from a visual brief, and return labeled comparison images. Claude, Codex, or another image-capable agent performs the visual analysis; this MCP does not call another AI provider. No additional AI API key is required, although normal agent usage and Mobbin account limits still apply.

Screenshots already attached to a conversation can stay there. Local-file and inline-image inputs are also supported. The `mobbin_visual_reference_search` MCP prompt describes the workflow for clients that expose prompts.

This retrieves candidates with standard text search and then lets the agent compare their images. It is not an independent visual index of the entire Mobbin catalog. Retrieval order is not a similarity score, and image failures remain explicit. See [native visual search](docs/visual-search.md) for inputs, limits, and verification.

## Research workflows in 1.5

Benchmark any product or a general design question directly from your MCP client. No separate website, browser package, or additional AI API key is required. The MCP stores evidence and builds comparison packets; your existing coding agent inspects references and writes the analysis.

- Save optional project profiles with an audience, goals, constraints, principles, and existing component names.
- Retain ordered flows and source/image links from Mobbin, Playwright, Agent Browser, or manual research.
- Align steps by explicit stage labels and compare findings against user-defined criteria.
- Preserve cited observations, interpretations, hypotheses, preferences, adoption/rejection decisions, and proposed experiments.
- Find prior research with keyword search and return a structured packet or an exportable Markdown brief.

Example: “Compare three onboarding flows against clarity and required effort. Save the source references, record what you actually inspected, and prepare a brief with a proposed change and a hypothesis to test.”

References and capture metadata are supplied by the calling agent. Inspection is an agent attestation, not independent server verification. The server does not infer absent screens, calculate UX quality scores, prove conversion improvements, run experiments, or autonomously conduct research. Missing stages mean **not provided**. A catalog-wide visual index and competitor change monitoring remain future work.

See [research tool inputs and workflow](docs/research-workflows.md) and [Agent Browser versus Playwright](docs/browser-tooling.md).

## Independent 1.4 upgrade

This server does not connect to Mobbin's official MCP or OAuth service. It keeps the existing website-session authentication and respects the responses and account permissions enforced by Mobbin.

| Feature | Implementation | Verification |
| --- | --- | --- |
| Interactive screen gallery | Optional MCP Apps resource; text and inline images also work directly in Codex | Browser checks using cached references; live MCP resource/image checks |
| Free-text screen and flow search | `query` on the existing search tools, using the website's standard search | Signed-in stdio MCP checks passed on 2026-11-16 |
| Website sections | `mobbin_search_sections`, with queries, filters, images, and metadata | Signed-in search and full-resolution image download verified |
| All saved | `mobbin_get_saved`; mobile apps, web apps, and website sections (`sites` bucket) | Signed-in empty and populated saved-item checks passed |
| Collections | `mobbin_create_collection`, `mobbin_save_content`, and collection readback | Private temporary collection created, populated, read back, and removed; original saved items preserved |
| Comments | `mobbin_get_comments` and `mobbin_add_comment` with plain text/reply support | Reading verified live; posting serialization and action discovery checked without posting a test message |
| Deep Search | Explicit `mode: "deep"` on screen search, using the website backend and account permissions | Account-access guard tested; the verification session reports Deep Search disabled, so the search itself was not run |
| Agent workflow guidance | Server initialization instructions describe discovery, image inspection, pagination, and account writes | Included directly in the MCP connection; no separate site or plugin installation required |

This is an independent MCP server, not a copy of Mobbin's private search engine. Deep Search requires access in the signed-in Mobbin workspace and may consume its AI credits. `mobbin_get_capabilities` reads account feature flags without running a search. Unknown access is reported as unknown, not granted.

Search endpoints return fixed native batches. The server caches a search session briefly and translates `page_size`/`page_index` across those batches, preserving rows at page boundaries. Advertised catalog totals can exceed the rows the website actually returns; paging stops when the next native batch is empty. Echo `search_request_id` from the previous response for stable continuation. Website routes and server actions can change. Writes are not retried automatically after an uncertain response: check the account before retrying.

Posting comments is an account-changing action and can notify workspace collaborators. The MCP only posts when explicitly requested with the user's supplied text. No test comments were posted during verification.

MCP Apps hosts can render the gallery inside a conversation. Other clients still receive text and inline images. Gallery resources are bundled locally; no external JavaScript CDN is required.

The image tools also retain the app-by-app screen listing, Android taxonomy filters, full-size image resolution, and dominant-color extraction from the earlier version.

## Screens and images

- `mobbin_quick_search` finds an app by name.
- `mobbin_get_app_screens` lists all of its screens, including restricted previews by default. Use `page_size` (up to 50) and zero-based `page_index` to browse every page. Set `include_restricted: false` to filter them out.
- `mobbin_get_screen_detail` takes a returned **Screen URL** and returns the full image, resolved URL, actual dimensions, and optional dominant colors.
- Flow steps retain their screenshot URLs, including restricted previews.

The `restricted` flag describes Mobbin's preview; it does not establish whether the public original can be downloaded. Resolution depends on the current CDN behavior, so some images can still fail. This server uses Mobbin's internal routes, which can change.

## Setup

### Prerequisites

- Node.js 22.13+
- A [Mobbin](https://mobbin.com) account (free works)

### 1. Install & build

```bash
git clone https://github.com/Aristote-code/mobbin-forge.git
cd mobbin-forge
npm install
npm run build
```

### 2. Authenticate

```bash
node /absolute/path/to/mobbin-forge/dist/index.js auth
```

Follow prompts: open [mobbin.com](https://mobbin.com), log in, run `copy(document.cookie)` in browser console, paste into CLI. Session saved to `~/.mobbin-mcp/auth.json` (chmod 600), auto-refreshed. For env-var auth, see `CONTRIBUTING.md`.

### 3. Use this local build

Point your MCP client at this folder's compiled server so it uses these fixes.

Replace `/absolute/path/to/mobbin-forge` below with your checkout location.

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.mobbin]
command = "node"
args = ["/absolute/path/to/mobbin-forge/dist/index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

Adjust the Node executable and project path on another machine.

**Claude Code**:

```bash
claude mcp add mobbin -- node /absolute/path/to/mobbin-forge/dist/index.js
```

**Other MCP clients**:

```json
{
  "mcpServers": {
    "mobbin": {
      "command": "node",
      "args": ["/absolute/path/to/mobbin-forge/dist/index.js"]
    }
  }
}
```

Restart your MCP client after configuration changes or this upgrade so it refreshes tool metadata and gallery resources. Rebuild with `npm run build` after editing source files.

## Verification

```bash
npm test
npm run build
npm run lint
npm run format:check
npm run test:live
```

`test:live` is an opt-in network check using your stored Mobbin session. A fresh cookie is required; authentication validates the session before saving it. It exercises the stdio MCP connection, app lookup, first and last screen pages, full-size image responses, colors, flows, search, popular apps, collections listing, filters, website sections, saved items, comment reads, and account-capability reporting. If Deep Search is unavailable, it verifies the denial without running a paid/credit-consuming search. It also creates and removes isolated temporary local research records using a live image reference. It does not post comments, create Mobbin collections, or download every screenshot in the catalog.

## Gallery preview

```bash
npm run preview:gallery
```

This developer preview binds only to `127.0.0.1:43190` and uses the real local MCP. It requires a valid website session. Its browser endpoint allows only read-only gallery calls.

For UI checks using the three Duolingo images previously downloaded into this checkout:

```bash
npm run preview:gallery -- --cached
```

Cached mode is labeled clearly and does not demonstrate current signed-in search or write behavior. The downloaded images and browser artifacts stay in ignored `output/` folders.

## Example prompts

- "Show me how DoorDash and Uber Eats handle checkout flows"
- "Pull up Duolingo's onboarding and walk me through the design decisions"
- "Find login screens using bottom sheets and extract color palettes"
- "Search for banking onboarding with a progress bar and show a gallery"
- "Find website pricing sections with a monthly/yearly toggle"
- "Show all my saved website sections"
- "Create a private collection named Checkout references"

## How it works

Calls Mobbin's internal API routes using your session cookie. Tokens auto-refresh via Supabase and persist to `~/.mobbin-mcp/auth.json`. **getAppScreens** resolves the target app's real version, then parses its structured Next.js RSC data chunk — screens, patterns, elements, and dimensions — before downloading images through Bytescale. Optional color extraction uses [sharp](https://sharp.pixelplumbing.com/).

## Credits

Based on [Jelil-ah/mobbin-forge](https://github.com/Jelil-ah/mobbin-forge), forked from [pdcolandrea/mobbin-mcp](https://github.com/pdcolandrea/mobbin-mcp). Respect to the original — pioneered reverse-engineering Mobbin's API. This fork exists because upstream is archived and the API changed.

## License

ISC
