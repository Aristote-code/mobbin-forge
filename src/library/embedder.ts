import { Worker } from "node:worker_threads";
import { mkdir } from "node:fs/promises";
import type { ChunkVector, EmbeddingEngine } from "./schema.js";

/** ONNX runs in a worker, leaving the MCP's message loop responsive. */
export class LocalEmbedder implements EmbeddingEngine {
  private worker?: Worker;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  constructor(
    private cacheDir: string,
    private allowDownloads = false,
  ) {}

  private async request(command: string, payload?: unknown): Promise<unknown> {
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    if (!this.worker) {
      this.worker = new Worker(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "../../dist/library/embedding-worker.js"
            : "./embedding-worker.js",
          import.meta.url,
        ),
        {
          workerData: { cacheDir: this.cacheDir, allowDownloads: this.allowDownloads },
          execArgv: [],
        },
      );
      this.worker.on("message", (message: { id: number; result?: unknown; error?: string }) => {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending?.reject(Error(message.error));
        else pending?.resolve(message.result);
        if (!this.pending.size) this.worker?.unref();
      });
      const fail = (error: Error) => {
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        this.worker = undefined;
      };
      this.worker.on("error", fail);
      this.worker.on("exit", (code) => {
        if (code !== 0 || this.pending.size)
          fail(Error(`Local embedding worker exited (${code}).`));
      });
    }
    this.worker.ref();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, command, payload });
    });
  }
  async setup() {
    return this.request("setup");
  }
  async image(bytes: Uint8Array) {
    return (await this.request("image", bytes)) as ChunkVector[];
  }
  async text(text: string) {
    return (await this.request("text", text)) as number[];
  }
  async close() {
    const worker = this.worker;
    this.worker = undefined;
    for (const pending of this.pending.values())
      pending.reject(Error("Local embedding engine closed."));
    this.pending.clear();
    await worker?.terminate();
  }
}
