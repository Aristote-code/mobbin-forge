import { parentPort, workerData } from "node:worker_threads";
import sharp from "sharp";
import path from "node:path";
import { MODEL, normalize } from "./schema.js";

if (!workerData.allowDownloads) {
  globalThis.fetch = async () => {
    throw Error("Network access is disabled in the local inference worker.");
  };
}

async function initialize() {
  const t = await import("@huggingface/transformers").catch((error) => {
    throw Error(
      "Local embeddings require the optional @huggingface/transformers package. Run npm install --include=optional, then node dist/index.js library setup.",
      { cause: error },
    );
  });
  t.env.cacheDir = workerData.cacheDir;
  t.env.allowRemoteModels = Boolean(workerData.allowDownloads);
  t.env.allowLocalModels = true;
  const modelPath = workerData.allowDownloads
    ? MODEL.id
    : path.join(workerData.cacheDir, MODEL.id, MODEL.revision);
  const options = {
    revision: MODEL.revision,
    dtype: "q8" as const,
    device: "cpu" as const,
    local_files_only: !workerData.allowDownloads,
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
  };
  const [processor, tokenizer, vision, text] = await Promise.all([
    t.AutoProcessor.from_pretrained(modelPath, options),
    t.AutoTokenizer.from_pretrained(modelPath, options),
    t.CLIPVisionModelWithProjection.from_pretrained(modelPath, options),
    t.CLIPTextModelWithProjection.from_pretrained(modelPath, options),
  ]);
  return { t, processor, tokenizer, vision, text };
}
let pending: ReturnType<typeof initialize> | undefined;
async function run(command: string, payload: unknown) {
  pending ??= initialize().catch((error) => {
    pending = undefined;
    throw error;
  });
  const { t, processor, tokenizer, vision, text } = await pending;
  if (command === "setup") return MODEL;
  if (command === "text") {
    const inputs = await tokenizer(String(payload), {
      padding: true,
      truncation: true,
      max_length: 77,
    });
    const output = await text(inputs);
    return normalize((output.text_embeds as { data: Float32Array }).data);
  }
  if (command !== "image") throw Error("Unknown local embedding command.");
  const original = await sharp(Buffer.from(payload as Uint8Array), { limitInputPixels: 24_000_000 })
    .rotate()
    .removeAlpha()
    .toBuffer();
  const { width, height } = await sharp(original).metadata();
  if (!width || !height) throw Error("Image dimensions are missing.");
  const size = Math.min(width, height);
  const regions = [
    {
      name: "full",
      rect: undefined as { left: number; top: number; width: number; height: number } | undefined,
    },
  ];
  if (height > width * 1.3) {
    for (const [name, fraction] of [
      ["top", 0],
      ["middle", 0.5],
      ["bottom", 1],
    ] as const)
      regions.push({
        name,
        rect: { left: 0, top: Math.round((height - size) * fraction), width: size, height: size },
      });
  } else if (width > height * 1.3) {
    for (const [name, fraction] of [
      ["left", 0],
      ["middle", 0.5],
      ["right", 1],
    ] as const)
      regions.push({
        name,
        rect: { left: Math.round((width - size) * fraction), top: 0, width: size, height: size },
      });
  }
  const images = [];
  for (const region of regions) {
    let image = sharp(original);
    if (region.rect) image = image.extract(region.rect);
    const data = await image
      .resize(224, 224, { fit: "contain", background: "white" })
      .flatten({ background: "white" })
      .raw()
      .toBuffer();
    images.push(new t.RawImage(new Uint8ClampedArray(data), 224, 224, 3));
  }
  const inputs = await processor(images);
  const output = await vision(inputs);
  const values = (output.image_embeds as { data: Float32Array }).data;
  if (values.length !== regions.length * MODEL.dimensions)
    throw Error("Unexpected local image embedding shape.");
  return regions.map((region, index) => ({
    region: region.name,
    vector: normalize(values.subarray(index * MODEL.dimensions, (index + 1) * MODEL.dimensions)),
  }));
}
let queue = Promise.resolve();
parentPort!.on("message", (message: { id: number; command: string; payload?: unknown }) => {
  queue = queue.then(async () => {
    try {
      parentPort!.postMessage({
        id: message.id,
        result: await run(message.command, message.payload),
      });
    } catch (error) {
      parentPort!.postMessage({
        id: message.id,
        error: `Local embedding failed: ${error instanceof Error ? error.message : String(error)}. If model files are missing, run node dist/index.js library setup once with network access.`,
      });
    }
  });
});
