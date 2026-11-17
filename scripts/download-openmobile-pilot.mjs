/** Bounded download of a licensed public dataset; never downloads from Mobbin. */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

const DATASET = "UI-MOPD/Uni-GUI-OpenMobile";
const REVISION = "774eb20f97724bf64faa9e66b1572f05b1688e38";
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const directory = path.resolve(
  outIndex < 0 ? path.join(homedir(), ".mobbin-mcp", "pilot", "openmobile") : args[outIndex + 1],
);
const target = 1000;
await mkdir(path.join(directory, "images"), { recursive: true, mode: 0o700 });
await mkdir(path.join(directory, "tasks"), { recursive: true, mode: 0o700 });
const base = `https://huggingface.co/datasets/${DATASET}/resolve/${REVISION}`;
async function download(url, maxBytes = 20 * 1024 * 1024) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(45000),
        headers: { "User-Agent": "mobbin-forge-local-pilot/1.7 (licensed-openmobile-import)" },
      });
      if (!r.ok) {
        if ((r.status === 429 || r.status >= 500) && attempt < 3) {
          const seconds = Math.min(
            30,
            Math.max(1, Number(r.headers.get("retry-after")) || 2 ** attempt),
          );
          await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
          continue;
        }
        throw Error(`Dataset request failed (${r.status}): ${url}`);
      }
      const reader = r.body.getReader(),
        parts = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel();
          throw Error("Dataset file exceeds size limit.");
        }
        parts.push(value);
      }
      return {
        bytes: Buffer.concat(parts),
        next: r.headers.get("link")?.match(/<([^>]+)>; rel="next"/)?.[1],
      };
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}
const readme = (await download(`${base}/README.md`, 100_000)).bytes;
if (!/^license:\s*apache-2\.0\s*$/m.test(readme.toString()))
  throw Error("Dataset license declaration changed; inspect it before importing.");
await writeFile(path.join(directory, "DATASET_README.md"), readme, { mode: 0o600 });
let tree;
try {
  tree = JSON.parse(await readFile(path.join(directory, "tree.json"), "utf8"));
} catch {
  tree = [];
  let next = `https://huggingface.co/api/datasets/${DATASET}/tree/${REVISION}?limit=1000`;
  for (let page = 0; next && page < 6; page++) {
    if (!next.startsWith(`https://huggingface.co/api/datasets/${DATASET}/tree/`))
      throw Error("Unexpected dataset pagination URL.");
    const result = await download(next, 2_000_000);
    tree.push(...JSON.parse(result.bytes.toString()));
    next = result.next;
  }
  await writeFile(path.join(directory, "tree.json"), JSON.stringify(tree), { mode: 0o600 });
}
const groups = new Map();
for (const entry of tree) {
  if (entry.type !== "directory" || !/^split\d+_\d+_[A-Za-z0-9]+$/.test(entry.path)) continue;
  const group = entry.path.match(
    /_(Expense|SimpleCalendar|Markor|Notes|SimpleSms|Tasks|Recipe|Retro|Vlc|Files|Clock|Contacts|AudioRecorder|SimpleDraw|System|SportsTracker)/,
  )?.[1];
  if (!group) continue;
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push(entry.path);
}
const episodes = [];
for (let row = 0; row < 3000; row++)
  for (const entries of groups.values()) if (entries[row]) episodes.push(entries[row]);
async function prepareEpisode(episode) {
  let task;
  const filename = path.join(directory, "tasks", `${episode}.json`);
  try {
    task = JSON.parse(await readFile(filename, "utf8"));
  } catch {
    task = JSON.parse((await download(`${base}/${episode}/task.json`, 1_000_000)).bytes.toString());
    await writeFile(filename, JSON.stringify(task), { mode: 0o600 });
  }
  const steps = task.data;
  if (!Array.isArray(steps) || !steps.length || steps.length > 100 || task.is_delete) return null;
  if (
    steps.some(
      (step, index) =>
        step.step !== index || step.is_delete || !/^screenshot_step\d+\.png$/.test(step.screenshot),
    )
  )
    return null;
  const last = steps.at(-1).plan?.arguments;
  if (!last || !["terminate", "answer"].includes(last.action) || last.status === "failure")
    return null;
  let files;
  const treeFile = path.join(directory, "tasks", `${episode}-files.json`);
  try {
    files = JSON.parse(await readFile(treeFile, "utf8"));
  } catch {
    files = JSON.parse(
      (
        await download(
          `https://huggingface.co/api/datasets/${DATASET}/tree/${REVISION}/${episode}?limit=200`,
          1_000_000,
        )
      ).bytes.toString(),
    );
    await writeFile(treeFile, JSON.stringify(files), { mode: 0o600 });
  }
  const checksums = new Map(
    files
      .filter((file) => file.lfs?.oid)
      .map((file) => [file.path.split("/").at(-1), file.lfs.oid]),
  );
  const downloaded = [];
  // Small batches avoid overloading the public dataset host.
  for (let start = 0; start < steps.length; start += 8) {
    const batch = await Promise.all(
      steps.slice(start, start + 8).map(async (step) => {
        const screenUrl = `${base}/${episode}/${step.screenshot}`;
        const cacheFile = path.join(directory, "tasks", `${episode}-${step.step}.png`);
        const expected = checksums.get(step.screenshot);
        let bytes;
        try {
          try {
            bytes = expected
              ? await readFile(path.join(directory, "images", `${expected}.png`))
              : await readFile(cacheFile);
          } catch {
            bytes = await readFile(cacheFile);
          }
          if (expected && createHash("sha256").update(bytes).digest("hex") !== expected)
            throw Error("Cached screenshot checksum mismatch");
        } catch {
          bytes = (await download(screenUrl)).bytes;
          if (expected && createHash("sha256").update(bytes).digest("hex") !== expected)
            throw Error("Dataset screenshot checksum mismatch");
          await writeFile(cacheFile, bytes, { mode: 0o600 });
        }
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
          throw Error("Dataset screenshot is not PNG.");
        return { step, bytes, hash: createHash("sha256").update(bytes).digest("hex"), screenUrl };
      }),
    );
    downloaded.push(...batch);
  }
  return { task, downloaded };
}
const screens = new Map(),
  flows = [];
