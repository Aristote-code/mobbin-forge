import { randomUUID, createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { MobbinApiClient } from "../services/api-client.js";

const MAX_BYTES = 20 * 1024 * 1024;
const TTL_MS = 20 * 60_000;
const description = z.string().trim().min(1).max(300);
export const sourceInput = z.object({
  image_path: z.string().min(1).max(4000).optional(),
  image_base64: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_BYTES / 3) * 4)
    .optional(),
  mobbin_image_url: z.string().url().max(4000).optional(),
  attachment_label: z.string().trim().min(1).max(200).optional(),
});
export const briefSchema = z.object({
  screen_type: z.string().trim().min(1).max(120),
  layout: description,
  components: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  style: description.optional(),
  interaction_goal: description.optional(),
});
export const searchInput = z.object({
  source_id: z.string().uuid(),
  source_inspected: z
    .literal(true)
    .describe(
      "The calling agent must actually inspect the source screenshot first. This is an agent attestation.",
    ),
  brief: briefSchema,
  focus: z
    .array(z.enum(["layout", "components", "interaction", "style"]))
    .min(1)
    .max(4)
    .default(["layout", "components"]),
  platform: z.enum(["ios", "android", "web"]).default("ios"),
  content_type: z.enum(["screens", "sections"]).default("screens"),
  queries: z.array(z.string().trim().min(1).max(500)).min(1).max(3).optional(),
  max_candidates: z.number().int().min(1).max(20).default(12),
});
type Preview = { data: string; mimeType: "image/webp"; width: number; height: number };
type Source = {
  id: string;
  kind: "local_image" | "inline_image" | "mobbin_image" | "conversation_attachment";
  label: string;
  sha256?: string;
  original_width?: number;
  original_height?: number;
  preview?: Preview;
  expires_at: string;
};
export interface VisualCandidate {
  id: string;
  content_type: "screens" | "sections";
  product: string;
  platform: string;
  image_url: string;
  source_url: string;
  patterns: string[];
  elements: string[];
  retrieved_by: string[];
}
type Search = {
  id: string;
  source_id: string;
  brief: z.infer<typeof briefSchema>;
  focus: z.infer<typeof searchInput>["focus"];
  queries: string[];
  candidates: VisualCandidate[];
  search_errors: Array<{ query: string; error: string }>;
  expires_at: string;
};

function insertBounded<T>(cache: Map<string, T>, id: string, value: T, max: number) {
  if (cache.size >= max) cache.delete(cache.keys().next().value!);
  cache.set(id, value);
}

export function visualQueries(input: z.infer<typeof searchInput>) {
  const { brief } = input;
  const values = input.queries ?? [
    `${brief.screen_type} ${brief.layout}`,
    `${brief.screen_type} ${brief.components.slice(0, 4).join(" ")}`,
    `${brief.screen_type} ${input.focus.includes("style") ? (brief.style ?? brief.layout) : (brief.interaction_goal ?? brief.layout)}`,
  ];
  const unique = new Map<string, string>();
  for (const value of values) {
    const query = value.replace(/\s+/g, " ").trim().slice(0, 500);
    unique.set(query.toLowerCase(), query);
  }
  return [...unique.values()];
}

/** No inference model, image embedding service, or external AI provider. */
export class VisualSearch {
  private sources = new Map<string, Source>();
  private searches = new Map<string, Search>();
  private previews = new Map<string, Promise<Preview>>();
  private imageRoot: string;
  private now: () => number;

  constructor(
    private client: MobbinApiClient,
    options: { imageRoot?: string; now?: () => number } = {},
  ) {
    this.imageRoot = path.resolve(
      options.imageRoot ?? process.env.MOBBIN_IMAGE_IMPORT_ROOT ?? homedir(),
    );
    this.now = options.now ?? Date.now;
  }

  private expire() {
    for (const [id, source] of this.sources)
      if (Date.parse(source.expires_at) <= this.now()) this.sources.delete(id);
    for (const [id, search] of this.searches)
      if (Date.parse(search.expires_at) <= this.now() || !this.sources.has(search.source_id))
        this.searches.delete(id);
  }

