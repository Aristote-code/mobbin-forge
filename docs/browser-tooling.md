# Browser tooling decision

Reviewed on 2026-11-17. The likely tool mentioned as Vercel's alternative to Playwright is **Agent Browser** (`vercel-labs/agent-browser`). This identification is an inference; another product may have been intended.

## What the primary sources establish

| Question | Agent Browser | Playwright |
| --- | --- | --- |
| License/local software cost | Apache-2.0, open source; local CLI use has no software subscription requirement | Apache-2.0, open source; local framework/CLI use has no software subscription requirement |
| Primary workflow | Agent-oriented shell commands with compact snapshots, element references, and persistent sessions | Test framework/library, plus an agent-oriented CLI and a separate MCP server |
| Current implementation | Native Rust CLI; the previous Node/Playwright daemon has been removed | Browser automation framework with Chromium, Firefox, and WebKit support |
| Useful strengths here | Agent-driven exploration and capture; isolated sessions; snapshot and screenshot diff tools | Repeatable assertions, browser testing, isolation, traces, and existing verification workflow |
| Evidence of universal superiority | Not established by the documentation or our smoke test | Not established by the documentation or our smoke test |

Browser hosting, remote providers, model calls, and the user's own compute can still have costs. Free local software does not mean every associated cloud service is free.

Sources:

- [Agent Browser repository and license](https://github.com/vercel-labs/agent-browser)
- [Current native architecture](https://agent-browser.dev/native-mode)
- [Isolated sessions](https://agent-browser.dev/sessions)
- [Agent Browser changelog](https://agent-browser.dev/changelog)
- [Playwright framework and browser support](https://playwright.dev/docs/intro)
- [Playwright license](https://github.com/microsoft/playwright/blob/main/LICENSE)
- [Playwright CLI](https://github.com/microsoft/playwright-cli)
- [Playwright MCP versus CLI guidance](https://github.com/microsoft/playwright-mcp#playwright-mcp-vs-playwright-cli)

Comparisons against verbose Playwright MCP outputs do not automatically establish an advantage over Playwright's CLI. Both now provide agent-oriented command-line workflows. Documentation and release activity establish capabilities and current maintenance; they cannot guarantee future sustainability.

## Decision for this MCP

Retain Playwright as the default for repeatable development verification. Accept Agent Browser as an optional capture source. Keep browser engines outside the production MCP dependency tree.

The current Mobbin adapter uses authenticated HTTP/Next.js requests and an image resolver. It does not run Playwright in production. Replacing a browser package would not replace or improve these requests. Research references therefore accept links from either browser tool, Mobbin, or manual sources. The `captured_by` value records the agent's supplied provenance, not a verified integration or an automatic capture operation.

This leaves users free to choose a browser tool in their coding agent without increasing installation requirements for every MCP user. No Agent Browser daemon is exposed through this MCP, and the server does not inherit a user's browser sessions.

## Local compatibility check

On 2026-11-16 (UTC), tested Agent Browser **0.43.0** and Playwright CLI **0.1.24** in separate named sessions against the same temporary loopback fixture:

1. Open the fixture.
2. Read its accessible controls.
3. Click the observed “Save reference” button.
4. Confirm the status changed from “Ready” to “Saved reference”.

Both passed. Both sessions and the fixture server were closed. This is a basic navigation/interaction smoke check, not a latency, token-cost, rendering, accessibility, authentication, or reliability benchmark. It does not justify a claim that either tool is globally better.

Before changing the default, compare pinned versions on representative tasks: dynamic forms, navigation, dialogs, screenshot capture, protected local test sessions, page changes, and recovery from failures. Measure successful completion and artifact correctness first; then compare tool-response sizes and latency while separating cold installation/startup from warm runs. Include Playwright CLI as well as MCP if evaluating token use.
