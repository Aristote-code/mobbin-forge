/** Read only the installed authorized manifest; cache local Apple Vision evidence. */
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
export const manifestPath = path.resolve(
  process.env.MOBBIN_CATALOG_MANIFEST ??
    path.join(os.homedir(), ".mobbin-mcp/pilot/openmobile/manifest.json"),
);
export const directory =
  process.env.MOBBIN_LIBRARY_DIR ?? path.join(os.homedir(), ".mobbin-mcp/library");
export const cacheDirectory = path.join(directory, "catalog-cache/ocr");
const digest = (x) => createHash("sha256").update(x).digest("hex");
export async function runOcrCache() {
  if (os.platform() !== "darwin")
    throw Error(
      "This OCR adapter requires macOS Apple Vision. Existing catalogs remain readable on other platforms.",
    );
  const bytes = await fs.readFile(manifestPath);
  const manifest = JSON.parse(bytes);
  const sourceDb = new DatabaseSync(path.join(directory, "library.sqlite"), { readOnly: true });
  const metadata = Object.fromEntries(
    sourceDb
      .prepare("SELECT key,value FROM metadata")
      .all()
      .map((r) => [r.key, r.value]),
  );
  if (metadata.manifest_sha256 !== digest(bytes))
    throw Error("Manifest does not match installed authorized library.");
  const sources = new Map(
    sourceDb
      .prepare("SELECT id,asset_hash FROM screens")
      .all()
      .map((r) => [r.id, r.asset_hash]),
  );
  sourceDb.close();
  if (manifest.screens.length !== 1000 || sources.size !== 1000)
    throw Error("This job requires the authorized 1,000-screen pilot.");
  const dataset = JSON.parse(metadata.dataset);
  if (!["owned", "licensed", "written_permission"].includes(dataset.rights_basis))
    throw Error("Missing source rights declaration.");
  await fs.mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const swift = path.join(root, "scripts/local-ui-ocr.swift");
  const source = await fs.readFile(swift);
  const cacheKey = digest(Buffer.concat([source, Buffer.from(os.release())]));
  const binary = path.join(directory, "catalog-cache/local-ui-ocr");
  execFileSync("/usr/bin/swiftc", ["-O", swift, "-o", binary], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 120000,
  });
  class Worker {
    constructor() {
      this.child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
      this.pending = [];
      this.stderr = "";
      this.child.stderr.on("data", (b) => {
        this.stderr = (this.stderr + b).slice(-4000);
      });
      createInterface({ input: this.child.stdout }).on("line", (line) => {
        const p = this.pending.shift();
        if (!p) return;
        clearTimeout(p.timer);
        try {
          p.resolve(JSON.parse(line));
        } catch (e) {
          p.reject(e);
        }
      });
      const fail = (e) => {
        for (const p of this.pending) {
          clearTimeout(p.timer);
          p.reject(e);
        }
        this.pending = [];
      };
      this.child.on("error", fail);
      this.child.on("exit", (code) => fail(Error("OCR worker exited " + code + " " + this.stderr)));
    }
    request(file) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.child.kill();
          reject(Error("Local OCR timed out"));
        }, 90000);
        this.pending.push({ resolve, reject, timer });
        this.child.stdin.write(JSON.stringify({ path: file }) + "\n");
      });
    }
    close() {
      this.child.stdin.end();
    }
  }
  const workers = [new Worker(), new Worker()];
  let next = 0,
    done = 0,
    reused = 0;
  const errors = [];
  const base = await fs.realpath(path.dirname(manifestPath));
  try {
    await Promise.all(
      workers.map(async (worker) => {
        while (next < manifest.screens.length) {
          const screen = manifest.screens[next++];
          try {
            const expected = sources.get(screen.id);
            if (!expected) throw Error("Unknown screen ID");
            const cache = path.join(cacheDirectory, expected + ".json");
            let old;
            try {
              old = JSON.parse(await fs.readFile(cache));
            } catch {}
            if (old?.cache_key === cacheKey && old?.source_sha256 === expected && old?.result?.ok) {
              reused++;
              done++;
              continue;
            }
            const filename = await fs.realpath(path.resolve(base, screen.image));
            const relative = path.relative(base, filename);
            if (
              relative === ".." ||
              relative.startsWith(".." + path.sep) ||
              path.isAbsolute(relative)
            )
              throw Error("Source escapes manifest directory");
            if (digest(await fs.readFile(filename)) !== expected)
              throw Error("Source checksum mismatch");
            const result = await worker.request(filename);
            if (!result.ok) throw Error(result.error ?? "OCR failed");
            const record = {
              cache_key: cacheKey,
              source_sha256: expected,
              generated_at: new Date().toISOString(),
              result,
            };
            const temp = cache + "." + randomUUID() + ".tmp";
            await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
            await fs.rename(temp, cache);
            done++;
            if (done % 25 === 0)
              console.log(
                JSON.stringify({ phase: "local_ocr", completed: done, total: 1000, reused }),
              );
          } catch (e) {
            errors.push({ screen_id: screen.id, error: String(e) });
          }
        }
      }),
    );
  } finally {
    for (const w of workers) w.close();
  }
  await fs.writeFile(
    path.join(directory, "catalog-cache/ocr-receipt.json"),
    JSON.stringify(
      {
        cache_key: cacheKey,
        manifest_sha256: metadata.manifest_sha256,
        completed: done,
        reused,
        errors,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  if (errors.length)
    throw Error(
      `${errors.length} OCR failures; successful evidence is cached. See ocr-receipt.json`,
    );
  console.log(
    JSON.stringify({ phase: "local_ocr_complete", completed: done, reused, cache_key: cacheKey }),
  );
  return { cacheKey, manifest, metadata };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runOcrCache();
