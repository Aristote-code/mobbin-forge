# Native screenshot reference search

This workflow helps an image-capable coding agent find real references similar to a screenshot. It uses the agent's own vision, the existing Mobbin standard-search adapter, and inline image responses. The MCP does not call an AI inference/embedding provider, generate replacement screens, or need another AI API key. Normal host-agent usage and Mobbin account restrictions still apply.

## User experience

Attach a screenshot and ask:

> Find five real references close to this screenshot. Prioritize the layout and component structure, ignore the brand colors, inspect the actual images, and explain similarities and differences.

The agent prepares the source, describes what it sees, retrieves candidates, inspects image batches, and writes a ranked answer with source links. The MCP supplies retrieval and images; the agent supplies understanding and judgment. If the host/model cannot inspect images, this workflow cannot produce a reliable visual comparison.

The optional MCP prompt `mobbin_visual_reference_search` accepts `screenshot` and `goal` strings and describes these steps. Prompt availability depends on the client; the server's initialization instructions and tool descriptions contain the workflow too.

## Tools

### 1. `mobbin_prepare_visual_search`

Supply exactly one:

- `attachment_label`: a short label for an image the agent can already see in the conversation. The server does not receive or independently inspect that attachment.
- `image_path`: an absolute path to a screenshot accessible to the local server.
- `image_base64`: canonical base64 image bytes without a data-URL prefix. Prefer a path for local files to avoid placing large strings in the agent context.
- `mobbin_image_url`: an existing Mobbin screenshot URL handled by the trusted image resolver. Arbitrary external URLs are not downloaded.

Loaded images are decoded and returned inline as a WebP preview, up to 1200 × 1800 pixels while preserving aspect ratio. Their dimensions and a SHA-256 digest are retained with an opaque `source_id`. Conversation-only handles explicitly report that no source image is present in the tool packet; the agent must inspect the original attachment. A handle alone is not visual evidence.

Local imports must resolve inside `MOBBIN_IMAGE_IMPORT_ROOT`, which defaults to the OS user's home directory. Symlink escapes, relative paths, non-regular files, non-raster documents, and tiny images are rejected. Allowed formats are PNG, JPEG, WebP, AVIF, and GIF (first frame). Inputs are limited to 20 MiB and 24 million pixels. Configure an absolute import root when using screenshots stored outside the default directory.

### 2. `mobbin_search_visual_references`

After actually inspecting the screenshot, supply:

```json
{
  "source_id": "ID returned by prepare",
  "source_inspected": true,
  "brief": {
    "screen_type": "Account settings",
    "layout": "Stacked cards with a bottom navigation bar",
    "components": ["List", "Toggle"],
    "style": "Light background",
    "interaction_goal": "Manage account preferences"
  },
  "focus": ["layout", "components"],
  "platform": "ios",
  "content_type": "screens",
  "max_candidates": 12
}
```

The actual `source_id` must be a UUID returned by the server. `source_inspected` is an agent attestation, not server verification. Do not infer hidden interactions or outcomes from one static screenshot.

`focus` supports `layout`, `components`, `interaction`, and `style`. Platforms are `ios`, `android`, and `web`. For marketing website references, select `content_type: "sections"` with `platform: "web"`.

Optionally provide one to three `queries` (each up to 500 characters) instead of the queries constructed from the brief. The defaults use screen type, layout, components, and optionally style/interaction goal. Omit private names, account identifiers, and unrelated visible text from retrieval queries. Only text queries are sent to Mobbin; source image bytes are not uploaded there.

Retrieval uses standard search, never Deep Search. Results from up to three queries are interleaved and deduplicated by content ID, with a maximum of 20 candidates. Query failures are explicit; successful queries can still supply results. No results means no references were found in those searches, not that similar designs do not exist.

The response contains `search_id`, candidate IDs, product names, image/source URLs, taxonomy metadata, and query provenance. `ranking: "unranked_retrieval"` is deliberate: text-search position is not a visual similarity score.

### 3. `mobbin_get_visual_comparison`

Supply a returned `search_id` and one to four distinct `candidate_ids`. The server returns the source preview when available, followed by a text label and image for each successful candidate. IDs must belong to that search. A failed image stays explicit and is excluded from `image_returned_candidate_ids`. Candidate image caching shares successful downloads; failed downloads can be retried.

Inspect each image before ranking. If evaluating more than four candidates, request additional batches and state how many you inspected. A successful image response alone is not an inspection attestation. For a conversation-only source, the source attachment must still be visible to the agent; if not, request it again.

The agent's answer should include candidate/product identity, source link, concrete visual similarities, meaningful differences, and uncertainty. It should explain matches against the requested focus and avoid uncalibrated similarity percentages, fabricated references, and claims of exhaustive catalog coverage.

## Research reuse

On request, use the existing benchmark tools to retain selected candidate links and agent-authored findings. These tools distinguish observations, interpretations, hypotheses, and preferences. Source image handles and retrieval jobs themselves are temporary; preparing/searching/comparing does not automatically write persistent research or change the Mobbin account.

## Session and cost boundaries

Handles belong to one server process, expire after 20 minutes, and can be evicted earlier by cache limits. Restarting the MCP clears them. Sources/searches are kept in bounded in-memory caches (12 sources, 24 searches, 64 candidate previews). Expired records are purged on subsequent operations; cached image bytes are not persisted by these tools. This is a local stdio workflow, not an authenticated shared image-hosting service.

This version performs bounded candidate retrieval followed by native agent comparison. It does not maintain an image-embedding index or search every image in the Mobbin catalog. Matching quality depends on the description, accessible search results, image availability, and host model. Reducing `max_candidates` and comparing small batches limits image/context usage; this is not a promise of zero token cost.

## Verification

`npm test` covers image decoding, source handles, native-attachment behavior, import-root checks, partial failures, text-only standard retrieval, query interleaving/deduplication, image/ID association, retries, session expiry/isolation, website-section routing, and the tools/prompt through MCP. Fake-client tests reject unexpected network calls, so they also catch accidental inference-provider use.

Live checks can validate real retrieval, source/candidate image delivery, and metadata. They do not by themselves establish ranking quality. Evaluate that separately with representative screenshots, native agent inspection, and human judgments of the returned references.

On 2026-11-17, a live check using an existing Duolingo exercise-feedback screenshot retrieved six candidates and returned a labeled source plus three candidate images. Native visual inspection found a Brainly quiz screen with a similar pink answer-feedback panel, progress indicator, character illustration, and continuation action. The other two inspected candidates were DoorDash screens with different purposes/layouts. This demonstrates a useful match among the three inspected images; it is not an exhaustive quality evaluation or a claim that the first retrieval result is the closest match.
