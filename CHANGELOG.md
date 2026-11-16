# Changelog

## 1.6.0 (2026-11-17)

- Add native agent-driven screenshot reference search through three MCP tools and a reusable workflow prompt, without another AI API key or model service.
- Prepare a local screenshot, inline image, trusted Mobbin image, or conversation-attachment handle. The calling agent inspects the source and supplies a structured visual brief.
- Retrieve standard-search candidates across up to three queries, interleave and deduplicate results, and return labeled comparison batches with the source plus up to four candidate images.
- Keep retrieval order explicitly unranked; require native agent vision to judge similarities and differences, with failed images and partial search errors preserved.
- Bound screenshot imports, memory caches, and session handles; document local import roots, ephemeral sources, host-vision requirements, and the distinction from a catalog-wide visual index.
- Add regression coverage for image input, native attachments, query-only retrieval, image association, failures/retries, session expiry/isolation, website sections, and MCP tools/prompts.

## 1.5.0 (2026-11-17)

- Add eight local research tools for reusable project profiles, persistent benchmarks, ordered reference flows, cited findings, decisions, history, retrieval, and Markdown briefs.
- Keep project context optional and product-neutral. Existing benchmarks retain the profile revision used when they were created.
- Accept reference links captured through Mobbin, Playwright, Agent Browser, or manual research without adding a production browser or AI API dependency.
- Align comparison stages using supplied labels and record missing coverage as unknown; separate observations, interpretations, hypotheses, and preferences.
- Preserve superseded findings; validate citations and inspection attestations; use revision checks, filesystem locks, atomic writes, and private local files.
- Add research persistence, workspace separation, concurrent-edit, citation, export, and MCP workflow tests. Expand live verification with isolated local research records.
- Document the browser-tool decision and the distinction between local installations for many users and a future authenticated shared service.

## 1.4.0 (2026-11-16)

- Add standard free-text queries, website-section search, saved-item access, account capability reporting, and comment tools to the independent MCP.
- Add optional in-chat galleries, inline thumbnails, full-image inspection, and MCP workflow instructions for coding agents.
- Verify private collection creation, saving, and readback against a signed-in account; remove temporary verification data afterward.
- Translate requested page sizes across the website's fixed result batches and handle empty batches despite larger catalog totals.
- Accept current saved/collection response shapes and validate login before storing credentials.
- Add opt-in website Deep Search routing with account-access checks. The verification session lacks access, so no Deep Search was run.
- Upgrade the MCP SDK, image decoder, and Zod validation library; runtime dependency audit reports no known vulnerabilities.
- Add regression tests and expand read-only live MCP verification. Comment posting is covered by serialization tests and deployed-action discovery, without sending test messages.

## [1.3.1](https://github.com/pdcolandrea/mobbin-mcp/compare/v1.3.0...v1.3.1) (2026-05-05)


### Bug Fixes

* **schemas:** accept trimmed row shape from element/keyword-filtered search-screens ([#39](https://github.com/pdcolandrea/mobbin-mcp/issues/39)) ([a01de99](https://github.com/pdcolandrea/mobbin-mcp/commit/a01de99cdaa7d81c29b22cc88dce1c8406d1b416))

## [1.3.0](https://github.com/pdcolandrea/mobbin-mcp/compare/v1.2.0...v1.3.0) (2026-04-29)


### Features

* self-heal Supabase publishable key on rotation ([#32](https://github.com/pdcolandrea/mobbin-mcp/issues/32)) ([#36](https://github.com/pdcolandrea/mobbin-mcp/issues/36)) ([369485b](https://github.com/pdcolandrea/mobbin-mcp/commit/369485b17fc46da460b22cf6a40b6701af4b04b0))

## [1.2.0](https://github.com/pdcolandrea/mobbin-mcp/compare/v1.1.0...v1.2.0) (2026-04-27)


### Features

* add mobbin_get_collection to fetch saved collection items ([#29](https://github.com/pdcolandrea/mobbin-mcp/issues/29)) ([ba2a5cc](https://github.com/pdcolandrea/mobbin-mcp/commit/ba2a5cca0a6fd8272c88ac3abe1b3b1fefeeb2be)), closes [#17](https://github.com/pdcolandrea/mobbin-mcp/issues/17)

## [1.1.0](https://github.com/pdcolandrea/mobbin-mcp/compare/v1.0.8...v1.1.0) (2026-04-26)


### Features

* add mobbin_get_app_screens and mobbin_get_app_flows ([#26](https://github.com/pdcolandrea/mobbin-mcp/issues/26)) ([1e5aa59](https://github.com/pdcolandrea/mobbin-mcp/commit/1e5aa59697b1930a9977062fade0645a8d86e6e4))
* scope mobbin_get_filters to a single facet ([#25](https://github.com/pdcolandrea/mobbin-mcp/issues/25)) ([c971e6a](https://github.com/pdcolandrea/mobbin-mcp/commit/c971e6a49b88b6cab685bbcb7731faf29650f615))
* validate Mobbin API responses with zod at the client boundary ([#23](https://github.com/pdcolandrea/mobbin-mcp/issues/23)) ([e5ada99](https://github.com/pdcolandrea/mobbin-mcp/commit/e5ada9949f87b32e6549aaded630413deb27d997))

## [1.0.8](https://github.com/pdcolandrea/mobbin-mcp/compare/v1.0.7...v1.0.8) (2026-04-26)


### Bug Fixes

* correct FlowScreen type and formatter to match search-flows API ([439d3d7](https://github.com/pdcolandrea/mobbin-mcp/commit/439d3d7623453723f6d8abd768e056ee2ad6e63f))

## [1.0.7](https://github.com/pdcolandrea/mobbin-mcp/compare/v1.0.6...v1.0.7) (2026-04-26)


### Bug Fixes

* add repository field to package.json for provenance verification ([a2b034b](https://github.com/pdcolandrea/mobbin-mcp/commit/a2b034b277d4cb711515884307f30928ee186188))
* handle null and flat-number shapes in mobbin_get_filters ([23592d2](https://github.com/pdcolandrea/mobbin-mcp/commit/23592d2c172b0ae0b18e26139b813d29108a8e35))

## [1.0.6](https://github.com/pdcolandrea/mobbin-mcp/compare/v1.0.5...v1.0.6) (2026-04-26)


### Miscellaneous Chores

* release 1.0.6 ([#9](https://github.com/pdcolandrea/mobbin-mcp/issues/9)) ([b3a0a70](https://github.com/pdcolandrea/mobbin-mcp/commit/b3a0a70a1fab54b9b8641886af21eb66a01f7df1))
