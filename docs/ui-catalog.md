# Full local screenshot JSON catalog

The authorized 1,000-screen OpenMobile corpus now has one structured JSON record
per screenshot, generated locally without a paid AI API. This is a machine
analysis baseline, not 1,000 human-verified component trees. Reviewed references
are preserved alongside it.

## Completed coverage

- 1,000 distinct source screens; no missing records or extraction failures.
- 21,205 recognized text regions, with text, recognition confidence and normalized
  bounding boxes.
- Pattern candidates, component candidates, layout suggestions and visual details
  for every screen, with their evidence and limitations.
- 1,069 provided flow memberships, retaining every source occurrence across the
  115 imported trajectories. No navigation is invented.
- 1,000 automatic, unreviewed references plus the existing 11 reviewed references.

The count of OCR regions measures extracted observations, not recognition accuracy
or completeness. Status bars and keyboards can contribute text observations.

## Files and MCP access

The private output directory is:

```text
~/.mobbin-mcp/library/catalog/
  screens/<screen-id>.json  # full record for each screenshot
  screens.jsonl            # all 1,000 records, one per line
  index.json               # source screen → reference ID / file mapping
  coverage.json            # completion, failures, counts and provenance
```

The same records are installed in the local knowledge SQLite index. Search or
browse with `mobbin_search_ui_knowledge`, using `annotation_scope`:

| Scope       | Contents                                              |
| ----------- | ----------------------------------------------------- |
| `all`       | Reviewed and local-automated entries; default.        |
| `automated` | Unreviewed automatic descriptions only.               |
| `reviewed`  | User/agent entries with image-inspection attestation. |

Search results carry compact evidence summaries. `mobbin_get_ui_reference` returns
the actual image and full JSON, including OCR geometry. Comparisons also summarize
large automatic evidence and leave the verdict pending agent inspection. The
calling agent must inspect candidate images before making design recommendations.

Example search arguments:

```json
{
  "query": "time picker with cancel and confirm controls",
  "annotation_scope": "automated",
  "result_mode": "app_diverse",
  "limit": 4
}
```

A structured `pattern` or `component` filter matches the stored primary label.
Automatic labels remain provisional even when they satisfy an exact filter. Use a
text query to explore, then inspect images and, where appropriate, correct the
annotation with the current `expected_revision`. Do not mark uninspected images
as agent-reviewed. Future bulk runs preserve records that have been reviewed.

## What each JSON record contains

| Field                                      | Meaning                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patterns`                                 | Conservative primary candidates: visible-text rules take precedence; a separated top CLIP suggestion can be used otherwise. Uncertain screens may be `unclassified`. |
| `components`                               | Candidate roles with explicit unverified descriptions; text-only geometry is not a full widget boundary.                                                             |
| `observations`, `interpretations`          | Extraction counts/text observations kept separate from inferred semantics.                                                                                           |
| `visual_details`                           | Estimated layout/typography information. Original font families, CSS and design tokens remain unknown.                                                               |
| `measured`                                 | Stored raster dimensions and an approximate downsampled palette.                                                                                                     |
| `source`                                   | Parent screen, source URL, licensing, image/manifest fingerprints and bounded saved flow excerpts.                                                                   |
| `annotation`                               | Automatic records use `basis: "local_automated"` and `image_inspected: false`.                                                                                       |
| `automation_evidence.ocr`                  | Full OCR text, recognition confidences, boxes, rectangle observations, language/revision and original raster dimensions.                                             |
| `automation_evidence.pattern_candidates`   | Additional rule/model suggestions and their evidence, including suggestions not promoted to primary tags.                                                            |
| `automation_evidence.component_candidates` | Candidate labels/bounds with `text_only`, `rectangle_only`, or `unlocalized` scope.                                                                                  |
| `automation_evidence.flow_memberships`     | Every provided flow occurrence, index, source step, action, previous/next screen ID, goal and trajectory-completeness flag.                                          |
| `automation_evidence.limitations`          | Explicit interpretation and coverage limits.                                                                                                                         |

OCR coordinates use a top-left origin on the original raster and are normalized
to 0–1. The saved display image is a preview, so convert coordinates using its
rendered dimensions if drawing overlays. OCR box height is not a font-size token.
A text box saying “Save” is evidence of text, not proof of the full button's bounds.
A geometric rectangle is not automatically a card. Imported product labels may
differ from the app actually visible.

Apple Vision performs the text/rectangle extraction on-device. See
[Apple's OCR documentation](https://developer.apple.com/documentation/vision/recognizing-text-in-images)
and [rectangle detection](https://developer.apple.com/documentation/vision/vndetectrectanglesrequest).
Cached local CLIP compares each screenshot's existing image vectors with explicit
pattern/component/layout prompts. Flow goals and actions are not used as visual
classification evidence. CLIP scores, margins and text rules are uncalibrated
heuristics, not match percentages or semantic accuracy guarantees.

Primary CLIP tags require affinity ≥0.18 and a margin over the next candidate
(0.015 for patterns; 0.02 for component roles). These conservative thresholds were
chosen after inspecting known examples, not calibrated on an independent labeled
UI benchmark. Secondary candidates remain visible as evidence; they are not all
promoted to primary tags. Fonts, hidden states, accessibility roles and actual
interaction behavior cannot reliably be reconstructed from these screenshots.

## Rebuild, resume and verify

From a repository checkout on macOS with command-line Swift and the existing
local pilot/model already installed:

```sh
npm run catalog:build
npm run catalog:verify
```

The builder checks that the manifest matches the installed authorized corpus. It
compiles `scripts/local-ui-ocr.swift`, runs two local OCR workers, caches evidence
by source hash / OCR implementation / OS version, and uses cached local CLIP
weights. JavaScript inference fetches are blocked. There is no cloud OCR, paid AI
API, Mobbin sign-in or new model download in this pipeline.

Records and per-screen exports are checkpointed. Successful work is reused on a
repeat run; stale automatic descriptors are revised using optimistic revisions.
Already-reviewed records are preserved. `coverage.json` reports completion and
failures; a partial run must not be reported as complete. Automatic screen records
have their own stable IDs and do not replace curated component IDs. Identical
raster/model embeddings are reused for metadata-only updates.

The full OCR text is included in the local FTS keyword index, not just the summary.
Keyword rebuilding is transactional and does not alter images or annotations.
The verification command checks every JSON and flow membership, the 1,000-line
export, source checksums, preserved reviewed entries, deep OCR keyword retrieval,
MCP scope filtering, full JSON/image access and comparison failure handling.
It creates eight OCR overlay samples for native inspection. Those spot checks
are not full human review or a relevance benchmark.

Images, generated JSON, OCR caches and the database stay local and are excluded
from Git and the npm package. Source code, tests and documentation can be pushed
without publishing this dataset. Existing catalogs can be read through the MCP on
other supported platforms; this generation adapter requires macOS Vision.
