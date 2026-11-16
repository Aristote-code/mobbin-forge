import sharp from "sharp";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MobbinApiClient } from "./api-client.js";

export const GALLERY_URI = "ui://mobbin-forge/gallery.html";
export interface GalleryItem {
  id: string;
  title: string;
  app_name: string;
  platform: string;
  screen_url: string;
  restricted: boolean;
  patterns: string[];
  elements: string[];
  thumbnail?: string;
  image_url?: string;
  error?: string;
}
export interface GalleryPage {
  title: string;
  items: GalleryItem[];
  page_index: number;
  has_next_page: boolean;
  total?: number;
  total_label?: string;
  tool: string;
  arguments: Record<string, unknown>;
}

/** Keep small previews, not original image buffers, and share simultaneous fetches. */
export class GalleryImages {
  private cache = new Map<
    string,
    Promise<{ thumbnail: string; image_url: string; width: number; height: number }>
  >();
  constructor(private client: MobbinApiClient) {}

  async get(url: string) {
    let pending = this.cache.get(url);
    if (!pending) {
      pending = (async () => {
        const image = await this.client.fetchScreenImage(url);
        const thumbnail = await sharp(image.buffer)
          .resize({ width: 320, height: 700, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 72 })
          .toBuffer();
        return {
          thumbnail: `data:image/webp;base64,${thumbnail.toString("base64")}`,
          image_url: image.resolvedUrl,
          width: image.width,
          height: image.height,
        };
      })();
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(url, pending);
    }
    try {
      return await pending;
    } catch (error) {
      this.cache.delete(url);
      throw error;
    }
  }
}

export async function galleryResult(
  page: GalleryPage,
  text: string,
  images: GalleryImages,
): Promise<CallToolResult> {
  // Inline previews also work in text-only MCP clients. Other cards load on demand.
  const previews = await Promise.all(
    page.items.slice(0, 3).map(async (item) => {
      try {
        const image = await images.get(item.screen_url);
        Object.assign(item, image);
        return {
          type: "image" as const,
          data: image.thumbnail.split(",")[1],
          mimeType: "image/webp",
        };
      } catch (error) {
        item.error = error instanceof Error ? error.message : String(error);
        return null;
      }
    }),
  );
  return {
    content: [{ type: "text", text }, ...previews.filter((p) => p !== null)],
    structuredContent: {
      ...page,
      items: page.items.map((item) => {
        const copy = { ...item };
        delete copy.thumbnail;
        return copy;
      }),
    },
    _meta: {
      galleryPreviews: Object.fromEntries(
        page.items.filter((item) => item.thumbnail).map((item) => [item.id, item.thumbnail]),
      ),
    },
  };
}
