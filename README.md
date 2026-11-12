# mobbin-forge

[![npm version](https://img.shields.io/npm/v/mobbin-mcp.svg?color=F5A623)](https://www.npmjs.com/package/mobbin-mcp)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-working-F5A623.svg)](https://github.com/Aristote-code/mobbin-forge)

> The original mobbin-mcp is **archived and broken**. This fork fixes it.

An MCP server that works with [Mobbin](https://mobbin.com) — 600k+ real app screens and flows from 1,100+ apps. Search screens, browse flows, grab palettes, build better UI without leaving Claude. Mobbin has no public API. This server reverse-engineers their internal endpoints.

The local build includes the image-resolution fix from `ScreenClear-for-Mobbin-1.1.1`. Encrypted CDN previews are resolved to their original screenshot paths before download. Discovery preserves the opaque `enc` parameter, validates the returned screenshot path, and falls back to the supplied URL if lookup or download fails. Tiny placeholders are reported as errors rather than returned as screenshots.

## Screens and images

- `mobbin_quick_search` finds an app by name.
- `mobbin_get_app_screens` lists all of its screens, including restricted previews by default. Use `page_size` (up to 50) and zero-based `page_index` to browse every page. Set `include_restricted: false` to filter them out.
- `mobbin_get_screen_detail` takes a returned **Screen URL** and returns the full image, resolved URL, actual dimensions, and optional dominant colors.
- Flow steps retain their screenshot URLs, including restricted previews.

The `restricted` flag describes Mobbin's preview; it does not establish whether the public original can be downloaded. Resolution depends on the current CDN behavior, so some images can still fail. This server uses Mobbin's internal routes, which can change.

## Setup

### Prerequisites

- Node.js 18+
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

Restart your MCP client after configuration changes. Rebuild with `npm run build` after editing source files.

## Verification

```bash
npm test
npm run build
npm run lint
npm run format:check
npm run test:live
```

`test:live` is an opt-in network check using your stored Mobbin session. It exercises the stdio MCP connection, app lookup, first and last screen pages, full-size image responses, colors, flows, search, popular apps, collections listing, and filters. It does not download every screenshot in the catalog.

## Example prompts

- "Show me how DoorDash and Uber Eats handle checkout flows"
- "Pull up Duolingo's onboarding and walk me through the design decisions"
- "Find login screens using bottom sheets and extract color palettes"

## How it works

Calls Mobbin's internal API routes using your session cookie. Tokens auto-refresh via Supabase and persist to `~/.mobbin-mcp/auth.json`. **getAppScreens** resolves the target app's real version, then parses its structured Next.js RSC data chunk — screens, patterns, elements, and dimensions — before downloading images through Bytescale. Optional color extraction uses [sharp](https://sharp.pixelplumbing.com/).

## Credits

Based on [Jelil-ah/mobbin-forge](https://github.com/Jelil-ah/mobbin-forge), forked from [pdcolandrea/mobbin-mcp](https://github.com/pdcolandrea/mobbin-mcp). Respect to the original — pioneered reverse-engineering Mobbin's API. This fork exists because upstream is archived and the API changed.

## License

ISC
