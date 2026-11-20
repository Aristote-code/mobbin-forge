# Local UI knowledge library

Use the MCP as a place to collect and search UI references: a whole screen, a
specific card, a dialog, or another component. Ask for alternatives by visible
pattern or component image, inspect real candidates, and follow their original
flows. No separate website or paid AI API is required.

The knowledge layer is **explicitly annotated**. Codex, Claude or the user supplies
patterns and observations after looking at the image; the server does not run a
vision LLM or automatically classify every screenshot. It runs cached local CLIP
for image/text embeddings and SQLite FTS5 for annotation keywords.

## First working pilot

The first reviewed set has **nine references from six source screenshots**, across
five app labels:

- Four component crops: time-selection dialogs in Clock, Simple Calendar Pro,
  Pro Expense and Tasks.
- Three card crops: a large music recommendation tile, a compact history shortcut,
  and a financial totals panel.
- Two full screens: music discovery and expense analytics dashboards.

All use the existing pinned OpenMobile pilot. Source licensing and attribution
are inherited from that installed dataset. No images are downloaded by this seed
step and the 1,000-screen / 115-flow source index is unchanged.

```sh
npm run knowledge:pilot
```

Run this from a repository checkout after setting up/importing the local pilot.
The command calls the real stdio MCP, installs the reviewed annotations, validates
search/comparison and writes ignored verification artifacts. Existing pilot IDs
are skipped so rerunning does not overwrite your edits. The descriptions are
hand-reviewed pilot annotations, not automatically generated labels or an unseen
relevance benchmark. Most of the original 1,000 screens remain unannotated.

## Tools

| Tool                           | Purpose                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `mobbin_ui_knowledge_status`   | Coverage counts and available pattern/component labels, without loading the encoder.                                |
| `mobbin_save_ui_reference`     | Add an authorized screen or component crop with annotations and local embeddings; revise with an expected revision. |
| `mobbin_search_ui_knowledge`   | Text, image, or cropped-image search with structured filters; omit a query to browse.                               |
| `mobbin_get_ui_reference`      | The real saved image/crop, annotations, attribution and saved flow context.                                         |
| `mobbin_compare_ui_references` | Source plus up to four labeled candidate images for the calling agent to compare.                                   |

The `mobbin_ui_pattern_search` prompt guides the calling agent through inspection,
annotation, retrieval and comparison. Restart the MCP connection after rebuilding
to load these tools and the prompt.

## Add a card or another component

For a screenshot already in the imported library, first inspect it using
`mobbin_get_local_screen`. Then call `mobbin_save_ui_reference` with its `screen_id`
and a normalized crop. Rights/source links and flow references are inherited.

