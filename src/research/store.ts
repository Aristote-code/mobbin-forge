import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  benchmarkInput,
  benchmarkSchema,
  findingInput,
  projectInput,
  projectSchema,
  recordId,
  referenceInput,
  type Benchmark,
  type Project,
} from "./schemas.js";

const MAX_BYTES = 2 * 1024 * 1024;
type Kind = "projects" | "benchmarks";
type Records = { projects: Project; benchmarks: Benchmark };
const schemas = { projects: projectSchema, benchmarks: benchmarkSchema };

/** One OS user's local workspace. This is not an HTTP tenant authorization layer. */
export class ResearchStore {
  readonly directory: string;
  constructor(directory?: string) {
    this.directory = path.resolve(
      directory ??
        process.env.MOBBIN_RESEARCH_DIR ??
        path.join(homedir(), ".mobbin-mcp", "research"),
    );
  }

  private filename(kind: Kind, id: string) {
    return path.join(this.directory, kind, `${recordId.parse(id)}.json`);
  }

  async get<K extends Kind>(kind: K, id: string): Promise<Records[K]> {
    const filename = this.filename(kind, id);
    try {
      if ((await stat(filename)).size > MAX_BYTES)
        throw Error("Research record exceeds size limit.");
      const raw = await readFile(filename, "utf8");
      const value = schemas[kind].parse(JSON.parse(raw));
      if (value.id !== id) throw Error("Research record identity mismatch.");
      return value as Records[K];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw Error(`Research ${kind} record not found.`, { cause: error });
      throw error;
    }
  }

  private async locked<T>(kind: Kind, id: string, action: () => Promise<T>) {
    const filename = this.filename(kind, id);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const lock = `${filename}.lock`;
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw Error(
          "Research record is busy. Read it again before retrying. A lock left by a stopped process must be removed locally after confirming it is no longer running.",
          { cause: error },
        );
      throw error;
    }
    try {
      return await action();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  private async write<K extends Kind>(kind: K, value: Records[K]) {
    const validated = schemas[kind].parse(value);
    const data = JSON.stringify(validated, null, 2);
    if (Buffer.byteLength(data) > MAX_BYTES) throw Error("Research record exceeds size limit.");
    const filename = this.filename(kind, value.id);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      await rename(temporary, filename);
    } finally {
      await handle.close().catch(() => {});
      await rm(temporary, { force: true });
    }
    return validated as Records[K];
  }

  async setProject(input: z.input<typeof projectInput>, id?: string, expectedRevision?: number) {
    const data = projectInput.parse(input);
    const projectId = id ?? randomUUID();
    return this.locked("projects", projectId, async () => {
      const previous = id ? await this.get("projects", id) : null;
      if (previous && previous.revision !== expectedRevision)
        throw Error("Revision conflict. Read the project and retry with its current revision.");
      const now = new Date().toISOString();
      return this.write("projects", {
        ...data,
        id: projectId,
        revision: (previous?.revision ?? 0) + 1,
        created_at: previous?.created_at ?? now,
        updated_at: now,
      });
    });
  }

  async createBenchmark(input: z.input<typeof benchmarkInput>) {
    const data = benchmarkInput.parse(input);
    if (new Set(data.criteria.map((c) => c.key)).size !== data.criteria.length)
      throw Error("Criterion keys must be unique.");
    const project = data.project_id ? await this.get("projects", data.project_id) : null;
    const id = randomUUID(),
      now = new Date().toISOString();
    return this.locked("benchmarks", id, () =>
      this.write("benchmarks", {
        ...data,
        id,
        revision: 1,
        created_at: now,
        updated_at: now,
        project_snapshot: project,
        references: [],
        findings: [],
      }),
    );
  }

