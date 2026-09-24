import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";

function request(worker, payload) {
  const id = Math.floor(Math.random() * 1_000_000);
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      worker.off("message", onMessage);
      reject(error);
    };
    const onMessage = (message) => {
      if (message.id !== id) return;
      worker.off("message", onMessage);
      worker.off("error", onError);
      resolve(message);
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.postMessage({ id, ...payload });
  });
}

function waitForReady(worker) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker did not become ready")), 10_000);
    const onMessage = (message) => {
      if (message.type !== "progress" || message.progress.phase !== "ready") return;
      clearTimeout(timer);
      worker.off("message", onMessage);
      resolve();
    };
    worker.on("message", onMessage);
  });
}

async function writeSession(path, { id, cwd, name, parentSession } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const lines = [
    { type: "session", version: 3, id: id ?? "session-id", timestamp: "2026-01-01T00:00:00.000Z", cwd: cwd ?? "/repo", ...(parentSession ? { parentSession } : {}) },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "First request" }] } },
    ...(name ? [{ type: "session_info", id: "n1", parentId: "u1", timestamp: "2026-01-01T00:02:00.000Z", name }] : []),
  ];
  await writeFile(path, `${lines.map(JSON.stringify).join("\n")}\n`, "utf8");
}

test("worker checkpoints indexed metadata and renames one session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-resume-worker-"));
  const sessions = join(root, "sessions");
  const index = join(root, "index");
  const regular = join(sessions, "--repo--", "regular.jsonl");
  const agent = join(sessions, "--repo--", "agent.jsonl");
  await writeSession(regular, { id: "regular", name: "Human name" });
  await writeSession(agent, { id: "agent", name: "scout#deadbeef", parentSession: regular });

  const worker = new Worker(new URL("../src/worker.ts", import.meta.url), {
    execArgv: [],
    env: { ...process.env, PI_FAST_RESUME_INDEX_DIR: index },
  });
  t.after(async () => {
    await worker.terminate();
    await rm(root, { recursive: true, force: true });
  });

  const ready = waitForReady(worker);
  const sync = await request(worker, { type: "sync", sessionDir: sessions, cwd: "/repo" });
  assert.equal(sync.type, "sync");
  assert.equal(sync.started, true);
  await ready;

  const snapshot = await request(worker, { type: "snapshot", cwd: "/repo" });
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.projectKey, "path:/repo");
  assert.equal(snapshot.sessions.length, 2);
  assert.ok(snapshot.sessions.every((session) => session.projectKey === snapshot.projectKey));
  assert.equal(snapshot.sessions.find((session) => session.id === "regular").name, "Human name");

  const renamed = await request(worker, { type: "rename", path: regular, name: "Renamed session" });
  assert.equal(renamed.type, "rename");
  const afterRename = await request(worker, { type: "snapshot", cwd: "/repo" });
  assert.equal(afterRename.sessions.find((session) => session.id === "regular").name, "Renamed session");
});

test("only one worker acquires the cross-process scan lease", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-resume-lease-"));
  const sessions = join(root, "sessions");
  const index = join(root, "index");
  await Promise.all(Array.from({ length: 100 }, (_, index) => writeSession(join(sessions, "--repo--", `${index}.jsonl`))));

  const createWorker = () =>
    new Worker(new URL("../src/worker.ts", import.meta.url), {
      execArgv: [],
      env: { ...process.env, PI_FAST_RESUME_INDEX_DIR: index },
    });
  const first = createWorker();
  const second = createWorker();
  t.after(async () => {
    await Promise.all([first.terminate(), second.terminate()]);
    await rm(root, { recursive: true, force: true });
  });

  const firstReady = waitForReady(first);
  const firstSync = await request(first, { type: "sync", sessionDir: sessions, cwd: "/repo" });
  assert.equal(firstSync.started, true);
  const secondSync = await request(second, { type: "sync", sessionDir: sessions, cwd: "/repo" });
  assert.deepEqual(secondSync, { id: secondSync.id, type: "sync", started: false, reason: "lease-held", projectKey: "path:/repo" });
  await firstReady;
});

