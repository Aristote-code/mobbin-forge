import sharp from "sharp";
import { z } from "zod";
import {
  MOBBIN_BASE_URL,
  ALLOWED_IMAGE_HOSTS,
  MAX_IMAGE_SIZE_BYTES,
  IMAGE_FETCH_TIMEOUT_MS,
  BYTESCALE_CDN_BASE,
  SUPABASE_STORAGE_PREFIX,
  DEFAULT_PAGE_SIZE,
  DEFAULT_PAGE_INDEX,
  COLOR_SAMPLE_SIZE,
  COLOR_QUANTIZE_STEP,
  COLOR_QUANTIZE_MAX,
} from "../constants.js";
import {
  searchAppsResponseSchema,
  searchScreensResponseSchema,
  searchFlowsResponseSchema,
  autocompleteResponseSchema,
  searchableAppsResponseSchema,
  popularAppsResponseSchema,
  collectionsResponseSchema,
  collectionContentsResponseSchema,
  filterTagCatalogsResponseSchema,
  appPagePayloadSchema,
  appPageScreenSchema,
  flowResultSchema,
} from "./schemas.js";
import type { MobbinAuth } from "./auth.js";
import type {
  AppResult,
  ScreenResult,
  FlowResult,
  Collection,
  CollectionItem,
  CollectionCursor,
  SearchableApp,
  PopularAppEntry,
  AutocompleteResponse,
  DictionaryCategory,
  ContentSearchResponse,
  ValueResponse,
  AppPageScreen,
} from "../types.js";

/**
 * HTTP client for Mobbin's internal Next.js API routes.
 *
 * Mobbin has no public API — these endpoints were reverse-engineered via Playwright.
 * Auth is handled via {@link MobbinAuth}, which manages the Supabase session cookie
 * and automatically refreshes tokens before they expire.
 *
 * All endpoints live at `https://mobbin.com/api/...` and proxy to Supabase server-side.
 */
export class MobbinApiClient {
  private auth: MobbinAuth;
  private originalUrls = new Map<string, Promise<string | null>>();

  constructor(auth: MobbinAuth) {
    this.auth = auth;
  }