  private source(id: string) {
    this.expire();
    const source = this.sources.get(id);
    if (!source)
      throw Error(
        "Visual source expired or belongs to another server session. Prepare the screenshot again.",
      );
    return source;
  }

  private async preview(buffer: Buffer): Promise<Preview> {
    if (!buffer.length || buffer.length > MAX_BYTES)
      throw Error("Screenshot must be between 1 byte and 20 MiB.");
    const image = sharp(buffer, { limitInputPixels: 24_000_000, failOn: "error" });
    const metadata = await image.metadata();
    if (!["png", "jpeg", "webp", "avif", "gif"].includes(metadata.format ?? ""))
      throw Error("Use a PNG, JPEG, WebP, AVIF, or GIF screenshot, not a document or vector file.");
    if (!metadata.width || !metadata.height || metadata.width < 64 || metadata.height < 64)
      throw Error("Screenshot dimensions are too small for a useful comparison.");
    const { data, info } = await image
      .rotate()
      .resize({ width: 1200, height: 1800, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    return {
      data: data.toString("base64"),
      mimeType: "image/webp",
      width: info.width,
      height: info.height,
    };
  }

  async prepare(input: z.input<typeof sourceInput>) {
    const data = sourceInput.parse(input);
    const provided = [
      data.image_path,
      data.image_base64,
      data.mobbin_image_url,
      data.attachment_label,
    ].filter((value) => value !== undefined);
    if (provided.length !== 1)
      throw Error(
        "Supply exactly one screenshot source: image_path, image_base64, mobbin_image_url, or attachment_label.",
      );
    let buffer: Buffer | undefined;
    let kind: Source["kind"] = "conversation_attachment";
    if (data.image_path) {
      if (!path.isAbsolute(data.image_path)) throw Error("image_path must be absolute.");
      const root = await realpath(this.imageRoot);
      const filename = await realpath(data.image_path);
      const relative = path.relative(root, filename);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw Error(
          "Screenshot is outside MOBBIN_IMAGE_IMPORT_ROOT (defaults to the user's home directory).",
        );
      const handle = await open(
        filename,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > MAX_BYTES)
          throw Error("Use a regular image file of at most 20 MiB.");
        // Bound the read even if a file grows after stat().
        const bytes = Buffer.alloc(Math.min(stats.size + 1, MAX_BYTES + 1));
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        buffer = bytes.subarray(0, offset);
      } finally {
        await handle.close();
      }
      kind = "local_image";
    } else if (data.image_base64) {
      if (data.image_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.image_base64))
        throw Error("image_base64 must be canonical base64 without a data URL prefix.");
      buffer = Buffer.from(data.image_base64, "base64");
      if (buffer.toString("base64") !== data.image_base64)
        throw Error("image_base64 must use canonical padding.");
      kind = "inline_image";
    } else if (data.mobbin_image_url) {
      buffer = (await this.client.fetchScreenImage(data.mobbin_image_url)).buffer;
      kind = "mobbin_image";
    }
    const preview = buffer ? await this.preview(buffer) : undefined;
    const metadata = buffer
      ? await sharp(buffer, { limitInputPixels: 24_000_000 }).metadata()
      : undefined;
    const source: Source = {
      id: randomUUID(),
      kind,
      label: data.attachment_label ?? "Source screenshot",
      ...(buffer
        ? {
            sha256: createHash("sha256").update(buffer).digest("hex"),
            original_width: metadata!.width,
            original_height: metadata!.height,
            preview,
          }
        : {}),
      expires_at: new Date(this.now() + TTL_MS).toISOString(),
    };
    this.expire();
    insertBounded(this.sources, source.id, source, 12);
    return { source: this.publicSource(source), preview };
  }

  private publicSource(source: Source) {
    const { preview, ...metadata } = source;
    return { ...metadata, source_image_in_packet: Boolean(preview) };
  }