test("worker correlates initialization errors with request ids", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-resume-error-"));
  const blockedPath = join(root, "not-a-directory");
  await writeFile(blockedPath, "blocked", "utf8");
  const worker = new Worker(new URL("../src/worker.ts", import.meta.url), {
    execArgv: [],
    env: { ...process.env, PI_FAST_RESUME_INDEX_DIR: blockedPath },
  });
  t.after(async () => {
    await worker.terminate();
    await rm(root, { recursive: true, force: true });
  });
  const response = await request(worker, { type: "snapshot", cwd: "/repo" });
  assert.equal(response.type, "error");
  assert.ok(Number.isInteger(response.id));
});

function observeReady(worker) {
  let resolveReady;
  let rejectReady;
  const promise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timer = setTimeout(() => {
    worker.off("message", onMessage);
    rejectReady(new Error("worker did not become ready"));
  }, 10_000);
  const onMessage = (message) => {
    if (message.type !== "progress" || message.progress.phase !== "ready") return;
    clearTimeout(timer);
    worker.off("message", onMessage);
    resolveReady();
  };
  worker.on("message", onMessage);
  return { promise, cancel: () => { clearTimeout(timer); worker.off("message", onMessage); } };
}

async function createGitRepository(path) {
  await mkdir(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", path]);
}

test("workers reload a changed project map before matching reindexed keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-resume-map-refresh-"));
  const sessions = join(root, "sessions");
  const index = join(root, "index");
  const mapPath = join(index, "project-map.json");
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  const oldWorktree = join(root, "historical-worktrees", "deleted-task");
  await Promise.all([createGitRepository(repoA), createGitRepository(repoB)]);
  await mkdir(index, { recursive: true });
  await writeFile(
    mapPath,
    JSON.stringify({ version: 1, mappings: [{ cwdPrefix: join(root, "historical-worktrees"), projectRoot: repoA }] }),
    "utf8",
  );
  await utimes(mapPath, 1_700_000_000, 1_700_000_000);
  await writeSession(join(sessions, "--repo--", "historical.jsonl"), { id: "historical", cwd: oldWorktree });

  const createWorker = () =>
    new Worker(new URL("../src/worker.ts", import.meta.url), {
      execArgv: [],
      env: { ...process.env, PI_FAST_RESUME_INDEX_DIR: index },
    });
  const first = createWorker();
  const second = createWorker();
  t.after(async () => {
    await Promise.all([first.terminate(), second.terminate()]);
    await rm(root, { recursive: true, force: true });
  });

  const firstReady = observeReady(first);
  const initialSync = await request(first, { type: "sync", sessionDir: sessions, cwd: oldWorktree });
  assert.equal(initialSync.started, true);
  await firstReady.promise;
  const initialSnapshot = await request(second, { type: "snapshot", cwd: oldWorktree });
  assert.equal(initialSnapshot.projectKey, `git:${join(repoA, ".git")}`);

  const originalMapStat = await stat(mapPath);
  await writeFile(
    mapPath,
    JSON.stringify({ version: 1, mappings: [{ cwdPrefix: join(root, "historical-worktrees"), projectRoot: repoB }] }),
    "utf8",
  );
  await utimes(mapPath, originalMapStat.atime, originalMapStat.mtime);
  const updatedMapStat = await stat(mapPath);
  assert.equal(updatedMapStat.size, originalMapStat.size);
  assert.equal(updatedMapStat.mtimeMs, originalMapStat.mtimeMs);

  const reindexReady = observeReady(first);
  const reindex = await request(first, { type: "sync", sessionDir: sessions, cwd: oldWorktree, reindex: true });
  assert.equal(reindex.started, true);
  await reindexReady.promise;
  const refreshedSnapshot = await request(second, { type: "snapshot", cwd: oldWorktree });
  const expectedProjectKey = `git:${join(repoB, ".git")}`;
  assert.equal(refreshedSnapshot.projectKey, expectedProjectKey);
  assert.equal(refreshedSnapshot.sessions.length, 1, JSON.stringify(refreshedSnapshot));
});