  /**
   * Make an authenticated request to a Mobbin API route and validate the response against a zod schema.
   *
   * On validation failure the thrown error names the request path AND each failing field
   * (e.g. `value.data[0].screenPatterns: Required`) so shape drift surfaces at the boundary
   * instead of crashing several layers later in a formatter.
   */
  private async request<S extends z.ZodTypeAny>(
    path: string,
    schema: S,
    options: { method?: string; body?: unknown } = {},
  ): Promise<z.infer<S>> {
    const { method = "GET", body } = options;
    const cookie = await this.auth.getCookieValue();

    const headers: Record<string, string> = {
      Cookie: cookie,
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${MOBBIN_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Mobbin API error: ${res.status} ${res.statusText} - ${path}${text ? `: ${text.substring(0, 200)}` : ""}`,
      );
    }

    const json = await res.json();
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => {
          const issuePath = issue.path.length ? issue.path.join(".") : "(root)";
          return `  ${issuePath}: ${issue.message}`;
        })
        .join("\n");
      throw new Error(`Mobbin API response failed validation for ${path}:\n${issues}`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  /**
   * Search and browse apps with category filtering and pagination.
   *
   * Endpoint: `POST /api/search/fetch-search-page-apps` — replaces the dead
   * `/api/content/search-apps` (404 as of 2026-08-28; Mobbin renamed the whole
   * `/api/content/search-*` family to `/api/search/fetch-search-page-*` and swapped
   * the `filterOptions`/`paginationOptions` envelope for a single `searchQuery`
   * object). `categories` takes display-name strings (e.g. "AI"), not category IDs —
   * confirmed via probe: an ID filter silently matches zero rows. The route also
   * rejects `sortBy: "trending"` (400) — apps only accept `"publishedAt"`, which
   * matches the `mobbin_search_apps` tool's own sort enum, so this never sends it.
   * Every `searchQuery` field must be present (use `null` for "no filter") — an
   * omitted field triggers an empty-body 400.
   */
  async searchApps(params: {
    platform: string;
    appCategories?: string[];
    pageSize?: number;
    pageIndex?: number;
    sortBy?: string;
  }): Promise<ContentSearchResponse<AppResult>> {
    return this.request("/api/search/fetch-search-page-apps", searchAppsResponseSchema, {
      method: "POST",
      body: {
        searchRequestId: "",
        pageIndex: params.pageIndex ?? DEFAULT_PAGE_INDEX,
        pageSize: params.pageSize ?? DEFAULT_PAGE_SIZE,
        searchQuery: {
          platform: params.platform,
          type: "filters",
          categories: params.appCategories ?? null,
          sortBy: params.sortBy ?? "publishedAt",
        },
      },
    });
  }

  /**
   * Search screens across all apps by patterns, elements, or OCR keywords.
   *
   * Endpoint: `POST /api/search/fetch-search-page-screens` — replaces the dead
   * `/api/content/search-screens` (404 as of 2026-08-28), same route-family rename
   * as {@link searchApps}. `categories` takes display-name strings, not IDs (see
   * {@link searchApps}). `hasAnimation` only accepts `null` or `true` — the API
   * 400s on a literal `false`, so there's no way to request "non-animated only";
   * `false`/`undefined` are both treated as "no filter" (`null`). Every
   * `searchQuery` field must be present, `null` where unset, or the route 400s.
   * `screenKeywords` has no array equivalent on the new route — OCR text search
   * moved to `textInScreenshotQuery` (a single string), so the array is joined with
   * spaces (confirmed via probe: a space-joined multi-word query filters correctly).
   */
  async searchScreens(params: {
    platform: string;
    screenPatterns?: string[];
    screenElements?: string[];
    screenKeywords?: string[];
    appCategories?: string[];
    hasAnimation?: boolean;
    pageSize?: number;
    pageIndex?: number;
    sortBy?: string;
  }): Promise<ContentSearchResponse<ScreenResult>> {
    return this.request("/api/search/fetch-search-page-screens", searchScreensResponseSchema, {
      method: "POST",
      body: {
        searchRequestId: "",
        pageIndex: params.pageIndex ?? DEFAULT_PAGE_INDEX,
        pageSize: params.pageSize ?? DEFAULT_PAGE_SIZE,
        searchQuery: {
          platform: params.platform,
          type: "filters",
          categories: params.appCategories ?? null,
          screenElements: params.screenElements ?? null,
          screenPatterns: params.screenPatterns ?? null,
          textInScreenshotQuery: params.screenKeywords?.length
            ? params.screenKeywords.join(" ")
            : null,
          hasAnimation: params.hasAnimation ? true : null,
          sortBy: params.sortBy ?? "trending",
        },
      },
    });
  }

  /**
   * Search user flows/journeys by action type (e.g., "Creating Account").
   *
   * Endpoint: `POST /api/search/fetch-search-page-flows` — replaces the dead
   * `/api/content/search-flows` (404 as of 2026-08-28), same route-family rename
   * as {@link searchApps}. `flowActions`/`categories` take display-name strings,
   * not IDs (see {@link searchApps}). Every `searchQuery` field must be present,
   * `null` where unset, or the route 400s.
   */
  async searchFlows(params: {
    platform: string;
    flowActions?: string[];
    appCategories?: string[];
    pageSize?: number;
    pageIndex?: number;
    sortBy?: string;
  }): Promise<ContentSearchResponse<FlowResult>> {
    return this.request("/api/search/fetch-search-page-flows", searchFlowsResponseSchema, {
      method: "POST",
      body: {
        searchRequestId: "",
        pageIndex: params.pageIndex ?? DEFAULT_PAGE_INDEX,
        pageSize: params.pageSize ?? DEFAULT_PAGE_SIZE,
        searchQuery: {
          platform: params.platform,
          type: "filters",
          categories: params.appCategories ?? null,
          flowActions: params.flowActions ?? null,
          sortBy: params.sortBy ?? "trending",
        },
      },
    });
  }

  /**
   * Fast autocomplete search — returns matching IDs grouped by relevance.
   * Results contain only IDs; cross-reference with {@link getSearchableApps} for full details.
   * Endpoint: `POST /api/search-bar/fetch-suggestions` — replaces the dead
   * `/api/search-bar/search` (404 as of 2026-11-12). Same request body and
   * response envelope; only the path changed.
   */
  async autocompleteSearch(params: {
    query: string;
    experience?: string;
    platform?: string;
  }): Promise<AutocompleteResponse> {
    return this.request("/api/search-bar/fetch-suggestions", autocompleteResponseSchema, {
      method: "POST",
      body: {
        query: params.query,
        experience: params.experience ?? "apps",
        platform: params.platform ?? "ios",
      },
    });
  }

  /**
   * Fetch the full list of apps for a platform (used for autocomplete cross-referencing).
   * This is a large response (~1000+ apps); results are cached by the Mobbin client.
   *
   * Endpoint: `POST /api/search-bar/fetch-searchable-apps` — replaces the dead
   * `GET /api/searchable-apps/{platform}` (404 as of 2026-08-28). Same `{ value: T[] }`
   * envelope as before; only the method/path/body shape changed.
   */
  async getSearchableApps(platform: string): Promise<SearchableApp[]> {
    const response = await this.request(
      "/api/search-bar/fetch-searchable-apps",
      searchableAppsResponseSchema,
      { method: "POST", body: { platform } },
    );
    return response.value;
  }

  /**
   * Get popular apps grouped by category with preview screenshots.
   * Endpoint: `POST /api/popular-apps/fetch-popular-apps-with-preview-screens`
   */
  async getPopularApps(params: {
    platform: string;
    limitPerCategory?: number;
  }): Promise<Record<string, PopularAppEntry[]>> {
    const response = await this.request(
      "/api/popular-apps/fetch-popular-apps-with-preview-screens",
      popularAppsResponseSchema,
      {
        method: "POST",
        body: {
          platform: params.platform,
          limitPerCategory: params.limitPerCategory ?? 10,
        },
      },
    );
    return response.value;
  }

  /**
   * Fetch the authenticated user's saved collections with item counts.
   * Endpoint: `POST /api/collection/fetch-collections`
   */
  async getCollections(): Promise<ValueResponse<Collection[]>> {
    return this.request("/api/collection/fetch-collections", collectionsResponseSchema, {
      method: "POST",
    });
  }

  /**
   * Fetch one page of items inside a saved collection.
   *
   * Mobbin's web client buckets collection contents along two axes — `contentType`
   * ({apps, screens, flows, sites, sections}) and `platformType` ({mobile, web}) —
   * and pages each bucket independently using a keyset cursor. Pass `cursor: null`
   * for the first page; for subsequent pages echo back the `nextCursor` returned
   * by the previous call. Last-page detection: `nextCursor === null` (a short
   * page).
   *
   * Errors come back as HTTP 200 with a server-side `{ error: { message } }`
   * payload (e.g. unknown `collectionId` → "query error"); we promote those to
   * thrown errors here so callers don't silently see an empty list.
   *
   * Endpoint: `POST /collections/api/fetch-collection-contents`
   */
  async getCollectionContents(params: {
    collectionId: string;
    contentType: "apps" | "screens" | "flows";
    platformType: "mobile" | "web";
    pageSize?: number;
    cursor?: CollectionCursor | null;
  }): Promise<{ items: CollectionItem[]; nextCursor: CollectionCursor | null }> {
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const result = await this.request(
      "/collections/api/fetch-collection-contents",
      collectionContentsResponseSchema,
      {
        method: "POST",
        body: {
          collectionId: params.collectionId,
          contentType: params.contentType,
          platformType: params.platformType,
          paginationOptions: {
            keysetPagination: params.cursor ?? {},
            pageSize,
          },
        },
      },
    );

    if (result.error) {
      throw new Error(
        `Mobbin collection-contents error (${result.error.code ?? "unknown"}): ${result.error.message}`,
      );
    }
    if (!result.value) {
      throw new Error("Mobbin collection-contents returned neither value nor error.");
    }

    const items = result.value.data;
    const last = items[items.length - 1];
    // The web client treats "page is full" as "there might be more". Apply the
    // same rule so we never report exhausted when there's an exact-multiple boundary.
    const nextCursor =
      items.length === pageSize && last
        ? { lastCreatedAt: last.created_at, lastId: last.id }
        : null;
    return { items, nextCursor };
  }

  /**
   * Fetch the full filter taxonomy — all app categories, screen patterns,
   * UI elements, and flow actions with definitions and content counts.
   *
   * Endpoint: `POST /api/filter-tags/fetch-filter-tag-catalogs` — replaces the dead
   * `/api/filter-tags/fetch-dictionary-definitions` (404 as of 2026-08-28). The new
   * route's response shape is unrelated to the old one (grouped by experience then
   * facet key, each facet an array of `{ id, displayName, tags }` groups — see
   * {@link filterTagCatalogsResponseSchema}), so this method reshapes it into the
   * legacy `DictionaryCategory[]` the rest of the app (and `mobbin_get_filters`'s
   * `KIND_MATCHERS` substring matching on `slug`) already expects, rather than
   * changing every downstream consumer.
   */
  async getDictionaryDefinitions(): Promise<ValueResponse<DictionaryCategory[]>> {
    const raw = await this.request(
      "/api/filter-tags/fetch-filter-tag-catalogs",
      filterTagCatalogsResponseSchema,
      { method: "POST", body: {} },
    );

    const facetKeys = ["appCategories", "screenPatterns", "screenElements", "flowActions"] as const;
    const categories: DictionaryCategory[] = [];
    for (const experience of ["mobile", "web"] as const) {
      for (const facetKey of facetKeys) {
        const groups = raw.value[experience][facetKey];
        categories.push({
          slug: facetKey,
          displayName: facetKey,
          experience,
          subCategories: groups.map((group) => ({
            displayName: group.displayName,
            entries: group.tags.map((tag) => ({
              ...tag,
              definition: tag.definition ?? "",
              contentCounts: tag.contentCounts ?? null,
            })),
          })),
        });
      }
    }

    return { value: categories };
  }

  /**
   * Fetch the SSR'd app-detail page for an app and return its embedded
   * flows + screens. Mobbin's `/api/content/search-screens` and
   * `/api/content/search-flows` ignore per-app filters silently — confirmed
   * via probe — so the only authoritative per-app source is the HTML page
   * at `/apps/{slug}-{platform}-{appId}/{versionId}/screens`. The page renders via
   * Next.js Server Components and inlines the structured data inside
   * `self.__next_f.push([1, "..."])` flight chunks; we concatenate the
   * chunks, locate the `[{"value":[...]}, ...]` payload, and parse it.
   *
   * Slug derivation: looked up via `getSearchableApps`, kebab-cased.
   * AppVersionId is REQUIRED — we resolve it via a 307 redirect from the canonical app URL.
   *
   * Endpoint: `GET /apps/{slug}-{platform}-{appId}/{versionId}/screens`
   */
  async getAppPage(params: { appId: string; platform: string }): Promise<{
    flows: FlowResult[];
    screens: AppPageScreen[];
    appName: string;
    slug: string;
    totalScreens: number;
    restrictedScreens: number;
    availableScreens: number;
  }> {
    // The canonical app URL only needs the shape `{anything}-{platform}-{appId}`:
    // Mobbin's 307 redirect ignores the name segment entirely (verified 2026-11-12
    // against a deliberately wrong name), so we no longer depend on the dead
    // `/api/search-bar/fetch-searchable-apps` route just to learn the app's name.
    const slug = `app-${params.platform}-${params.appId}`;
    const cookie = await this.auth.getCookieValue();

    // STEP 1: Resolve appVersionId via 307 redirect
    const canonicalPath = `/apps/${slug}`;
    const redirectRes = await fetch(`${MOBBIN_BASE_URL}${canonicalPath}`, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });

    let versionId: string | null = null;
    if (redirectRes.status === 307) {
      const location = redirectRes.headers.get("location");
      if (location) {
        const versionMatch = location.match(
          /\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\//,
        );
        if (versionMatch) {
          versionId = versionMatch[1];
        }
      }
    }

    // Fallback to /_/ if versionId not found (legacy behavior, likely wrong screens)
    const path = versionId ? `/apps/${slug}/${versionId}/screens` : `/apps/${slug}/_/screens`;

    if (!versionId) {
      console.warn(
        `[getAppPage] Could not resolve appVersionId for ${slug} — falling back to /_/ (screens may be incorrect)`,
      );
    }

    const res = await fetch(`${MOBBIN_BASE_URL}${path}`, {
      headers: {
        Cookie: cookie,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`Mobbin app page fetch failed: ${res.status} ${res.statusText} - ${path}`);
    }
    const html = await res.text();

    const payload = extractAppPagePayload(html, path, versionId);
    const flows = z.array(flowResultSchema).parse(payload[0].value);
    const screens = z.array(appPageScreenSchema).parse(payload[1].value);
    // App name now comes from the page itself (e.g. "<title>Duolingo iOS | Mobbin</title>")
    // rather than from the removed searchable-apps lookup.
    const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
    const appName = titleMatch
      ? titleMatch[1]
          .replace(/\s*\|\s*Mobbin.*$/i, "")
          .replace(/\s+(iOS|Android|Web)$/i, "")
          .trim() || params.appId
      : params.appId;
    const restrictedCount = screens.filter((sc) => sc.restricted === true).length;
    return {
      flows,
      screens,
      appName,
      slug,
      totalScreens: screens.length,
      restrictedScreens: restrictedCount,
      availableScreens: screens.length - restrictedCount,
    };
  }

  /**
   * Convert a Supabase storage URL to its Bytescale CDN equivalent.
   * Supabase storage URLs are not directly accessible — images are served via CDN.
   *
   * Input:  https://ujasntkfphywizsdaapi.supabase.co/storage/v1/object/public/content/app_screens/{uuid}.png
   * Output: https://bytescale.mobbin.com/FW25bBB/image/mobbin.com/prod/content/app_screens/{uuid}.png?f=webp&w=1920&q=85&fit=shrink-cover
   */
  private toCdnUrl(imageUrl: string): string {
    const parsed = new URL(imageUrl);

    // Already a CDN URL — use as-is
    if (parsed.hostname === "bytescale.mobbin.com") {
      return imageUrl;
    }

    // Convert Supabase storage URL to CDN URL
    const storageIdx = parsed.pathname.indexOf(SUPABASE_STORAGE_PREFIX);
    if (storageIdx === -1) {
      throw new Error(`Unrecognized Supabase URL format: ${imageUrl}`);
    }

    const storagePath = parsed.pathname.slice(storageIdx + SUPABASE_STORAGE_PREFIX.length);
    return `${BYTESCALE_CDN_BASE}/${storagePath}?f=webp&w=1920&q=85&fit=shrink-cover`;
  }

  /** Resolve opaque previews using the same public CDN lookup as ScreenClear. */
  private async resolveOriginalUrl(imageUrl: string): Promise<string | null> {
    const url = new URL(imageUrl);
    if (!url.searchParams.has("enc") || !/^\/[^/]+\/image\//.test(url.pathname)) return null;
    const cached = this.originalUrls.get(imageUrl);
    if (cached) return cached;

    const lookup = (async () => {
      const raw = new URL(url);
      raw.pathname = raw.pathname.replace(/^(\/[^/]+)\/image\//, "$1/raw/");
      try {
        const res = await fetch(raw, {
          redirect: "error",
          signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
        });
        if (!res.headers.get("content-type")?.includes("json")) {
          await res.body?.cancel();
          return null;
        }
        const payload = await res.json();
        const path = payload?.error?.details?.filePathNotFound;
        if (
          payload?.error?.code !== "file_not_found" ||
          typeof path !== "string" ||
          !/^\/mobbin\.com\/prod\/content\/app_screens\/[0-9a-f-]+\.(?:png|jpe?g|webp)$/i.test(path)
        )
          return null;
        url.pathname = `/${url.pathname.split("/")[1]}/image${path}`;
        url.search = new URLSearchParams({
          f: "webp",
          w: "1920",
          q: "85",
          fit: "shrink-cover",
        }).toString();
        url.hash = "";
        return url.href;
      } catch {
        return null;
      }
    })();
    // Bound memory and deduplicate simultaneous requests for the same preview.
    if (this.originalUrls.size >= 512)
      this.originalUrls.delete(this.originalUrls.keys().next().value!);
    this.originalUrls.set(imageUrl, lookup);
    const result = await lookup;
    if (!result) this.originalUrls.delete(imageUrl);
    return result;
  }

  /**
   * Fetch a screen image from its URL and return it as base64.
   * Automatically converts Supabase storage URLs to Bytescale CDN URLs.
   * No authentication required — these are public CDN assets.
   */
  async fetchScreenImage(imageUrl: string): Promise<{
    base64: string;
    mimeType: string;
    sizeBytes: number;
    buffer: Buffer;
    resolvedUrl: string;
    width: number;
    height: number;
  }> {
    const parsed = new URL(imageUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !ALLOWED_IMAGE_HOSTS.includes(parsed.hostname)
    ) {
      throw new Error(
        `Untrusted image host: ${parsed.hostname}. Only Supabase storage and Bytescale CDN URLs are supported.`,
      );
    }

    const cdnUrl = this.toCdnUrl(imageUrl);
    const originalUrl = await this.resolveOriginalUrl(cdnUrl);
    if (originalUrl) {
      try {
        return await this.downloadScreenImage(originalUrl);
      } catch {
        // A stale discovered path must not break an otherwise usable preview.
        this.originalUrls.delete(cdnUrl);
      }
    }
    return this.downloadScreenImage(cdnUrl);
  }

  private async downloadScreenImage(fetchUrl: string) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(fetchUrl, { signal: controller.signal, redirect: "error" });

      if (!res.ok) {
        throw new Error(`Failed to fetch image: ${res.status} ${res.statusText} — ${fetchUrl}`);
      }

      const contentLength = res.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_SIZE_BYTES) {
        throw new Error(
          `Image too large (${contentLength} bytes). Max: ${MAX_IMAGE_SIZE_BYTES} bytes.`,
        );
      }

      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > MAX_IMAGE_SIZE_BYTES) {
        throw new Error(
          `Image too large (${buffer.byteLength} bytes). Max: ${MAX_IMAGE_SIZE_BYTES} bytes.`,
        );
      }

      const image = await sharp(Buffer.from(buffer)).metadata();
      if (!image.width || !image.height || (image.width <= 32 && image.height <= 64)) {
        throw new Error(
          "Mobbin returned a tiny preview instead of a full screenshot; the original image could not be resolved.",
        );
      }
      const mimeType = image.format === "jpeg" ? "image/jpeg" : `image/${image.format}`;

      const base64 = Buffer.from(buffer).toString("base64");
      return {
        base64,
        mimeType,
        sizeBytes: buffer.byteLength,
        buffer: Buffer.from(buffer),
        resolvedUrl: fetchUrl,
        width: image.width,
        height: image.height,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Extract dominant colors from a screen image buffer.
   * Returns an array of hex color strings sorted by frequency.
   */
  async extractColors(imageBuffer: Buffer, maxColors: number = 8): Promise<string[]> {
    // Resize to small thumbnail for faster color sampling
    const { data } = await sharp(imageBuffer)
      .resize(COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE, { fit: "cover" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Count pixel colors, quantized to reduce noise (round to nearest step)
    const colorCounts = new Map<string, number>();
    for (let i = 0; i < data.length; i += 3) {
      const r = Math.min(
        Math.round(data[i] / COLOR_QUANTIZE_STEP) * COLOR_QUANTIZE_STEP,
        COLOR_QUANTIZE_MAX,
      );
      const g = Math.min(
        Math.round(data[i + 1] / COLOR_QUANTIZE_STEP) * COLOR_QUANTIZE_STEP,
        COLOR_QUANTIZE_MAX,
      );
      const b = Math.min(
        Math.round(data[i + 2] / COLOR_QUANTIZE_STEP) * COLOR_QUANTIZE_STEP,
        COLOR_QUANTIZE_MAX,
      );
      const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
      colorCounts.set(hex, (colorCounts.get(hex) || 0) + 1);
    }

    // Sort by frequency and return top colors
    return Array.from(colorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxColors)
      .map(([hex]) => hex);
  }
}

/**
 * Extract screen URLs from Mobbin's SSR'd app-detail HTML. The page streams data via
 * `self.__next_f.push([1, "<chunk>"])` calls. We concatenate chunks, then extract
 * all screenUrl paths (content/app_screens/{uuid}.png) via regex and reconstruct
 * full Supabase URLs.
 *
 * Fallback approach: the structured JSON payload format changed, but screenUrls
 * are still present as strings in the flight stream. Verified 2026-07-14 on ChatGPT
 * (20 screens found).
 *
 * Path is passed in for error attribution.
 */
function extractAppPagePayload(
  html: string,
  path: string,
  versionId?: string | null,
): z.infer<typeof appPagePayloadSchema> {
  const chunkRe = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\s*\]\)/g;
  let stream = "";
  let m: RegExpExecArray | null;
  while ((m = chunkRe.exec(html)) !== null) {
    try {
      stream += JSON.parse(`"${m[1]}"`) as string;
    } catch {
      // Skip malformed chunks — partial streams happen near end-of-document.
    }
  }

  // --- Current SSR shape (verified 2026-11-12) ---
  // Mobbin moved this data out of the `{"value":{"partialFlows":...}}` dataPromise
  // chunk and into plain component props:
  //   {"appSlug":"...","appVersionId":"<ver>","paywalled":true,"screens":[ ... ]}
  // with `partialFlows` living in a different component further down the stream.
  // Anchoring on the props object that carries OUR appVersionId guarantees we never
  // pick up a recommended app's screens (the old naked-regex fallback did exactly that).
  {
    const anchor = versionId
      ? stream.indexOf(`"appVersionId":"${versionId}","paywalled"`)
      : stream.indexOf('"paywalled"');
    const screensRaw = anchor !== -1 ? arrayAfterKey(stream, "screens", anchor) : null;
    if (screensRaw) {
      try {
        const all = JSON.parse(screensRaw) as Array<Record<string, unknown>>;
        if (all.length > 0) {
          // Keep every screen and its original preview URL. Full-size images
          // are resolved lazily by fetchScreenImage, including restricted previews.
          const structured = all;
          const restrictedCount = all.filter((sc) => sc.restricted === true).length;

          const byId = new Map<string, Record<string, unknown>>();
          for (const sc of structured) {
            const id = sc.id as string | undefined;
            if (id) byId.set(id, sc);
          }

          const flowsRaw = arrayAfterKey(stream, "partialFlows", 0);
          const partialFlows = flowsRaw
            ? (JSON.parse(flowsRaw) as Array<Record<string, unknown>>)
            : [];
          const flows = partialFlows.map((fl) => {
            const flowScreens = ((fl.screens as Array<Record<string, unknown>>) ?? [])
              .map((fs) => {
                const full = byId.get(fs.screenId as string);
                if (!full) return null;
                // Preserve the preview URL so fetchScreenImage can resolve its original.
                const locked = full.restricted === true;
                return {
                  ...fs,
                  screenUrl: (full.screenUrl as string) ?? "",
                  restricted: locked,
                  width: (full.width as number) ?? 0,
                  height: (full.height as number) ?? 0,
                };
              })
              .filter((x) => x !== null);
            const videoSources = fl.videoCdnVideoSources as Array<{ url?: string }> | undefined;
            return { ...fl, videoUrl: videoSources?.[0]?.url ?? null, screens: flowScreens };
          });

          return [
            { value: flows },
            { value: structured },
            { value: { totalScreens: all.length, restrictedScreens: restrictedCount } },
          ];
        }
      } catch {
        // Fall through to the legacy paths below.
      }
    }
  }

  // The real, un-polluted screens live in a deferred RSC dataPromise chunk shaped
  // `<ref>:[{"value":{"partialFlows":[...],"screens":[...]}}]`. `value.screens` is a
  // fully-structured array (screenUrl, width, height, screenElements, screenPatterns,
  // appVersionId, ...) scoped to the TARGET app only. The naked
  // `content/app_screens/{uuid}.png` regex used before also caught recommended-app
  // preview URLs rendered at the top of the page, returning the WRONG app's screens.
  const marker = stream.match(/[0-9a-f]+:\[\{"value":\{"partialFlows"/);
  if (marker) {
    const braceStart = stream.indexOf(":[", marker.index) + 1;
    const raw = sliceBalanced(stream, braceStart);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Array<{
          value?: {
            screens?: Array<Record<string, unknown>>;
            partialFlows?: Array<Record<string, unknown>>;
          };
        }>;
        const structured = parsed[0]?.value?.screens;
        if (Array.isArray(structured) && structured.length > 0) {
          // Index screens by id so each flow's screen refs (which carry only
          // screenId + order + hotspot) can be enriched with the real URL and
          // dimensions from the flat screens list.
          const byId = new Map<string, Record<string, unknown>>();
          for (const s of structured) {
            const id = s.id as string | undefined;
            if (id) byId.set(id, s);
          }

          const partialFlows = parsed[0]?.value?.partialFlows ?? [];
          const flows = partialFlows.map((f) => {
            const flowScreens = ((f.screens as Array<Record<string, unknown>>) ?? []).map((fs) => {
              const full = byId.get(fs.screenId as string) ?? {};
              return {
                ...fs,
                screenUrl: (full.screenUrl as string) ?? "",
                width: (full.width as number) ?? 0,
                height: (full.height as number) ?? 0,
              };
            });
            // Flows expose clips via videoCdnVideoSources, not a flat videoUrl.
            const videoSources = f.videoCdnVideoSources as Array<{ url?: string }> | undefined;
            return {
              ...f,
              videoUrl: videoSources?.[0]?.url ?? null,
              screens: flowScreens,
            };
          });

          return [{ value: flows }, { value: structured }, { value: {} }];
        }
      } catch {
        // Fall through to the regex fallback below if the chunk won't parse.
      }
    }
  }

  // Fallback: naked screenUrl regex (legacy). May include recommended-app previews,
  // so only used when the structured dataPromise chunk can't be located/parsed.
  const screenUrlRe = /content\/app_screens\/[a-f0-9-]+\.png/g;
  const screenPaths = Array.from(new Set(stream.match(screenUrlRe) || []));

  if (screenPaths.length === 0) {
    throw new Error(
      `Could not locate any screen URLs in ${path}. Mobbin may have changed its SSR format, or the slug resolved to a 404 page.`,
    );
  }

  const screens = screenPaths.map((p) => {
    const uuid = p.match(/([a-f0-9-]+)\.png$/)?.[1] || "";
    return {
      type: "screen",
      id: uuid,
      screenUrl: `https://ujasntkfphywizsdaapi.supabase.co/storage/v1/object/public/${p}`,
      createdAt: new Date().toISOString(),
      width: 0,
      height: 0,
      fullpageScreenUrl: null,
      screenElements: [],
      screenPatterns: [],
      isAppKeyScreen: false,
      appId: "",
      appName: "",
      appLogoUrl: "",
      platform: "",
      appVersionId: "",
      appVersionPublishedAt: "",
    };
  });

  return [{ value: [] }, { value: screens }, { value: {} }];
}

/**
 * Slice the JSON array that follows `"<key>":[` at or after `from`.
 * Returns null when the key isn't present.
 */
function arrayAfterKey(s: string, key: string, from: number): string | null {
  const needle = `"${key}":[`;
  const i = s.indexOf(needle, from);
  if (i === -1) return null;
  return sliceBalanced(s, i + needle.length - 1);
}

/**
 * Extract a balanced JSON array/object substring starting at `start` (which must
 * point at the opening `[` or `{`). Respects string literals and escapes so braces
 * inside strings don't throw off the depth counter. Returns null if unbalanced.
 */
function sliceBalanced(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < s.length; j++) {
    const c = s[j];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, j + 1);
    }
  }
  return null;
}