  async search(input: z.input<typeof searchInput>) {
    const data = searchInput.parse(input);
    const source = this.source(data.source_id);
    if (data.content_type === "sections" && data.platform !== "web")
      throw Error("Website section references require platform=web.");
    const queries = visualQueries(data);
    const responses = await Promise.allSettled(
      queries.map(async (query) => {
        if (data.content_type === "sections") {
          const result = await this.client.searchSections({ query, pageSize: data.max_candidates });
          return result.value.data.map((section) => ({
            id: section.id,
            content_type: "sections" as const,
            product: section.siteName,
            platform: "web",
            image_url: section.imageUrl,
            source_url: `https://mobbin.com/sites/sections/${section.id}`,
            patterns: section.page_and_section_patterns,
            elements: [] as string[],
            retrieved_by: [query],
          }));
        }
        const result = await this.client.searchScreens({
          platform: data.platform,
          query,
          mode: "standard",
          pageSize: data.max_candidates,
        });
        return result.value.data.map((screen) => ({
          id: screen.id,
          content_type: "screens" as const,
          product: screen.appName,
          platform: screen.platform,
          image_url: screen.screenUrl,
          source_url: `https://mobbin.com/explore/screens/${screen.id}`,
          patterns: screen.screenPatterns,
          elements: screen.screenElements,
          retrieved_by: [query],
        }));
      }),
    );
    const errors: Search["search_errors"] = [];
    const batches = responses.map((response, index) => {
      if (response.status === "fulfilled") return response.value;
      errors.push({
        query: queries[index],
        error: "This Mobbin search failed. Other queries may still have returned references.",
      });
      return [];
    });
    if (errors.length === queries.length)
      throw Error(
        "All visual-reference retrieval queries failed. Check the Mobbin session and try a simpler query. No visual ranking was performed.",
      );
    const unique = new Map<string, VisualCandidate>();
    // Interleave queries for diversity; ordering here is retrieval order, never a visual score.
    for (let row = 0; row < data.max_candidates; row++)
      for (const batch of batches) {
        const candidate = batch[row];
        if (!candidate?.image_url) continue;
        const previous = unique.get(candidate.id);
        if (previous)
          previous.retrieved_by = [
            ...new Set([...previous.retrieved_by, ...candidate.retrieved_by]),
          ];
        else if (unique.size < data.max_candidates) unique.set(candidate.id, candidate);
      }
    // The source may have expired while network retrieval was in flight.
    this.source(source.id);
    const search: Search = {
      id: randomUUID(),
      source_id: source.id,
      brief: data.brief,
      focus: data.focus,
      queries,
      candidates: [...unique.values()],
      search_errors: errors,
      expires_at: source.expires_at,
    };
    insertBounded(this.searches, search.id, search, 24);
    return {
      ...search,
      ranking: "unranked_retrieval" as const,
      analysis_provider: "calling_agent" as const,
    };
  }

  private async candidatePreview(url: string) {
    let pending = this.previews.get(url);
    if (!pending) {
      pending = this.client.fetchScreenImage(url).then((image) => this.preview(image.buffer));
      insertBounded(this.previews, url, pending, 64);
    }
    try {
      return await pending;
    } catch (error) {
      this.previews.delete(url);
      throw error;
    }
  }

  async comparison(searchId: string, ids: string[]) {
    this.expire();
    const search = this.searches.get(searchId);
    if (!search)
      throw Error(
        "Visual search expired or belongs to another server session. Prepare and search again.",
      );
    const source = this.source(search.source_id);
    if (!ids.length || ids.length > 4 || new Set(ids).size !== ids.length)
      throw Error("Request one to four distinct candidate IDs per comparison.");
    const selected = ids.map((id) => {
      const candidate = search.candidates.find((c) => c.id === id);
      if (!candidate) throw Error("Candidate does not belong to this visual search.");
      return candidate;
    });
    const images = await Promise.allSettled(
      selected.map((candidate) => this.candidatePreview(candidate.image_url)),
    );
    this.source(source.id);
    return {
      source: this.publicSource(source),
      source_preview: source.preview,
      focus: search.focus,
      brief: search.brief,
      candidates: selected.map((candidate, index) => {
        const result = images[index];
        return result.status === "fulfilled"
          ? { ...candidate, image_returned: true as const, preview: result.value }
          : {
              ...candidate,
              image_returned: false as const,
              error: "Image unavailable. Do not rank this candidate visually.",
            };
      }),
    };
  }
}
