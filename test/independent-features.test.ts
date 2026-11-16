import { test } from "node:test";
import assert from "node:assert/strict";
import { MobbinApiClient } from "../src/services/api-client.js";
import { WebsiteActions, parseActionResult } from "../src/services/website-actions.js";

const auth = { getCookieValue: async () => "test-session" } as never;

test("standard free-text screen/flow searches use website routes and preserve pagination", async (t) => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    requests.push({ url, body: JSON.parse(options.body as string) });
    return Response.json({
      value: { searchRequestId: "continue-search", data: [], hasNextPage: false },
    });
  });
  const client = new MobbinApiClient(auth);
  await client.searchScreens({
    platform: "ios",
    query: "banking onboarding with a progress bar",
    pageIndex: 2,
    searchRequestId: "continue-search",
  });
  await client.searchFlows({ platform: "web", query: "creating an account" });
  const first = requests[0].body;
  assert.equal(first.searchRequestId, "continue-search");
  assert.equal(first.pageIndex, 0);
  assert.deepEqual(first.searchQuery, {
    type: "free_text_search",
    contentType: "screens",
    platform: "ios",
    query: "banking onboarding with a progress bar",
    mode: "standard",
    hasAnimation: null,
    textInScreenshotQuery: null,
  });
  assert.ok(requests.every((r) => r.url.startsWith("https://mobbin.com/api/search/")));
  assert.equal((requests[1].body.searchQuery as { mode: string }).mode, "standard");
});

test("website sections normalize site names, image/video sources, and next-page state", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      value: {
        searchRequestId: "sections",
        hasNextPage: false,
        data: [
          {
            id: "section-1",
            type: "page_image",
            site_version: { site: { name: "Example" } },
            cdnImgSources: { src: "https://bytescale.mobbin.com/image.webp" },
          },
        ],
      },
    }),
  );
  const result = await new MobbinApiClient(auth).searchSections({
    query: "pricing with a monthly yearly toggle",
  });
  assert.equal(result.value.data[0].siteName, "Example");
  assert.equal(result.value.data[0].imageUrl, "https://bytescale.mobbin.com/image.webp");
  assert.equal(result.value.hasNextPage, false);
});

test("HTTP-200 website refusals surface as errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { message: "unauthenticated" } }),
  );
  await assert.rejects(
    new MobbinApiClient(auth).searchSections({ query: "pricing" }),
    /unauthenticated/,
  );
});

test("website actions discover current IDs, send exact action arguments, and don't retry writes", async (t) => {
  const actions = [
    "actionCreateNewCollection",
    "actionSaveContents",
    "actionSaveAndAddContentsToCollection",
  ];
  const ids = actions.map((_, i) => String(i + 1).repeat(42));
  let writes = 0;
  let refused = false;
  t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      writes++;
      const headers = options.headers as Record<string, string>;
      assert.equal(headers.Cookie, "test-session");
      assert.equal(headers["Next-Action"], ids[0]);
      assert.deepEqual(JSON.parse(options.body as string), [
        { name: "References", description: "", isPublic: false },
      ]);
      if (refused) return new Response("Failed", { status: 500 });
      return new Response('0:{"a":"$@1"}\n1:{"value":{"id":"collection-1"}}\n');
    }
    if (String(url).includes("/_next/"))
      return new Response(
        actions
          .map(
            (name, i) =>
              `let a${i}=(0,t.createServerReference)("${ids[i]}",t.callServer,void 0,t.findSourceMapURL,"${name}");`,
          )
          .join(""),
      );
    return new Response(
      '<script src="/_next/static/chunks/actions.js"></script><script src="https://evil.test/fake.js"></script>',
    );
  });
  const client = new WebsiteActions(auth);
  assert.deepEqual(
    await client.invoke("actionCreateNewCollection", {
      name: "References",
      description: "",
      isPublic: false,
    }),
    { id: "collection-1" },
  );
  refused = true;
  await assert.rejects(
    client.invoke("actionCreateNewCollection", {
      name: "References",
      description: "",
      isPublic: false,
    }),
    /not retried/,
  );
  assert.equal(writes, 2);
});

test("action discovery finds a second action after an earlier scan stopped in another batch", async (t) => {
  const names = ["actionCreateNewCollection", "actionSaveContents"] as const;
  const ids = ["1".repeat(42), "2".repeat(42)];
  const writes: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      writes.push((options.headers as Record<string, string>)["Next-Action"]);
      return new Response('0:{"a":{"value":{"ok":true}}}');
    }
    const index = String(url).match(/chunk-(\d+)\.js/)?.[1];
    if (index !== undefined) {
      const actionIndex = Number(index) === 0 ? 0 : Number(index) === 6 ? 1 : -1;
      return new Response(
        actionIndex < 0
          ? ""
          : `let a=(0,t.createServerReference)("${ids[actionIndex]}",t.callServer,void 0,t.findSourceMapURL,"${names[actionIndex]}");`,
      );
    }
    return new Response(
      Array.from(
        { length: 7 },
        (_, i) => `<script src="/_next/static/chunk-${i}.js"></script>`,
      ).join(""),
    );
  });
  const client = new WebsiteActions(auth);
  await client.invoke(names[0], {});
  await client.invoke(names[1], {});
  assert.deepEqual(writes, ids);
});

