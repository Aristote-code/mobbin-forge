# Local vector library pilot

This optional feature imports up to 1,000 authorized screenshot records and their provided flows into a private local SQLite database. A pinned, quantized CLIP model creates genuine image/text embeddings on the CPU. No paid AI API, hosted vector database, Docker service, or Mobbin account is required for the library-only mode.

## Install, prepare, and import

Use Node.js **22.13+**. Install optional dependencies with `npm install --include=optional`, then build:

```bash
npm run build
node dist/index.js library setup
```

Setup downloads the pinned public model files once (roughly 160 MB of encoder weights/configuration). Inference uses cached files only and disables network fetches in its worker. Installing npm dependencies also requires network access. CPU time, disk use, and electricity remain real costs even though there is no AI-provider bill.

The bundled pilot downloader uses **Uni-GUI-OpenMobile**, whose publisher declares Apache 2.0 licensing. It downloads a bounded selection directly from the public dataset at a pinned revision, preserves dataset attribution and license metadata, and verifies screenshot SHA-256 values against source LFS metadata. It never downloads from Mobbin. Original application assets retain their respective rights; preserve the source attribution and inspect licensing for your intended distribution.

```bash
npm run pilot:download
node dist/index.js library import "$HOME/.mobbin-mcp/pilot/openmobile/manifest.json"
node dist/index.js library status
node dist/index.js library search calendar create event
```

The sampler cycles through task categories, deduplicates identical screenshot files, and selects entire provided trajectories rather than cutting a flow to hit the target. It selects ordered source steps starting at zero with a terminal action, excludes source-deleted entries, and skips an episode if its new images would exceed 1,000. If it cannot reach exactly 1,000 within the bounded selection, it reports the actual count and exits with status 2. It does not synthesize images or fabricate missing steps to fill the pilot.

Repeated screenshot files can appear multiple times in one or more flows while having one stored asset and one set of vectors. Task/action text is imported annotation data, not verified OCR, an automatically extracted component tree, or an instruction to execute. The product field is source task-app metadata; an Android home/system screen can appear in several application trajectories. “Complete” refers to the provided trajectory, not every possible app branch.

Default paths:

- Dataset/download cache: `~/.mobbin-mcp/pilot/openmobile`
- Database: `~/.mobbin-mcp/library/library.sqlite`
- Model weights and resumable embedding cache: `~/.mobbin-mcp/library/`

Set `MOBBIN_LIBRARY_DIR` to an absolute private directory for another library. The downloader accepts `--out /absolute/path/to/dataset`. Research/model/data files remain outside the source repository and npm package.

## Use through MCP

The existing Mobbin MCP gains four library tools. A separate MCP can expose just these tools without Mobbin authentication:

