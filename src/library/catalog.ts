import { createHash } from "node:crypto";
import { MODEL_KEY, normalize, type ChunkVector, type Manifest } from "./schema.js";
import {
  automaticEvidenceSchema,
  type AutomaticEvidence,
  type KnowledgeInput,
} from "./knowledge-schema.js";

export const CATALOG_VERSION = "local-ui-catalog-v3";
export const CATALOG_TAXONOMY = {
  pattern: {
    "app-launcher": "an Android home screen or app drawer with a grid of application icons",
    onboarding:
      "an onboarding tutorial explaining a mobile application with next and continue actions",
    dashboard: "an app dashboard showing summary information and cards",
    settings: "an app settings screen with a list of preferences and switches",
    search: "an app search screen with a search field and search results",
    "empty-state": "an empty state screen explaining that there are no items",
    "list-browsing": "a mobile app screen showing a list of items",
    "form-entry": "a mobile form with labeled input fields and a save action",
    "note-editor": "a text editor for writing and editing a note",
    conversation: "a messaging conversation with message bubbles and a compose input",
    "date-selection":
      "a date picker calendar dialog with a selected day and confirm cancel actions",
    "time-selection": "a time picker dialog with a clock face or hour minute inputs",
    "color-selection": "a color picker showing color swatches or a color gradient",
    permissions: "a system permission dialog with allow and deny buttons",
    confirmation: "a confirmation alert dialog with cancel and confirm actions",
    "action-menu": "a popup menu showing a list of available actions",
    "navigation-drawer": "an app navigation drawer sidebar menu",
    "media-library": "a music or video library screen with tracks playlists and albums",
    "media-playback": "a media player showing playback controls for music or video",
    "recipe-detail": "a recipe details screen with ingredients and cooking directions",
    "contact-detail": "a contact details or contact creation screen with name and phone fields",
    "error-state": "an error message explaining a failure in an app",
    loading: "a mobile app screen with a loading spinner",
    "keyboard-input": "a mobile app with an on screen keyboard and editable text",
    "file-browser": "a file manager showing folders and files",
    profile: "a profile or account screen showing user information",
    analytics: "an app analytics screen with charts and numeric statistics",
    "task-management": "a task list with checkboxes due dates and priorities",
    drawing: "a drawing canvas with pen brush and color controls",
    "about-info": "an about page showing application version and links",
    "content-detail": "a mobile content detail screen with a title and text",
  },
  component: {
    card: "a user interface card containing grouped information or a preview",
    "text-input": "a labeled text input field in a form",
    button: "a prominent button with a text label",
    "bottom-navigation": "a bottom navigation bar with several icon destinations",
    tabs: "a row of selectable tabs or a segmented control",
    list: "a vertical list of items",
    dialog: "a centered modal dialog over dimmed content",
    "bottom-sheet": "a bottom sheet panel over app content",
    keyboard: "an on screen alphabetic or numeric keyboard",
    avatar: "a circular profile avatar or person icon",
    chart: "a chart or graph showing numeric data",
    "image-preview": "an image thumbnail or illustrated content preview",
    "search-field": "a search input field with a magnifying glass icon",
    checkbox: "a checkbox or selection control beside a list item",
    "date-picker": "a calendar date selection widget",
    "time-picker": "an analog clock or hour minute time selection widget",
  },
  layout: {
    "single-column": "a mobile app layout with vertically stacked content sections",
    "two-column-grid": "a mobile app layout with two columns of cards or tiles",
    "multi-column-grid": "a mobile app grid with multiple columns of icons or thumbnails",
    "form-with-keyboard": "a form layout with an on screen keyboard visible at the bottom",
    "modal-over-content": "a modal dialog centered over dimmed app content",
    "bottom-sheet-over-content": "a sheet panel covering the lower portion of an app screen",
    "full-screen-canvas": "an app with a large empty drawing or editing canvas",
  },
} as const;
export type OcrEvidence = AutomaticEvidence["ocr"];
export type PromptVector = { kind: keyof typeof CATALOG_TAXONOMY; label: string; vector: number[] };
/**
 * OCR often reads a toolbar's back arrow or close icon as part of the title
 * ("< Edit Event", "× Create contact", "x Create contact"). Strip those glyphs
 * so exact heading rules still match; the original text stays in the evidence.
 */
export const headingText = (text: string) =>
  text
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/^[xX]\s+(?=\p{L})/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "")
    .trim();
export const catalogReferenceId = (screenId: string) =>
  `auto-ui-v1-${createHash("sha256").update(screenId).digest("hex").slice(0, 40)}`;