test("action decoder follows Flight references and distinguishes success from refusal or uncertain results", () => {
  assert.deepEqual(parseActionResult('0:{"a":"$@1"}\n1:{"value":[]}'), []);
  assert.deepEqual(parseActionResult('0:{"a":{"value":{"saved":true}}}'), { saved: true });
  assert.throws(
    () => parseActionResult('0:{"a":"$@1"}\n1:{"error":{"message":"unauthorized"}}'),
    /unauthorized/,
  );
  assert.throws(() => parseActionResult('0:{"a":"$@1"}\n1:"$@1"'), /circular/);
  assert.throws(() => parseActionResult("<html>Login</html>"), /unreadable/);
});

test("All saved uses the website cursor bucket and includes sections without a collection ID", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.ok(String(url).endsWith("/saved/api/fetch-saved-page-contents"));
    assert.deepEqual(JSON.parse(options.body as string), {
      contentType: "sections",
      platformType: "sites",
      paginationOptions: {
        keysetPagination: { lastCreatedAt: "2026-01-01", lastId: "previous" },
        pageSize: 1,
      },
    });
    return Response.json({
      value: {
        data: [
          {
            id: "saved-1",
            contentType: "sections",
            created_at: "2026-01-02",
            app_id: null,
            app_screen_id: null,
            app_flow_id: null,
            site_id: null,
            site_page_section_id: "section-1",
            section: {
              id: "section-1",
              site_version: { site: { name: "Example" } },
              cdnImgSources: { src: "https://bytescale.mobbin.com/section.webp" },
            },
          },
        ],
      },
    });
  });
  const result = await new MobbinApiClient(auth).getSavedContents({
    contentType: "sections",
    platformType: "sites",
    pageSize: 1,
    cursor: { lastCreatedAt: "2026-01-01", lastId: "previous" },
  });
  assert.equal(result.items[0].section!.siteName, "Example");
  assert.deepEqual(result.nextCursor, { lastCreatedAt: "2026-01-02", lastId: "saved-1" });
});

test("account capabilities decode Flight chunks and preserve unknown access", async (t) => {
  const { extractAccountCapabilities } = await import("../src/services/api-client.js");
  const flags =
    '{"ftsDeepSearch":{"isGranted":false},"coreLibrary":{"isGranted":true},"mcp":{"isGranted":false}}';
  const html = `<script>self.__next_f.push([1,${JSON.stringify(flags.slice(0, 30))}])</script><script>self.__next_f.push([1,${JSON.stringify(flags.slice(30))}])</script>`;
  assert.deepEqual(extractAccountCapabilities(html), {
    deepSearch: false,
    coreLibrary: true,
    unlimitedCollections: null,
    officialMcp: false,
  });
  assert.equal(extractAccountCapabilities("<html>Login</html>").deepSearch, null);
  t.mock.method(globalThis, "fetch", async () => new Response(html));
  const client = new MobbinApiClient(auth);
  await assert.rejects(
    client.searchScreens({ platform: "ios", query: "login", mode: "deep" }),
    /not enabled/,
  );
});

test("plain-text comments serialize as the website's version-2 ProseMirror format without posting", async (t) => {
  let posted: Record<string, unknown> | undefined;
  t.mock.method(
    WebsiteActions.prototype,
    "invoke",
    async (action: string, input: Record<string, unknown>, context: string) => {
      assert.equal(action, "actionCreateComment");
      assert.equal(context, "/explore/screens/screen-1");
      posted = input;
      return { id: "comment-1" };
    },
  );
  const client = new MobbinApiClient(auth);
  await client.addComment({
    contentType: "screens",
    contentId: "screen-1",
    text: "  First line\n\n<plain text>  ",
  });
  assert.deepEqual(posted, {
    contentType: "screens",
    contentId: "screen-1",
    rawComment: "First line\n\n<plain text>",
    parentCommentId: null,
    comment: {
      version: 2,
      json: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "First line" }] },
          { type: "paragraph" },
          { type: "paragraph", content: [{ type: "text", text: "<plain text>" }] },
        ],
      },
    },
  });
  await assert.rejects(
    client.addComment({ contentType: "screens", contentId: "screen-1", text: "   " }),
    /empty/,
  );
});

