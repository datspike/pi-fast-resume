import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

function request(worker, payload) {
  const id = Math.floor(Math.random() * 1_000_000);
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message.id !== id) return;
      worker.off("message", onMessage);
      resolve(message);
    };
    worker.on("message", onMessage);
    worker.once("error", reject);
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
  const sync = await request(worker, { type: "sync", sessionDir: sessions });
  assert.equal(sync.type, "sync");
  assert.equal(sync.started, true);
  await ready;

  const snapshot = await request(worker, { type: "snapshot", cwd: "/repo" });
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.sessions.length, 2);
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
  const firstSync = await request(first, { type: "sync", sessionDir: sessions });
  assert.equal(firstSync.started, true);
  const secondSync = await request(second, { type: "sync", sessionDir: sessions });
  assert.deepEqual(secondSync, { id: secondSync.id, type: "sync", started: false, reason: "lease-held" });
  await firstReady;
});
