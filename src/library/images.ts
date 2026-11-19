import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import sharp from "sharp";

export async function loadLocalImage(input: { image_path?: string; image_base64?: string }) {
  if (input.image_path !== undefined && input.image_base64 !== undefined)
    throw Error("Supply only one image_path or image_base64.");
  if (input.image_path !== undefined) {
    if (!path.isAbsolute(input.image_path)) throw Error("image_path must be absolute.");
    const root = await realpath(process.env.MOBBIN_IMAGE_IMPORT_ROOT ?? homedir());
    const filename = await realpath(input.image_path);
    const relative = path.relative(root, filename);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw Error("Query image is outside MOBBIN_IMAGE_IMPORT_ROOT.");
    const stats = await stat(filename);
    if (!stats.isFile() || stats.size > 20 * 1024 * 1024)
      throw Error("Query image must be a regular file of at most 20 MiB.");
    return readFile(filename);
  }
  if (input.image_base64 !== undefined) {
    const image = Buffer.from(input.image_base64, "base64");
    if (
      !image.length ||
      image.length > 20 * 1024 * 1024 ||
      image.toString("base64") !== input.image_base64
    )
      throw Error("Supply canonical base64 image data of at most 20 MiB.");
    return image;
  }
  return undefined;
}

export async function localPreview(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > 20 * 1024 * 1024)
    throw Error("Image must be at most 20 MiB.");
  const image = sharp(bytes, { limitInputPixels: 24_000_000 });
  const meta = await image.metadata();
  if (
    !["png", "jpeg", "webp", "avif", "gif"].includes(meta.format ?? "") ||
    !meta.width ||
    !meta.height ||
    meta.width < 64 ||
    meta.height < 64
  )
    throw Error("Use a raster screenshot at least 64 pixels wide/high.");
  const data = await image
    .rotate()
    .resize({ width: 1000, height: 1800, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();
  return { type: "image" as const, data: data.toString("base64"), mimeType: "image/webp" };
}
