import sharp from "sharp";

export type Fingerprint = { aspect: number; pixels: Buffer };

/** Ignore the top system status strip; compare actual pixels, not semantic CLIP similarity. */
export async function fingerprint(bytes: Uint8Array): Promise<Fingerprint> {
  const image = sharp(bytes, { limitInputPixels: 24_000_000 }).rotate();
  const oriented = await image.png().toBuffer({ resolveWithObject: true });
  const { width, height } = oriented.info;
  const top = Math.floor(height * 0.035);
  const pixels = await sharp(oriented.data)
    .extract({ left: 0, top, width, height: height - top })
    .resize(96, 192, { fit: "fill" })
    .flatten({ background: "white" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer();
  return { aspect: width / height, pixels };
}

/** Conservative near-duplicate heuristic; never equates semantically similar layouts. */
export function nearDuplicate(a: Fingerprint, b: Fingerprint): boolean {
  if (Math.abs(a.aspect / b.aspect - 1) > 0.01 || a.pixels.length !== b.pixels.length) return false;
  let total = 0;
  let changed = 0;
  const blocks = new Uint16Array(8 * 16);
  for (let i = 0; i < a.pixels.length; i += 3) {
    let maximum = 0;
    for (let channel = 0; channel < 3; channel++) {
      const difference = Math.abs(a.pixels[i + channel] - b.pixels[i + channel]);
      total += difference;
      maximum = Math.max(maximum, difference);
    }
    if (maximum > 24) {
      changed++;
      const pixel = i / 3;
      blocks[Math.floor(Math.floor(pixel / 96) / 12) * 8 + Math.floor((pixel % 96) / 12)]++;
    }
  }
  // Local changes can be important even when the whole screen barely changes (e.g. a tab).
  return (
    total / a.pixels.length <= 1 &&
    changed / (a.pixels.length / 3) <= 0.003 &&
    Math.max(...blocks) / (12 * 12) <= 0.1
  );
}
