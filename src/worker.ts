import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { appendFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parentPort } from "node:worker_threads";
import Database from "better-sqlite3";
import type { IndexedSession, WorkerProgress, WorkerRequest, WorkerResponse } from "./protocol.ts";
import { parseSessionFile } from "./session-parser.ts";

const SCHEMA_VERSION = 1;
const READ_CONCURRENCY = 10;
const CHECKPOINT_SIZE = 25;
const LEASE_MS = 30_000;
const INDEX_DIR = process.env.PI_FAST_RESUME_INDEX_DIR ?? join(homedir(), ".pi", "agent", "pi-fast-resume");
const INDEX_PATH = join(INDEX_DIR, "index.db");
const OWNER_ID = `${process.pid}:${randomBytes(8).toString("hex")}`;

if (!parentPort) throw new Error("pi-fast-resume worker requires parentPort");

let db: Database.Database | undefined;
let scanning = false;

function emit(message: WorkerResponse): void {
  parentPort?.postMessage(message);
}

function progress(phase: WorkerProgress["phase"], completed: number, total: number, message: string): void {
  emit({ type: "progress", progress: { phase, completed, total, message } });
}

async function ensureDir(): Promise<void> {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(INDEX_DIR, { recursive: true }));
}

async function getDb(): Promise<Database.Database> {
  if (db) return db;
  await ensureDir();
  const opened = new Database(INDEX_PATH);
  opened.pragma("journal_mode = WAL");
  opened.pragma("synchronous = NORMAL");
  opened.pragma("busy_timeout = 5000");

  const version = opened.pragma("user_version", { simple: true }) as number;
  if (version !== 0 && version !== SCHEMA_VERSION) {
    opened.exec("DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS scan_lease;");
  }

  opened.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      path TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      name TEXT,
      parent_session_path TEXT,
      created_ms INTEGER NOT NULL,
      modified_ms INTEGER NOT NULL,
      source_mtime_ms REAL NOT NULL,
      source_size INTEGER NOT NULL,
      first_message TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      last_activity_ms INTEGER,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS sessions_cwd_idx ON sessions(cwd);
    CREATE INDEX IF NOT EXISTS sessions_modified_idx ON sessions(modified_ms DESC);
    CREATE TABLE IF NOT EXISTS scan_lease (
      key TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  opened.pragma(`user_version = ${SCHEMA_VERSION}`);
  db = opened;
  return opened;
}

function acquireLease(database: Database.Database): boolean {
  const now = Date.now();
  const expiresAt = now + LEASE_MS;
  return database.transaction(() => {
    const row = database
      .prepare("SELECT owner_id, expires_at FROM scan_lease WHERE key = 'scan'")
      .get() as { owner_id: string; expires_at: number } | undefined;
    if (row && row.owner_id !== OWNER_ID && row.expires_at > now) return false;
    database
      .prepare("INSERT OR REPLACE INTO scan_lease (key, owner_id, expires_at) VALUES ('scan', ?, ?)")
      .run(OWNER_ID, expiresAt);
    return true;
  })();
}

function renewLease(database: Database.Database): void {
  database
    .prepare("UPDATE scan_lease SET expires_at = ? WHERE key = 'scan' AND owner_id = ?")
    .run(Date.now() + LEASE_MS, OWNER_ID);
}

function releaseLease(database: Database.Database): void {
  database.prepare("DELETE FROM scan_lease WHERE key = 'scan' AND owner_id = ?").run(OWNER_ID);
}

async function discoverSessionFiles(sessionDir: string): Promise<Array<{ path: string; archived: boolean }>> {
  const result: Array<{ path: string; archived: boolean }> = [];
  let dirs: Dirent[];
  try {
    dirs = await readdir(sessionDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of dirs) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = join(sessionDir, entry.name);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    const archived = entry.name.startsWith("__archive__");
    for (const file of files) {
      if (file.endsWith(".jsonl")) result.push({ path: join(dir, file), archived });
    }
  }
  return result;
}

function listIndexed(database: Database.Database): IndexedSession[] {
  const rows = database.prepare(`
    SELECT path, id, cwd, name, parent_session_path, created_ms, modified_ms,
           source_mtime_ms, source_size, first_message, message_count,
           last_activity_ms, archived
    FROM sessions
    ORDER BY modified_ms DESC
  `).all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    path: row.path as string,
    id: row.id as string,
    cwd: row.cwd as string,
    name: (row.name as string | null) ?? undefined,
    parentSessionPath: (row.parent_session_path as string | null) ?? undefined,
    createdMs: row.created_ms as number,
    modifiedMs: row.modified_ms as number,
    sourceMtimeMs: row.source_mtime_ms as number,
    sourceSize: row.source_size as number,
    firstMessage: row.first_message as string,
    messageCount: row.message_count as number,
    lastActivityMs: (row.last_activity_ms as number | null) ?? undefined,
    archived: Boolean(row.archived),
  }));
}