test("parallel workers migrate a legacy index schema atomically", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-resume-migration-race-"));
  const sessions = join(root, "sessions");
  const index = join(root, "index");
  await mkdir(index, { recursive: true });
  const legacyDb = new Database(join(index, "index.db"));
  legacyDb.exec(`
    CREATE TABLE sessions (path TEXT PRIMARY KEY, id TEXT NOT NULL, cwd TEXT NOT NULL);
    CREATE TABLE scan_lease (key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    PRAGMA user_version = 1;
  `);
  legacyDb.close();

  const createWorker = () =>
    new Worker(new URL("../src/worker.ts", import.meta.url), {
      execArgv: [],
      env: { ...process.env, PI_FAST_RESUME_INDEX_DIR: index },
    });
  const workers = [createWorker(), createWorker()];
  const readySignals = workers.map(observeReady);
  t.after(async () => {
    for (const signal of readySignals) signal.cancel();
    await Promise.all(workers.map((worker) => worker.terminate()));
    await rm(root, { recursive: true, force: true });
  });

  const responses = await Promise.all(
    workers.map((worker) => request(worker, { type: "sync", sessionDir: sessions, cwd: "/repo" })),
  );
  assert.ok(responses.every((response) => response.type === "sync"), JSON.stringify(responses));
  const startedIndices = responses.flatMap((response, index) => (response.started ? [index] : []));
  assert.ok(startedIndices.length >= 1);
  await Promise.all(startedIndices.map((index) => readySignals[index].promise));
  for (const [index, signal] of readySignals.entries()) {
    if (!startedIndices.includes(index)) signal.cancel();
  }

  const snapshots = await Promise.all(workers.map((worker) => request(worker, { type: "snapshot", cwd: "/repo" })));
  assert.ok(snapshots.every((snapshot) => snapshot.type === "snapshot"));
  const migratedDb = new Database(join(index, "index.db"), { readonly: true });
  try {
    assert.equal(migratedDb.pragma("user_version", { simple: true }), 2);
    assert.ok(migratedDb.prepare("PRAGMA table_info(sessions)").all().some((column) => column.name === "project_key"));
  } finally {
    migratedDb.close();
  }
});