test("MCP search pages span fixed website batches without dropping or duplicating results", async (t) => {
  const requests: number[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string);
    requests.push(body.pageIndex);
    assert.match(body.searchRequestId, /^[0-9a-f-]{36}$/);
    const all = Array.from({ length: 8 }, (_, i) => ({ id: `flow-${i}`, name: `Flow ${i}` }));
    return Response.json({
      value: {
        searchRequestId: body.searchRequestId,
        data: all.slice(body.pageIndex * 3, body.pageIndex * 3 + 3),
        hasNextPage: body.pageIndex < 2,
        totalCount: 8,
      },
    });
  });
  const client = new MobbinApiClient(auth);
  const first = await client.searchFlows({
    platform: "ios",
    query: "onboarding",
    pageSize: 4,
    pageIndex: 0,
  });
  assert.deepEqual(
    first.value.data.map((f) => f.id),
    ["flow-0", "flow-1", "flow-2", "flow-3"],
  );
  assert.equal(first.value.hasNextPage, true);
  assert.equal(first.value.totalCount, 8);
  const second = await client.searchFlows({
    platform: "ios",
    query: "onboarding",
    pageSize: 4,
    pageIndex: 1,
    searchRequestId: first.value.searchRequestId,
  });
  assert.deepEqual(
    second.value.data.map((f) => f.id),
    ["flow-4", "flow-5", "flow-6", "flow-7"],
  );
  assert.equal(second.value.hasNextPage, false);
  const end = await client.searchFlows({
    platform: "ios",
    query: "onboarding",
    pageSize: 4,
    pageIndex: 2,
    searchRequestId: first.value.searchRequestId,
  });
  assert.deepEqual(end.value.data, []);
  assert.equal(end.value.hasNextPage, false);
  assert.deepEqual(requests, [0, 1, 2]);
});

test("collection joins normalize references from their nested content instead of requiring redundant foreign keys", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      value: {
        data: [
          {
            id: "item-1",
            collection_id: "collection-1",
            contentType: "screens",
            created_at: "2026-01-01",
            screen: {
              id: "screen-1",
              appId: "app-1",
              appName: "Example",
              platform: "ios",
              screenUrl: "https://bytescale.mobbin.com/image.webp",
              width: 100,
              height: 200,
              screenPatterns: [],
              screenElements: [],
            },
          },
        ],
      },
    }),
  );
  const response = await new MobbinApiClient(auth).getCollectionContents({
    collectionId: "collection-1",
    contentType: "screens",
    platformType: "mobile",
    pageSize: 24,
  });
  assert.equal(response.items[0].app_screen_id, "screen-1");
  assert.equal(response.items[0].app_id, null);
});

test("standard pagination stops when the next advertised native batch is empty", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const request = JSON.parse(options.body as string);
    return Response.json({
      value: {
        searchRequestId: request.searchRequestId,
        data:
          request.pageIndex === 0
            ? [
                { id: "a", name: "A" },
                { id: "b", name: "B" },
                { id: "c", name: "C" },
              ]
            : [],
        hasNextPage: true,
        totalCount: 500,
      },
    });
  });
  const page = await new MobbinApiClient(auth).searchFlows({
    platform: "ios",
    query: "onboarding",
    pageSize: 3,
    pageIndex: 0,
  });
  assert.equal(page.value.data.length, 3);
  assert.equal(page.value.hasNextPage, false);
  assert.equal(page.value.totalCount, 500);
});

test("Deep Search does not prefetch an additional potentially credit-consuming batch", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    requests++;
    const request = JSON.parse(options.body as string);
    assert.equal(request.searchQuery.mode, "deep");
    return Response.json({
      value: {
        searchRequestId: request.searchRequestId,
        data: [
          {
            type: "screen",
            id: "one",
            screenUrl: "https://bytescale.mobbin.com/image.webp",
            screenPatterns: [],
            screenElements: [],
            appVersionId: "version",
            appId: "app",
            appName: "Example",
            appLogoUrl: "https://bytescale.mobbin.com/logo.webp",
            platform: "ios",
          },
        ],
        hasNextPage: true,
      },
    });
  });
  const client = new MobbinApiClient(auth);
  client.getAccountCapabilities = async () => ({
    deepSearch: true,
    coreLibrary: true,
    unlimitedCollections: true,
    officialMcp: true,
  });
  const result = await client.searchScreens({
    platform: "ios",
    query: "login with biometrics",
    mode: "deep",
    pageSize: 1,
  });
  assert.equal(result.value.data.length, 1);
  assert.equal(requests, 1);
  assert.equal(result.value.hasNextPage, true);
});