let examined = 0,
  failures = 0;
const pending = new Map();
function schedule(index) {
  if (index < episodes.length && index < 800)
    pending.set(
      index,
      prepareEpisode(episodes[index]).catch((error) => ({ error })),
    );
}
schedule(0);
schedule(1);
for (let index = 0; index < episodes.length && index < 800; index++) {
  if (screens.size >= target) break;
  const episode = episodes[index];
  examined++;
  const prepared = await pending.get(index);
  pending.delete(index);
  schedule(index + 2);
  try {
    if (prepared?.error) throw prepared.error;
    if (!prepared) continue;
    const { task, downloaded } = prepared;
    const newHashes = new Set(
      downloaded.filter((item) => !screens.has(item.hash)).map((item) => item.hash),
    );
    if (screens.size + newHashes.size > target) continue; // Preserve whole selected trajectories.
    for (const item of downloaded) {
      if (screens.has(item.hash)) continue;
      const filename = `images/${item.hash}.png`;
      await writeFile(path.join(directory, filename), item.bytes, { mode: 0o600 });
      screens.set(item.hash, {
        id: `screen-${item.hash}`,
        image: filename,
        title: `${task.app}: step ${item.step.step}`.slice(0, 500),
        product: String(task.app).slice(0, 500),
        platform: "android",
        source_url: item.screenUrl,
        tags: [String(task.app).slice(0, 100), "openmobile", "provided-trajectory"],
        text: `${String(task.app)}. Task goal: ${String(task.query ?? "").slice(0, 4000)}. Source action annotation: ${String(item.step.action ?? "").slice(0, 3000)}`,
      });
    }
    flows.push({
      id: episode,
      title: `${task.app}: ${episode.replace(/^split\d+_\d+_/, "")}`.slice(0, 500),
      goal: String(task.query ?? steps[0].query ?? "").slice(0, 5000),
      complete: true,
      source_url: `${base}/${episode}/task.json`,
      steps: downloaded.map((item) => ({
        screen_id: `screen-${item.hash}`,
        source_step: item.step.step,
        action: String(item.step.action ?? "").slice(0, 3000),
      })),
    });
    const manifest = {
      schema_version: 1,
      dataset: {
        id: "openmobile-pilot",
        title: "Uni-GUI-OpenMobile local pilot",
        source_url: `https://huggingface.co/datasets/${DATASET}`,
        license: "Apache-2.0",
        license_url: "https://www.apache.org/licenses/LICENSE-2.0",
        attribution:
          "UI-MOPD / Uni-GUI-OpenMobile, Niu Lian et al., 2026. Dataset card declares Apache 2.0; original application assets retain their respective rights.",
        rights_basis: "licensed",
        source_revision: REVISION,
      },
      screens: [...screens.values()],
      flows,
    };
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        indexed_source_screens: screens.size,
        complete_provided_trajectories: flows.length,
        examined_episodes: examined,
        failures,
      }),
    );
  } catch (error) {
    failures++;
    console.error(`Skipping dataset episode ${episode}: ${error.message}`);
  }
}
await Promise.allSettled([...pending.values()]);
await access(path.join(directory, "manifest.json"));
console.log(
  JSON.stringify({
    manifest: path.join(directory, "manifest.json"),
    screens: screens.size,
    flows: flows.length,
    target,
    reached_target: screens.size === target,
  }),
);
if (screens.size !== target) process.exitCode = 2;