```toml
[mcp_servers.mobbin-library]
command = "node"
args = ["/absolute/path/to/mobbin-forge/dist/index.js", "library", "serve"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

| Tool                          | Behavior                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `mobbin_local_library_status` | Read dataset/model provenance, counts, and import time without loading the encoders.                                                           |
| `mobbin_search_local_library` | Supply exactly one `query`, `image_path`, or `image_base64`; optional `product`, `platform`, and `limit` (1–20).                               |
| `mobbin_get_local_screen`     | Return the actual stored image inline, metadata, dimensions, and associated flow IDs.                                                          |
| `mobbin_get_local_flow`       | Read ordered steps/actions with `offset`/`limit` pagination; optional `include_images` returns up to three labeled screenshots from that page. |

Example requests:

> Search my local library for calendar event creation, show the closest screens, and open their flows.

> Find screens visually similar to this local screenshot, inspect the actual matches, and explain the differences.

Conversation attachments are not automatically available to the server. For image-vector search, provide an accessible local path/bytes. If the attachment is visible only to the coding agent, the agent can describe it and submit a text query instead. Local query paths must resolve inside `MOBBIN_IMAGE_IMPORT_ROOT`, which defaults to the OS user's home directory.

## Retrieval and chunking

The first vector describes the entire screenshot, letterboxed to a white 224×224 canvas instead of silently center-cropping away the top and bottom. Tall screens also receive top/middle/bottom square-region vectors; wide screens receive left/middle/right vectors. Near-square screens use one whole-image vector.

Image queries compare the whole screen and region vectors using exact cosine search. Text queries embed the text locally and combine vector ranks with SQLite FTS5 keyword ranks using reciprocal-rank fusion. Filters are applied before result ranking. Search responses include compact annotation excerpts; full stored metadata and images are read on demand.

Model identity: `Xenova/clip-vit-base-patch32`, revision `6b7c523703ae26e39be4b03774966f8571c7f523`, q8, 512 dimensions, Transformers.js 4.3.2. Model and preprocessing identity are stored with the index/cache. A mismatched index is rejected rather than searched with incompatible vectors.

CLIP is a general image/text model, not a UI-specific layout detector or OCR engine. Small text and precise spacing may be poorly represented. Similarity scores are retrieval signals, not calibrated match percentages, design-quality scores, or proof that a proposed change improves conversion. Inspect images with the agent's native vision before making recommendations. Flow retrieval follows imported IDs/order, not inferred navigation.

## Import your own authorized collection

Use a JSON manifest beside its screenshot files:

```json
{
  "schema_version": 1,
  "dataset": {
    "id": "my-owned-library",
    "title": "My owned product captures",
    "source_url": "https://example.org/my-product",
    "license": "Owned content",
    "license_url": "https://example.org/permissions",
    "attribution": "Captured by the product owner",
    "rights_basis": "owned"
  },
  "screens": [
    {
      "id": "settings",
      "image": "images/settings.png",
      "title": "Settings",
      "product": "My product",
      "platform": "web",
      "tags": ["settings"],
      "text": "Optional provided OCR or annotation text"
    }
  ],
  "flows": [
    {
      "id": "configure-account",
      "title": "Configure account",
      "goal": "Review settings",
      "complete": true,
      "steps": [{ "screen_id": "settings", "source_step": 0, "action": "Open settings" }]
    }
  ]
}
```

Replace example source/license URLs and ownership statements with the collection's actual provenance. `rights_basis` supports `owned`, `licensed`, and `written_permission`; this records your basis and does not independently verify it. The importer does not fetch URLs in a manifest.

Images must be relative paths resolving inside the manifest folder, regular PNG/JPEG/WebP/AVIF/GIF files, at most 20 MiB and 24 million pixels, and at least 64×64. IDs must be unique; every flow screen ID must exist; supplied source-step numbers must increase. Original image bytes are retained locally so later source-file edits cannot silently change stored evidence.

Import creates a staging database and publishes it atomically after all records/vectors validate. An existing library remains readable while a replacement is built. Importing the same manifest is idempotent; replacing a different index requires `--replace`. Embeddings are cached by image/model/preprocessing identity to avoid repeating successful work after an interrupted import. A stopped process can leave `.import.lock`; confirm no importer is running before removing that lock locally. The database and caches are personal local storage, not multi-tenant authorization.

## Validation

`npm test` verifies import validation, immutable images, deduplication, exact-neighbor ranking with controlled embeddings, text/filter handling, ordered flow aliases, persistence, atomic replacement, cache reuse, failure recovery, and all four library tools over MCP with network calls rejected.

Those unit tests do not establish real-model search quality. Acceptance checks should additionally use the downloaded encoders in offline mode, verify self-image retrieval, inspect representative text/image results, retrieve associated real flow sequences, and report exact screen/image/vector/flow counts. The pilot is a retrieval baseline for evaluation, not a claim of complete UI understanding.

Sources: [dataset card](https://huggingface.co/datasets/UI-MOPD/Uni-GUI-OpenMobile), [CLIP ONNX model and MIT license](https://huggingface.co/Xenova/clip-vit-base-patch32), [Transformers.js local/offline configuration](https://huggingface.co/docs/transformers.js/api/env), [Node SQLite](https://nodejs.org/api/sqlite.html).

## Measured screenshot matching

Image search accepts `image_matching: "balanced" | "layout"`. The default remains
`balanced`: 60% whole-screen similarity plus 40% best matching regions, allowing
components to move. `layout` uses the same cached local embeddings but compares
corresponding tile positions. Missing orientation tiles fall back to the whole
view. It also uses only the whole view for square query images. No re-import,
model download, or AI API is needed to switch modes. Text ranking is unchanged.

Use `layout` when the arrangement of a reference screen matters. For exploratory
inspiration, start with `balanced`. If results look wrong, compare both lists and
inspect the returned images before recommending a reference; scores do not certify
relevance. Task app labels and flow goals can describe a different app/state from
the screen actually visible.

The first 24-screen benchmark showed mixed held-out results, so layout is an
explicit option, not a replacement default. See [the benchmark report](local-relevance-benchmark.md)
for results, licenses, limitations, and reproduction commands.