  private async update(id: string, expectedRevision: number, mutate: (record: Benchmark) => void) {
    return this.locked("benchmarks", id, async () => {
      const record = await this.get("benchmarks", id);
      if (record.revision !== expectedRevision)
        throw Error("Revision conflict. Read the benchmark and retry with its current revision.");
      mutate(record);
      record.revision++;
      record.updated_at = new Date().toISOString();
      return this.write("benchmarks", record);
    });
  }

  async addReference(id: string, expectedRevision: number, input: z.input<typeof referenceInput>) {
    const data = referenceInput.parse(input);
    return this.update(id, expectedRevision, (record) => {
      if (record.references.length >= 20)
        throw Error("A benchmark supports at most 20 references.");
      record.references.push({
        ...data,
        id: randomUUID(),
        added_at: new Date().toISOString(),
        provenance: "agent_supplied",
        steps: data.steps.map((step) => ({ ...step, id: randomUUID() })),
      });
    });
  }

  async addFinding(id: string, expectedRevision: number, input: z.input<typeof findingInput>) {
    const data = findingInput.parse(input);
    return this.update(id, expectedRevision, (record) => {
      if (data.criterion_key && !record.criteria.some((c) => c.key === data.criterion_key))
        throw Error("Unknown benchmark criterion.");
      const steps = new Set(record.references.flatMap((r) => r.steps.map((s) => s.id)));
      if (data.step_ids.some((step) => !steps.has(step)))
        throw Error("A cited step does not belong to this benchmark.");
      if (data.inspected_step_ids.some((step) => !data.step_ids.includes(step)))
        throw Error("Inspected steps must also be cited.");
      if (["observation", "interpretation"].includes(data.kind) && !data.step_ids.length)
        throw Error("Observations and interpretations require cited steps.");
      if (
        data.kind === "observation" &&
        data.step_ids.some((step) => !data.inspected_step_ids.includes(step))
      )
        throw Error(
          "An observation requires every cited step to be agent-inspected. Otherwise record it as a hypothesis.",
        );
      if (data.supersedes && !record.findings.some((f) => f.id === data.supersedes))
        throw Error("The superseded finding does not belong to this benchmark.");
      if (data.supersedes && record.findings.some((f) => f.supersedes === data.supersedes))
        throw Error("This finding was already superseded. Read the latest benchmark.");
      if (record.findings.length >= 300) throw Error("A benchmark supports at most 300 findings.");
      record.findings.push({
        ...data,
        id: randomUUID(),
        added_at: new Date().toISOString(),
        attribution: "agent_authored",
      });
    });
  }

  async remove(kind: Kind, id: string, expectedRevision: number) {
    return this.locked(kind, id, async () => {
      const record = await this.get(kind, id);
      if (record.revision !== expectedRevision)
        throw Error("Revision conflict. Read the record before deleting it.");
      await rm(this.filename(kind, id));
      return { deleted: true, id, kind };
    });
  }

  async list(kind: Kind, query = "", projectId?: string, offset = 0, limit = 20) {
    if (projectId) recordId.parse(projectId);
    let files: string[];
    try {
      files = await readdir(path.join(this.directory, kind));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { items: [], next_offset: null };
      throw error;
    }
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const records: Array<Project | Benchmark> = [];
    for (const file of files.filter((f) => /^[a-f0-9-]{36}\.json$/.test(f)).sort()) {
      const record = await this.get(kind, file.slice(0, -5));
      if (projectId && !("project_id" in record && record.project_id === projectId)) continue;
      const searchable = JSON.stringify(record).toLocaleLowerCase();
      if (terms.every((term) => searchable.includes(term))) records.push(record);
    }
    records.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
    return {
      items: records.slice(offset, offset + limit).map((r) => ({
        id: r.id,
        revision: r.revision,
        updated_at: r.updated_at,
        ...("title" in r
          ? {
              title: r.title,
              question: r.question,
              project_id: r.project_id,
              references: r.references.length,
              findings: r.findings.length,
            }
          : { name: r.name, audience: r.audience }),
      })),
      next_offset: offset + limit < records.length ? offset + limit : null,
    };
  }
}