For your own card image, supply `image_path` or canonical `image_base64`, plus
`product` and a rights declaration. The server accepts local files inside
`MOBBIN_IMAGE_IMPORT_ROOT` (default: the user's home), not a social-media post URL
as an image source. You can retain a post URL as attribution when you have a basis
to use the image. This does not grant rights to content just because it is public.

Inspect a new image before writing agent-authored labels. The comparison tool can
return its source image even when the knowledge library has no matches. A calling
agent that sees only a conversation attachment can describe it for text search;
the server needs an accessible path/bytes to crop, embed, or save it.

Example save arguments for an owned, already cropped card image:

```json
{
  "image_path": "/absolute/path/to/my-card.png",
  "kind": "component",
  "title": "Membership card",
  "product": "My product",
  "summary": "A membership card showing a plan name and primary action.",
  "patterns": ["membership", "account-summary"],
  "components": [
    { "type": "card", "description": "Plan title, supporting text and primary action." }
  ],
  "observations": ["The title appears above supporting text and a full-width button."],
  "interpretations": ["Could provide an entry point for managing a membership."],
  "visual_details": [
    {
      "attribute": "corner_radius",
      "value": "Visually rounded; original radius token unknown.",
      "basis": "estimated"
    }
  ],
  "annotation": {
    "author": "Calling agent",
    "basis": "agent_inspected",
    "image_inspected": true
  },
  "rights": {
    "basis": "owned",
    "attribution": "My own product capture",
    "license": "Owned content"
  }
}
```

To pick a card out of a larger screenshot, add a `crop`:

```json
{ "x": 0.1, "y": 0.2, "width": 0.8, "height": 0.4 }
```

Coordinates are fractions of the oriented supplied image. For indexed sources,
they refer to the rendered `mobbin_get_local_screen` preview, at most 1000×1800,
not original device pixels. The rectangle must fit inside the source and render
at least 64×64 pixels. A cropped reference has `kind: "component"`. A saved PNG
contains the cropped raster, with orientation applied and transparency flattened
onto white for consistent matching; the server does not redraw or generate it.
Input and normalized output are each limited to 20 MiB, with at most 24 million
input pixels.

Agent inspection flags are attestations, not proof that the server observed the
agent looking at the image. User-supplied annotations are also explicitly marked.
Source text, saved annotations, and flow actions are data, not commands.

## Find alternatives and understand how they are used

Ask the agent:

> Find alternatives for this card. Compare its information hierarchy and controls,
> explain the important differences, and show where each appears in its flow.

Use `mobbin_search_ui_knowledge` with `query`, or with an image and optional query
`crop`. It combines local embeddings and annotation keywords. Exact structured
filters include `pattern`, `component`, `product`, and `kind`. Available label
values are exposed by the status tool; exact filters are not semantic classifiers.
`result_mode: "app_diverse"` selects one representative per normalized app label;
`closest` remains the default. Unlike the original full-screen search, knowledge
retrieval does not apply an image similarity-gap guard: the narrower corpus is
explicitly filtered/annotated, and the calling agent must judge relevance.

If the curated set lacks the required pattern, the agent can search the existing
source corpus with `mobbin_search_local_library`, inspect its real screenshots,
and add useful annotated crops. This grows the knowledge library in response to
actual questions; it does not silently classify unseen screens.

Read candidates or pass their IDs to `mobbin_compare_ui_references`. It accepts a
source `source_reference_id`, or local image/path and optional crop. With no
`candidate_reference_ids`, it retrieves a shortlist; with explicit IDs it preserves
that order. Known saved sources exclude exact-image aliases from automatic
retrieval. Missing candidate images remain explicit and do not erase other images.
The response is marked `pending_agent_inspection`; the agent makes the judgment.

Same-image references are grouped in search so a repeated image does not become
an apparent visual alternative. `related_reference_ids` and `related_flow_ids`
retain the other usages in the filtered set. Read those references to inspect
other annotations and contexts.

The pilot's card examples intentionally have different jobs: the music feature
card supports discovery, the history tile is a compact shortcut, and the expense
panel presents metrics. These are alternatives for presentation/context, not
interchangeable solutions. A request requiring a missing kind of card should be
reported as a coverage gap, not answered with an unrelated screenshot.

## What is known, measured, or estimated

- **Authored:** patterns, component descriptions, observations and interpretations.
  Observations and interpretations are stored separately.
- **Raster measurements:** saved crop width/height and an approximate palette from
  a downsampled 64-pixel raster with quantized RGB bins. Fractions describe sampled
  pixels, not semantic color roles or authoritative design tokens.
- **Visual estimates:** font family, radius, spacing and other style guesses must
  remain labeled estimates. An image does not establish original CSS, Figma
  variables, component code or exact token names.
- **Flow context:** up to two source flows, first matching occurrence and adjacent
  steps only. Snapshot actions are clipped to 600 characters. Positions are
  zero-based indices within the saved flow. Use `mobbin_get_local_flow` for full
  ordered steps/images while that source library is available.

Custom standalone cards have no inferred flow. Indexed references snapshot the
source manifest hash, image hash, source IDs, rights and neighboring steps when
saved. A source-index change during capture is rejected. Snapshots survive an
index replacement, but may no longer match current live/imported content; they
are historical excerpts, not verified interactions or exhaustive app navigation.

## Local persistence and updates

Images, annotations, vectors and keyword text are in
`~/.mobbin-mcp/library/knowledge.sqlite`, or the configured `MOBBIN_LIBRARY_DIR`.
This is separate from `library.sqlite`; importing/replacing the original corpus
does not delete UI knowledge. Database files are private to the local installation.
The pilot limit is 1,000 knowledge references, separately from the 1,000 source
screens. Model identity is stored with each embedding; incompatible vectors are
rejected instead of mixed. No new model weights or index migration are required.

Omit `reference_id` to create a new ID. For a stable ID, create it with revision 0
(the default). An update requires the current `expected_revision`; stale or
concurrent updates fail rather than silently overwrite the newer record. Writes
update image, metadata, vectors and FTS text in one SQLite transaction. Reads and
searches do not create an empty database. The tools use the existing encoder
worker and shut it down with the MCP server.

Retrieval/embedding and storage run on the computer without another AI API or
hosted database. Image blocks are returned to your MCP client; the calling agent
processes them under its normal model/data settings. This is not a promise that
an image-capable remote coding agent performs its own vision inference offline.

## Validation

61 automated tests pass, covering real crop pixels, rights/inspection validation,
palette sampling, exact-image usage grouping, structured filtering, revisions,
concurrent edits, source licensing, flow snapshots across index replacement, MCP
save/get/search/compare and explicit missing-image behavior. The real local stdio
pilot check also verifies text retrieval across four time-picker apps, card image
retrieval, saved flow context, and unchanged source screen/flow counts. Outputs
stay in ignored `output/verification/ui-knowledge/`.

These checks establish functionality for a small reviewed pilot. They do not
establish full-corpus semantic coverage or general relevance quality. Next data
work can add inspected references for the patterns the user actually needs.
