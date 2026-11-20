# Local screenshot relevance benchmark

Measured on 2026-11-19 against the installed 1,000-screen OpenMobile pilot. This
benchmark evaluates image-to-image references. It does not establish text-search
quality, Mobbin coverage, or parity with Mobbin Deep Search.

## Screens and permission basis

24 screenshots from 12 source episodes and 11 task app labels, using the public
[UI-MOPD/Uni-GUI-OpenMobile dataset](https://huggingface.co/datasets/UI-MOPD/Uni-GUI-OpenMobile).
The publisher declares Apache 2.0 and describes open-source Android applications.
Sources are pinned to revision `774eb20f97724bf64faa9e66b1572f05b1688e38`.
Every screenshot has a source URL and verified upstream LFS SHA-256 in
`test/fixtures/local-relevance.json`; dataset attribution and license links are
retained there. No screenshots were taken from Mobbin.

Selection used source-directory round robin, skipping episodes already in the
pilot and images with identical indexed file hashes. For the first 12 eligible
episodes, select the middle and final eligible screenshots. There are 24 distinct
query file hashes. Every third episode is held out: 16 development screenshots
from eight episodes and eight held-out screenshots from four episodes. Related
screens and near-duplicates from the same apps can still exist in the index.

## Evaluation and results

Codex visually inspected each query and the union of the top three results from
three scoring variants. Grades: **2** = same prominent UI pattern with compatible
state; **1** = partial reference; **0** = unrelated. App identity, colors, keyboards,
or empty space alone do not establish relevance. These are subjective agent
judgments, not independent human labels. Individual judgments are checked in and
can be reviewed or corrected. Candidate sheets omit variant names, but candidate
ordering was not randomized; this is not a fully blinded study.

The alternatives were fixed before held-out inspection: existing balanced scoring,
60% whole plus 40% same-position tiles, and whole-screen-only scoring. Development
grades favored same-position tiles slightly; that variant was frozen for holdout.
The implementation then reproduces both production search modes and checks their
rankings against the benchmark calculation for all 24 queries.

| Split / mode             | Strong top result | At least one strong top-3 result | Strong results in top 3 | Mean grade (0–2) |
| ------------------------ | ----------------: | -------------------------------: | ----------------------: | ---------------: |
| Development / balanced   |             13/16 |                            15/16 |                   68.8% |            1.500 |
| Development / layout     |             13/16 |                            15/16 |                   70.8% |            1.521 |
| Development / whole only |             12/16 |                            13/16 |                   52.1% |            1.271 |
| Holdout / balanced       |               4/8 |                              5/8 |                   54.2% |            1.167 |
| Holdout / layout         |               4/8 |                              6/8 |                   50.0% |            1.083 |
| Holdout / whole only     |               4/8 |                              4/8 |                   50.0% |            1.042 |

**Decision: preserve balanced as the default; offer layout as an explicit image
search option.** It finds a strong reference for one additional held-out query,
but lowers top-three precision and graded relevance. These results do not support
replacing the default or claiming a general relevance improvement. Whole-only
scoring loses useful detail and was rejected.

Examples from the inspected results:

- `q10`: color picker. Layout promotes an actual color-selection dialog above an
  unrelated feedback editor.
- `q06`: battery usage chart. Layout brings a screen-usage chart into the top three;
  balanced retrieves loading spinners below a related battery settings page.
- `q18`: recipe detail. Layout admits two unrelated note/task screens and loses
  precision; balanced keeps three recipe details.
- `q13`: numeric ingredient adjustment. Neither mode retrieves a strong matching
  dialog; keyboard-bearing forms are only partial references.
- `q11` and `q12`: VLC utility hub and About page. Neither mode retrieves a strong
  reference in its top three. Other VLC screens are not counted as successes.

This is a small, correlated Android-only set, with two queries per source episode.
It does not measure cross-platform generalization or statistical significance.
All labels cover a pooled top-three candidate set; recall and corpus-wide nDCG
cannot be inferred. Held-out judgments are now public and should not be reused as
an unseen test set for subsequent tuning. A future default change needs fresh
held-out episodes and broader app coverage.

## Reproduce locally

From a repository checkout, install dependencies, run `library setup`, download the
pilot (`npm run pilot:download`), and import its manifest as described in
[local-library.md](local-library.md). The runner requires the exact pilot manifest
and installed index hash to prevent comparing different corpora.

```sh
npm run benchmark:library -- --download  # first run: fetch the 24 pinned PNGs
npm run benchmark:library               # subsequent runs: fully offline
```

The first command only downloads public source images, checksum-verifying each.
After that phase, the runner blocks main-thread fetch and the embedding worker
blocks network requests independently. All CPU inference uses the already-cached
pinned quantized CLIP model; no paid AI API or external inference service is used.

Outputs under ignored `output/verification/relevance/` include the 24 PNGs,
query/candidate contact sheets, `rankings.json`, and `metrics.json`. The fixture
contains source provenance, pattern labels and grades keyed by candidate ID.
Unjudged new candidates cause evaluation to fail rather than silently scoring zero.
Screenshots, model weights and the SQLite index stay outside Git.

Validation for this change: 45 automated tests passed, including MCP option
forwarding and layout-versus-reordered-region behavior. Build, lint, formatting,
the complete 24-query production ranking comparison, and the separate 1,000-screen
offline MCP acceptance check passed. The latter verifies plumbing and exact-file
retrieval, not relevance quality.