export function clipCandidates(
  vectors: ChunkVector[],
  prompts: PromptVector[],
  kind: PromptVector["kind"],
  limit: number,
) {
  const chunks = vectors.map((v) => ({ ...v, vector: normalize(v.vector) }));
  const full = chunks.find((v) => v.region === "full");
  if (!full) throw Error("Source image lacks full vector.");
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
  return prompts
    .filter((p) => p.kind === kind)
    .map((p) => {
      const v = normalize(p.vector);
      return {
        label: p.label,
        score: 0.6 * dot(full.vector, v) + 0.4 * Math.max(...chunks.map((c) => dot(c.vector, v))),
      };
    })
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, limit);
}
export function completeFlowMemberships(manifest: Manifest) {
  const map = new Map<string, AutomaticEvidence["flow_memberships"]>();
  for (const flow of manifest.flows)
    for (const [at, step] of flow.steps.entries()) {
      const list = map.get(step.screen_id) ?? [];
      list.push({
        flow_id: flow.id,
        title: flow.title,
        goal: flow.goal,
        position: at,
        source_step: step.source_step,
        action: step.action,
        previous_screen_id: flow.steps[at - 1]?.screen_id,
        next_screen_id: flow.steps[at + 1]?.screen_id,
        provided_trajectory_complete: flow.complete,
      });
      map.set(step.screen_id, list);
    }
  return map;
}
export function buildAutomaticDescription(input: {
  screen: Manifest["screens"][number];
  sourceSha: string;
  manifestSha: string;
  ocr: OcrEvidence;
  vectors: ChunkVector[];
  prompts: PromptVector[];
  flows: AutomaticEvidence["flow_memberships"];
  generatedAt?: string;
}): KnowledgeInput {
  const { screen, ocr } = input;
  const visible = ocr.text.filter((t) => t.confidence >= 0.6);
  const words = visible.map((t) => t.text).join("\n");
  const rules: AutomaticEvidence["pattern_candidates"] = [];
  const add = (label: string, reason: string) =>
    rules.push({ label, basis: "visible_text_rule", evidence: [reason] });
  if (/select\s*time|pick time/i.test(words))
    add("time-selection", "OCR includes Select time or Pick time.");
  if (
    /january|february|march|april|may|june|july|august|september|october|november|december/i.test(
      words,
    ) &&
    visible.filter((t) => /^\d{1,2}$/.test(t.text.trim())).length >= 8
  )
    add(
      "date-selection",
      "OCR includes a month and multiple day-number candidates; calendar role still requires review.",
    );
  if (visible.some((t) => /^settings$/i.test(headingText(t.text)) && t.bounds.y < 0.25))
    add("settings", "OCR includes Settings near the top of the screen.");
  if (
    /no (items|contacts|media|songs|files|notes)|you have no|nothing here|no stored conversations/i.test(
      words,
    )
  )
    add("empty-state", "OCR contains an empty-content message.");
  if (/allow/i.test(words) && /don.t allow|deny/i.test(words))
    add("permissions", "OCR contains Allow and a deny-style action.");
  if (/ingredients/i.test(words) && /directions/i.test(words))
    add("recipe-detail", "OCR includes Ingredients and Directions.");
  if (/income/i.test(words) && /outcome|expenses/i.test(words))
    add("analytics", "OCR includes income and expense/outcome labels.");
  if (
    visible.some(
      (t) =>
        /^(expense entry|update data|new event|edit event|create contact|new recipe)$/i.test(
          headingText(t.text),
        ) && t.bounds.y < 0.3,
    )
  )
    add("form-entry", "OCR includes a form-style heading near the top of the visible screen.");
  if (visible.some((t) => /^all notes$/i.test(headingText(t.text)) && t.bounds.y < 0.3))
    add(
      "list-browsing",
      "OCR includes All notes near the top; list role is a text-based candidate.",
    );
  if (visible.some((t) => /^my tasks$/i.test(headingText(t.text)) && t.bounds.y < 0.3))
    add("task-management", "OCR includes My Tasks near the top of the screen.");
  const clip = clipCandidates(input.vectors, input.prompts, "pattern", 3).map((c) => ({
    ...c,
    basis: "clip_similarity" as const,
    evidence: [
      "Cached local CLIP image/text similarity; score is not a calibrated probability and this label is unreviewed.",
    ],
  }));
  const patternAffinity = clipCandidates(input.vectors, input.prompts, "pattern", 4);
  const primaryPatterns = rules.length
    ? [...new Set(rules.map((r) => r.label))]
    : patternAffinity[0] &&
        patternAffinity[0].score >= 0.18 &&
        (!patternAffinity[1] || patternAffinity[0].score - patternAffinity[1].score >= 0.015)
      ? [patternAffinity[0].label]
      : ["unclassified"];
  const components: AutomaticEvidence["component_candidates"] = [];
  for (const text of visible) {
    if (
      /^(save|cancel|ok|done|next|continue|allow|don't allow|deny|delete|add|edit|reset|apply|send|search|back)$/i.test(
        text.text.trim(),
      )
    )
      components.push({
        type: "button",
        label: text.text,
        bounds: text.bounds,
        bounds_scope: "text_only",
        basis: "visible_text_rule",
        evidence:
          "Recognized action-like text. Bounds cover OCR text only; button role and full target geometry are unverified.",
      });
    else if (
      /^(name|title|amount|note|notes|description|email|password|phone|location)$/i.test(
        text.text.trim(),
      )
    )
      components.push({
        type: "text-input",
        label: text.text,
        bounds: text.bounds,
        bounds_scope: "text_only",
        basis: "visible_text_rule",
        evidence: "Recognized form-label-like text, not a verified input field or its full bounds.",
      });
  }
  for (const rect of ocr.rectangles)
    components.push({
      type: "container-candidate",
      bounds: rect.bounds,
      bounds_scope: "rectangle_only",
      basis: "rectangle_detector",
      score: rect.confidence,
      evidence:
        "Geometric rectangle observation only. Detector confidence is not confidence that this is a card or interactive component.",
    });
  for (const c of clipCandidates(input.vectors, input.prompts, "component", 3))
    components.push({
      type: c.label,
      score: c.score,
      bounds_scope: "unlocalized",
      basis: "clip_similarity",
      evidence: "Whole-screen/region CLIP affinity only; no verified component boundary or role.",
    });
  const layout = clipCandidates(input.vectors, input.prompts, "layout", 1)[0];
  if (!layout) throw Error("Missing layout prompts.");
  const evidence = automaticEvidenceSchema.parse({
    pipeline_version: CATALOG_VERSION,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    source_asset_sha256: input.sourceSha,
    source_manifest_sha256: input.manifestSha,
    model_key: MODEL_KEY,
    ocr,
    pattern_candidates: [...rules, ...clip],
    component_candidates: components.slice(0, 100),
    layout_candidate: layout,
    flow_memberships: input.flows,
    limitations: [
      "Machine-generated and not visually reviewed by an agent or human.",
      "OCR may miss or misread text, especially icons, tiny text, dimmed backgrounds and non-English text.",
      "CLIP similarities and text rules suggest candidates, not verified UI semantics or a complete component tree. Primary labels prefer visible-text rules; only separated top CLIP guesses are promoted, otherwise unclassified. The thresholds are heuristics, not calibrated accuracy.",
      "Text-only and rectangle-only bounds are not reliable whole-component crop targets.",
      "Source app labels and imported flow actions are metadata; goals were not used as visual classification evidence.",
      "Original fonts, CSS, design-token names, hidden states and actual interaction behavior cannot be recovered reliably from these screenshots.",
    ],
  });
  const headline =
    visible
      .filter((t) => t.bounds.y > 0.04 && t.bounds.y < 0.65)
      .sort((a, b) => b.bounds.height - a.bounds.height)[0]?.text ??
    "no confidently recognized heading";
  const excerpt = visible
    .slice(0, 7)
    .map((t) => t.text.slice(0, 65))
    .join("; ");
  const componentAffinity = clipCandidates(input.vectors, input.prompts, "component", 4);
  const supportedTypes = components.filter((c) => c.basis !== "clip_similarity").map((c) => c.type);
  if (
    componentAffinity[0] &&
    componentAffinity[0].score >= 0.18 &&
    (!componentAffinity[1] || componentAffinity[0].score - componentAffinity[1].score >= 0.02)
  )
    supportedTypes.push(componentAffinity[0].label);
  if (ocr.text.length) supportedTypes.push("text");
  const types = [...new Set(supportedTypes)].slice(0, 25);
  return {
    reference_id: catalogReferenceId(screen.id),
    screen_id: screen.id,
    kind: "screen",
    title: `[Auto] ${screen.product}: ${headline}`.slice(0, 500),
    summary:
      `Unreviewed local analysis. Imported app label: ${screen.product}. OCR text includes: ${excerpt || "no reliable text"}. Candidate patterns: ${[...rules, ...clip].map((c) => c.label).join(", ")}.`.slice(
        0,
        1000,
      ),
    patterns: primaryPatterns,
    components: types.length
      ? types.map((type) => ({
          type,
          description: `Unverified ${type} candidate from ${[...new Set(components.filter((c) => c.type === type).map((c) => c.basis))].join(", ")}. See automatic evidence for text labels, candidate geometry and limitations.`,
        }))
      : [
          {
            type: "unknown",
            description: "No reliable component candidates; image inspection is required.",
          },
        ],
    observations: [
      `Local OCR produced ${ocr.text.length} text regions (${visible.length} at recognition confidence ≥0.6).`,
      `Original raster is ${ocr.width}×${ocr.height} pixels.`,
      `The geometric detector returned ${ocr.rectangles.length} rectangular-region candidates; their UI roles are unknown.`,
      ...(excerpt ? [`Recognized text examples: ${excerpt}`] : []),
    ],
    interpretations: [
      "Pattern and component labels are provisional local model/rule suggestions; no agent image inspection was performed.",
    ],
    visual_details: [
      {
        attribute: "layout_candidate",
        value: `${layout.label}, raw CLIP affinity ${layout.score.toFixed(4)}; unreviewed and uncalibrated.`,
        basis: "estimated",
      },
      {
        attribute: "typography",
        value:
          "OCR text-region geometry is available, but original font family, font sizes and token values are unknown.",
        basis: "estimated",
      },
    ],
    annotation: {
      author: "Local Apple Vision / cached CLIP / explicit rule pipeline",
      basis: "local_automated",
      image_inspected: false,
    },
    automation_evidence: evidence,
  };
}