test("parallel syncs do not fail lease acquisition on an initialized WAL index", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-resume-ready-wal-race-"));
  const sessions = join(root, "sessions");
  const index = join(root, "index");
  await mkdir(index, { recursive: true });
  await mkdir(sessions, { recursive: true });
  const database = new Database(join(index, "index.db"));
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE sessions (
      path TEXT PRIMARY KEY, id TEXT NOT NULL, cwd TEXT NOT NULL, project_key TEXT NOT NULL,
      name TEXT, parent_session_path TEXT, created_ms INTEGER NOT NULL, modified_ms INTEGER NOT NULL,
      source_mtime_ms REAL NOT NULL, source_size INTEGER NOT NULL, first_message TEXT NOT NULL,
      message_count INTEGER NOT NULL, last_activity_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX sessions_cwd_idx ON sessions(cwd);
    CREATE INDEX sessions_modified_idx ON sessions(modified_ms DESC);
    CREATE TABLE scan_lease (key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    PRAGMA user_version = 2;
  `);
  database.close();

  const workers = Array.from(
    { length: 2 },
    () => new Worker(new URL("../src/worker.ts", import.meta.url), {
      execArgv: [],
      env: { ...process.env, PI_FAST_RESUME_INDEX_DIR: index },
    }),
  );
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.terminate()));
    await rm(root, { recursive: true, force: true });
  });

  for (let iteration = 0; iteration < 30; iteration += 1) {
    const readySignals = workers.map(observeReady);
    try {
      const responses = await Promise.all(
        workers.map((worker) => request(worker, { type: "sync", sessionDir: sessions, cwd: "/repo" })),
      );
      assert.ok(responses.every((response) => response.type === "sync"), JSON.stringify(responses));
      responses.forEach((response) => {
        if (!response.started) assert.equal(response.reason, "lease-held");
      });
      await Promise.all(
        responses.flatMap((response, index) =>
          response.started ? [readySignals[index].promise] : [],
        ),
      );
    } finally {
      readySignals.forEach((signal) => {
        signal.cancel();
      });
    }
  }
});

test("unversioned partial index schemas are rebuilt atomically", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-resume-unversioned-schema-"));
  const index = join(root, "index");
  await mkdir(index, { recursive: true });
  const legacyDb = new Database(join(index, "index.db"));
  legacyDb.exec(`
    CREATE TABLE sessions (path TEXT PRIMARY KEY, id TEXT NOT NULL, cwd TEXT NOT NULL);
    CREATE TABLE scan_lease (key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
  `);
  legacyDb.close();

  const worker = new Worker(new URL("../src/worker.ts", import.meta.url), {
    execArgv: [],
    env: { ...process.env, PI_FAST_RESUME_INDEX_DIR: index },
  });
  t.after(async () => {
    await worker.terminate();
    await rm(root, { recursive: true, force: true });
  });

  const response = await request(worker, { type: "snapshot", cwd: "/repo" });
  assert.equal(response.type, "snapshot");
  assert.equal(response.projectKey, "path:/repo");
  const migratedDb = new Database(join(index, "index.db"), { readonly: true });
  try {
    assert.equal(migratedDb.pragma("user_version", { simple: true }), 2);
    const columns = migratedDb.prepare("PRAGMA table_info(sessions)").all().map((column) => column.name);
    assert.ok(columns.includes("project_key"));
    assert.ok(columns.includes("modified_ms"));
    assert.ok(columns.includes("message_count"));
  } finally {
    migratedDb.close();
  }
});

test("partial versioned schemas are rebuilt atomically", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-resume-partial-v2-schema-"));
  const index = join(root, "index");
  await mkdir(index, { recursive: true });
  const partialDb = new Database(join(index, "index.db"));
  partialDb.exec(`
    CREATE TABLE sessions (path TEXT PRIMARY KEY, id TEXT NOT NULL, cwd TEXT NOT NULL);
    CREATE TABLE scan_lease (key TEXT PRIMARY KEY);
    PRAGMA user_version = 2;
  `);
  partialDb.close();

  const worker = new Worker(new URL("../src/worker.ts", import.meta.url), {
    execArgv: [],
    env: { ...process.env, PI_FAST_RESUME_INDEX_DIR: index },
  });
  t.after(async () => {
    await worker.terminate();
    await rm(root, { recursive: true, force: true });
  });

  const response = await request(worker, { type: "snapshot", cwd: "/repo" });
  assert.equal(response.type, "snapshot");
  assert.equal(response.projectKey, "path:/repo");
  const migratedDb = new Database(join(index, "index.db"), { readonly: true });
  try {
    assert.equal(migratedDb.pragma("user_version", { simple: true }), 2);
    const sessionsColumns = migratedDb
      .prepare("PRAGMA table_info(sessions)")
      .all()
      .map((column) => column.name);
    const leaseColumns = migratedDb
      .prepare("PRAGMA table_info(scan_lease)")
      .all()
      .map((column) => column.name);
    assert.ok(sessionsColumns.includes("project_key"));
    assert.ok(sessionsColumns.includes("message_count"));
    assert.ok(leaseColumns.includes("owner_id"));
    assert.ok(leaseColumns.includes("expires_at"));
  } finally {
    migratedDb.close();
  }
});