function upsertBatch(database: Database.Database, sessions: IndexedSession[]): void {
  const statement = database.prepare(`
    INSERT INTO sessions (
      path, id, cwd, name, parent_session_path, created_ms, modified_ms,
      source_mtime_ms, source_size, first_message, message_count, last_activity_ms, archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      id=excluded.id, cwd=excluded.cwd, name=excluded.name,
      parent_session_path=excluded.parent_session_path, created_ms=excluded.created_ms,
      modified_ms=excluded.modified_ms, source_mtime_ms=excluded.source_mtime_ms,
      source_size=excluded.source_size, first_message=excluded.first_message,
      message_count=excluded.message_count, last_activity_ms=excluded.last_activity_ms,
      archived=excluded.archived
  `);
  database.transaction(() => {
    for (const session of sessions) {
      statement.run(
        session.path,
        session.id,
        session.cwd,
        session.name ?? null,
        session.parentSessionPath ?? null,
        session.createdMs,
        session.modifiedMs,
        session.sourceMtimeMs,
        session.sourceSize,
        session.firstMessage,
        session.messageCount,
        session.lastActivityMs ?? null,
        session.archived ? 1 : 0,
      );
    }
  })();
}

async function mapConcurrent<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  let next = 0;
  const runners = Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      result[index] = await fn(items[index]);
    }
  });
  await Promise.all(runners);
  return result;
}

async function sync(sessionDir: string, reindex: boolean): Promise<{ started: boolean; reason?: "lease-held" | "already-running" }> {
  if (scanning) return { started: false, reason: "already-running" };
  const database = await getDb();
  if (!acquireLease(database)) return { started: false, reason: "lease-held" };

  scanning = true;
  void (async () => {
    try {
      if (reindex) database.exec("DELETE FROM sessions");
      const files = await discoverSessionFiles(sessionDir);
      const indexed = new Map(listIndexed(database).map((session) => [session.path, session]));
      const currentPaths = new Set(files.map((file) => file.path));
      const candidates: Array<{ path: string; archived: boolean }> = [];

      for (const file of files) {
        try {
          const current = await stat(file.path);
          const old = indexed.get(file.path);
          if (!old || old.sourceSize !== current.size || old.sourceMtimeMs !== current.mtimeMs) candidates.push(file);
        } catch {
          // File disappeared between discovery and stat; the removal pass handles it.
        }
      }

      const stale = [...indexed.keys()].filter((path) => !currentPaths.has(path));
      if (stale.length) {
        const remove = database.prepare("DELETE FROM sessions WHERE path = ?");
        database.transaction(() => {
          for (const path of stale) remove.run(path);
        })();
      }

      const total = files.length;
      let completed = total - candidates.length;
      progress("scanning", completed, total, `Index warming up… ${completed}/${total}`);

      for (let start = 0; start < candidates.length; start += CHECKPOINT_SIZE) {
        const batch = candidates.slice(start, start + CHECKPOINT_SIZE);
        const parsed = await mapConcurrent(batch, async (file) => parseSessionFile(file.path, file.archived));
        upsertBatch(database, parsed.filter((value): value is IndexedSession => value !== null));
        completed += batch.length;
        renewLease(database);
        progress("scanning", completed, total, `Index warming up… ${completed}/${total}`);
        emit({ type: "index-updated" });
      }

      progress("ready", total, total, "Index up to date");
      emit({ type: "index-updated" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      progress("error", 0, 0, `Index error: ${message}`);
      emit({ type: "error", message });
    } finally {
      releaseLease(database);
      scanning = false;
    }
  })();

  return { started: true };
}

async function renameSession(path: string, name: string): Promise<void> {
  const database = await getDb();
  const parsed = await parseSessionFile(path, false);
  if (!parsed) throw new Error("Session is not a valid Pi JSONL file");
  const entry = {
    type: "session_info",
    id: randomBytes(4).toString("hex"),
    parentId: parsed.lastEntryId ?? null,
    timestamp: new Date().toISOString(),
    name: name.replace(/[\r\n]+/g, " ").trim(),
  };
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  const refreshed = await parseSessionFile(path, parsed.archived);
  if (!refreshed) throw new Error("Session became unreadable after rename");
  upsertBatch(database, [refreshed]);
  emit({ type: "index-updated" });
}

async function removeDeletedSession(path: string): Promise<void> {
  try {
    await stat(path);
    return;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const database = await getDb();
  database.prepare("DELETE FROM sessions WHERE path = ?").run(path);
  emit({ type: "index-updated" });
}

parentPort.on("message", async (request: WorkerRequest) => {
  try {
    if (request.type === "snapshot") {
      const database = await getDb();
      emit({ id: request.id, type: "snapshot", sessions: listIndexed(database) });
      return;
    }
    if (request.type === "sync") {
      const result = await sync(request.sessionDir, Boolean(request.reindex));
      emit({ id: request.id, type: "sync", ...result });
      return;
    }
    if (request.type === "rename") {
      await renameSession(request.path, request.name);
      emit({ id: request.id, type: "rename" });
      return;
    }
    if (request.type === "remove") {
      await removeDeletedSession(request.path);
      emit({ id: request.id, type: "remove" });
      return;
    }
    if (request.type === "shutdown") {
      db?.close();
      db = undefined;
      emit({ id: request.id, type: "shutdown" });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ id: request.id, type: "error", message });
  }
});
