import { MOBBIN_BASE_URL } from "../constants.js";
import type { MobbinAuth } from "./auth.js";

const allowedActions = [
  "actionCreateNewCollection",
  "actionCreateComment",
  "actionSaveContents",
  "actionSaveAndAddContentsToCollection",
] as const;
type Action = (typeof allowedActions)[number];

/** Discover the website's deployed action IDs instead of baking build-specific hashes into tools. */
export class WebsiteActions {
  private catalogs = new Map<string, Promise<Map<string, string>>>();
  constructor(private auth: MobbinAuth) {}

  private discover(action: Action, contextPath: string, cookie: string) {
    const cacheKey = `${contextPath}:${action}`;
    let pending = this.catalogs.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const response = await fetch(`${MOBBIN_BASE_URL}${contextPath}`, {
          ...(action === "actionCreateComment" ? { headers: { Cookie: cookie } } : {}),
          signal: AbortSignal.timeout(45_000),
        });
        if (!response.ok)
          throw new Error(`Could not load Mobbin's current action catalog (${response.status}).`);
        const html = await response.text();
        const urls = [
          ...new Set(
            [...html.matchAll(/<script[^>]*src="([^"]+)"/g)]
              .map((match) => new URL(match[1], MOBBIN_BASE_URL))
              .filter(
                (url) =>
                  url.origin === MOBBIN_BASE_URL && url.pathname.startsWith("/_next/static/"),
              )
              .map((url) => url.href),
          ),
        ];
        const ids = new Map<string, string>();
        // Fetch small batches so discovery does not flood the website with requests.
        for (let start = 0; start < urls.length; start += 6) {
          const chunks = await Promise.all(
            urls.slice(start, start + 6).map(async (url) => {
              const result = await fetch(url, { signal: AbortSignal.timeout(15_000) });
              if (!result.ok) return "";
              return result.text();
            }),
          );
          for (const chunk of chunks)
            for (const match of chunk.matchAll(
              /createServerReference\)\("([a-f0-9]{40,64})"[^;]{0,180}?,"(action[^" ]+)"/g,
            )) {
              if ((allowedActions as readonly string[]).includes(match[2]))
                ids.set(match[2], match[1]);
            }
          if (ids.has(action)) break;
        }
        return ids;
      })().catch((error) => {
        this.catalogs.delete(cacheKey);
        throw error;
      });
      this.catalogs.set(cacheKey, pending);
    }
    return pending;
  }

  async invoke(
    action: Action,
    input: Record<string, unknown>,
    contextPath = "/search/sites?content_type=sections",
  ): Promise<unknown> {
    if (
      !contextPath.startsWith("/") ||
      contextPath.startsWith("//") ||
      new URL(contextPath, MOBBIN_BASE_URL).origin !== MOBBIN_BASE_URL
    )
      throw new Error("Invalid action context path.");
    const cookie = await this.auth.getCookieValue();
    const id = (await this.discover(action, contextPath, cookie)).get(action);
    if (!id)
      throw new Error(
        `Mobbin no longer exposes ${action}; the website integration needs updating.`,
      );
    const response = await fetch(`${MOBBIN_BASE_URL}${contextPath}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Cookie: cookie,
        Origin: MOBBIN_BASE_URL,
        "Next-Action": id,
        Accept: "text/x-component",
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body: JSON.stringify([input]),
    });
    if (!response.ok) {
      this.catalogs.delete(`${contextPath}:${action}`);
      throw new Error(
        `Mobbin action failed (${response.status}). The write was not retried; check your account before retrying.`,
      );
    }
    return parseActionResult(await response.text());
  }
}

/** Read only JSON Flight records. No evaluation of remote JavaScript. */
export function parseActionResult(stream: string): unknown {
  const records = new Map<string, unknown>();
  for (const line of stream.split("\n")) {
    const match = line.match(/^([0-9a-f]+):(.*)$/);
    if (match)
      try {
        records.set(match[1], JSON.parse(match[2]));
      } catch {
        /* Ignore non-JSON Flight records. */
      }
  }
  const root = records.get("0") as { a?: unknown } | undefined;
  let result = root?.a;
  const seen = new Set<string>();
  while (typeof result === "string" && /^\$@?[0-9a-f]+$/.test(result)) {
    const id = result.replace(/^\$@?/, "");
    if (seen.has(id)) throw new Error("Mobbin action returned a circular result reference.");
    seen.add(id);
    result = records.get(id);
  }
  if (!result || typeof result !== "object")
    throw new Error(
      "Mobbin action returned an unreadable result. Check your account before retrying the write.",
    );
  const envelope = result as { error?: { message?: string }; value?: unknown };
  if (envelope.error)
    throw new Error(`Mobbin action: ${envelope.error.message ?? "request refused"}`);
  if (!Object.hasOwn(envelope, "value"))
    throw new Error(
      "Mobbin action did not confirm success. Check your account before retrying the write.",
    );
  return envelope.value;
}
