import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GalleryPage, GalleryItem } from "../services/gallery.js";

const app = new App({ name: "Mobbin Forge Gallery", version: "1.4.0" });
let page: GalleryPage | undefined;
function receive(result: CallToolResult) {
  if (result.isError) {
    showStatus("Screens could not load. Check your Mobbin sign-in and try again.");
    return;
  }
  if (!result.structuredContent || !Array.isArray(result.structuredContent.items)) return;
  page = result.structuredContent as unknown as GalleryPage;
  const previews = (result._meta?.galleryPreviews ?? {}) as Record<string, string>;
  for (const item of page.items) if (previews[item.id]) item.thumbnail = previews[item.id];
  render();
}
let generation = 0;
let active = 0;
const queue: Array<() => Promise<void>> = [];
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const grid = el("grid");
const status = el("status");
const filter = el<HTMLInputElement>("filter");
function drain() {
  while (active < 3 && queue.length) {
    const task = queue.shift()!;
    active++;
    void task().finally(() => {
      active--;
      drain();
    });
  }
}
function showStatus(message: string) {
  status.textContent = message;
}
function showImage(item: GalleryItem) {
  if (!item.image_url) return;
  const dialog = el<HTMLDialogElement>("detail");
  el("detail-title").textContent = `${item.app_name} · ${item.title}`;
  el<HTMLImageElement>("full-image").src = item.image_url;
  el("full-image").onerror = () =>
    showStatus("The full image could not load. Close it and retry the card.");
  el("open-original").onclick = () => {
    void app.openLink({ url: item.image_url! });
  };
  dialog.showModal();
}
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries)
      if (entry.isIntersecting) {
        observer.unobserve(entry.target);
        const task = tasks.get(entry.target);
        if (task) {
          queue.push(task);
          drain();
        }
      }
  },
  { rootMargin: "240px" },
);
const tasks = new WeakMap<Element, () => Promise<void>>();
function render() {
  if (!page) return;
  generation++;
  const current = generation;
  queue.length = 0;
  observer.disconnect();
  grid.replaceChildren();
  el("title").textContent = page.title;
  const needle = filter.value.toLowerCase();
  const visible = page.items.filter((item) =>
    [item.title, item.app_name, ...item.patterns, ...item.elements]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
  el("count").textContent =
    `${visible.length} on this page${page.total === undefined ? "" : ` · ${page.total} ${page.total_label ?? "total"}`}`;
  el<HTMLButtonElement>("previous").disabled = page.page_index === 0;
  el<HTMLButtonElement>("next").disabled = !page.has_next_page;
  el("page").textContent = `Page ${page.page_index + 1}`;
  if (!visible.length)
    showStatus(needle ? "No matches on this page. Try another term or page." : "No screens found.");
  else showStatus("Select a screen to inspect the full image.");
  for (const item of visible) {
    const card = document.createElement("article");
    const button = document.createElement("button");
    button.className = "image-button";
    button.setAttribute("aria-label", `Inspect ${item.app_name}: ${item.title}`);
    const image = document.createElement("img");
    image.alt = `${item.app_name} — ${item.title}`;
    const state = document.createElement("span");
    state.className = "image-state";
    button.append(image, state);
    button.onclick = () => showImage(item);
    const name = document.createElement("h2");
    name.textContent = item.app_name;
    const title = document.createElement("p");
    title.textContent = item.title;
    const tags = document.createElement("small");
    tags.textContent = `${item.platform.toUpperCase()}${item.restricted ? " · Restricted preview" : ""}`;
    const info = document.createElement("div");
    info.className = "info";
    info.append(name, title, tags);
    card.append(button, info);
    grid.append(card);
    const ready = () => {
      image.src = item.thumbnail!;
      image.hidden = false;
      state.hidden = true;
      button.disabled = false;
      tags.textContent = `${item.platform.toUpperCase()} · Full image available`;
    };
    const load = async () => {
      if (current !== generation) return;
      button.disabled = true;
      state.hidden = false;
      state.textContent = "Loading screenshot…";
      try {
        const result = await app.callServerTool({
          name: "mobbin_get_gallery_image",
          arguments: { screen_url: item.screen_url },
        });
        if (result.isError) throw new Error("Image unavailable");
        const data = result.structuredContent as { thumbnail?: string; image_url?: string };
        if (!data?.thumbnail || !data?.image_url) throw new Error("Image unavailable");
        Object.assign(item, data);
        if (current === generation) ready();
      } catch {
        if (current !== generation) return;
        image.hidden = true;
        button.disabled = false;
        state.textContent = "Image unavailable · Retry";
        button.onclick = () => {
          button.onclick = () => showImage(item);
          queue.push(load);
          drain();
        };
      }
    };
    if (item.thumbnail) ready();
    else {
      button.disabled = true;
      state.textContent = "Waiting to load…";
      tasks.set(card, load);
      observer.observe(card);
    }
  }
}
async function changePage(delta: number) {
  if (!page) return;
  const args = { ...page.arguments, page_index: page.page_index + delta };
  el<HTMLButtonElement>("previous").disabled = true;
  el<HTMLButtonElement>("next").disabled = true;
  showStatus("Loading page…");
  try {
    const result = await app.callServerTool({ name: page.tool, arguments: args });
    if (result.isError || !result.structuredContent) throw Error("Could not load page");
    filter.value = "";
    receive(result);
  } catch {
    render();
    showStatus("Could not load this page. Please try again.");
  }
}
filter.oninput = render;
el("previous").onclick = () => {
  void changePage(-1);
};
el("next").onclick = () => {
  void changePage(1);
};
el("close").onclick = () => el<HTMLDialogElement>("detail").close();
el<HTMLSelectElement>("density").onchange = (event) => {
  grid.dataset.density = (event.target as HTMLSelectElement).value;
};
app.ontoolresult = receive;
app.onhostcontextchanged = (context) => {
  if (context.theme) applyDocumentTheme(context.theme);
};
app.onteardown = async () => {
  generation++;
  observer.disconnect();
  queue.length = 0;
  return {};
};
void app
  .connect()
  .then(() => {
    const theme = app.getHostContext()?.theme;
    if (theme) applyDocumentTheme(theme);
  })
  .catch(() => showStatus("Open this gallery in an MCP Apps client to browse screens."));
