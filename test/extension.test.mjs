import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import Database from "better-sqlite3";
import fastResume from "../src/index.ts";

initTheme("light", false);
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
setKeybindings(keybindings);

function createExtensionHarness() {
  const commands = new Map();
  const events = new Map();
  const pi = {
    registerCommand(name, options) {
      commands.set(name, options.handler);
    },
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    async sendUserMessage() {},
  };
  fastResume(pi);
  return {
    command(name) {
      const command = commands.get(name);
      assert.ok(command, `command ${name} is registered`);
      return command;
    },
    async emit(name, event, ctx) {
      for (const handler of events.get(name) ?? []) await handler(event, ctx);
    },
  };
}

async function writeSession(path, { id = "session-id", cwd = "/repo", firstMessage = "First request" } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const now = new Date().toISOString();
  const lines = [
    { type: "session", version: 3, id, timestamp: now, cwd },
    { type: "message", id: "u1", parentId: null, timestamp: now, message: { role: "user", content: [{ type: "text", text: firstMessage }] } },
  ];
  await writeFile(path, `${lines.map(JSON.stringify).join("\n")}\n`, "utf8");
}

function createContext(projectSessionDir, ui) {
  return {
    mode: "tui",
    hasUI: true,
    cwd: "/repo",
    sessionManager: {
      getSessionDir: () => projectSessionDir,
      getCwd: () => "/repo",
      getSessionFile: () => undefined,
    },
    ui,
  };
}

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

function indexContains(indexPath, firstMessage) {
  if (!existsSync(indexPath)) return false;
  const database = new Database(indexPath, { readonly: true });
  try {
    return Boolean(database.prepare("SELECT 1 FROM sessions WHERE first_message = ?").get(firstMessage));
  } finally {
    database.close();
  }
}

function renderUntilSession(factory, expectedText, onReady) {
  return new Promise((resolve, reject) => {
    let component;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`picker did not render ${expectedText}`)), 5_000);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(undefined);
    };

    const tui = {
      requestRender() {
        if (!component) return;
        const output = component.render(120).join("\n");
        if (output.includes(expectedText)) finish();
      },
    };

    component = factory(tui, undefined, keybindings, () => finish());
    tui.requestRender();
    onReady?.();
  });
}

test("session_start begins indexing before the picker is opened", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-resume-startup-"));
  const indexDir = join(root, "index");
  const indexPath = join(indexDir, "index.db");
  const projectSessionDir = join(root, "sessions", "--repo--");
  const sessionPath = join(projectSessionDir, "startup.jsonl");
  const previousIndexDir = process.env.PI_FAST_RESUME_INDEX_DIR;
  process.env.PI_FAST_RESUME_INDEX_DIR = indexDir;
  await writeSession(sessionPath, { firstMessage: "Indexed during session start" });

  const harness = createExtensionHarness();
  const notifications = [];
  const ctx = createContext(projectSessionDir, {
    notify(message, level) {
      notifications.push(`${level}:${message}`);
    },
  });

  t.after(async () => {
    await harness.emit("session_shutdown", { reason: "quit" }, ctx);
    if (previousIndexDir === undefined) delete process.env.PI_FAST_RESUME_INDEX_DIR;
    else process.env.PI_FAST_RESUME_INDEX_DIR = previousIndexDir;
    await rm(root, { recursive: true, force: true });
  });

  await harness.emit("session_start", { reason: "startup" }, ctx);
  await waitFor(() => indexContains(indexPath, "Indexed during session start"));
  assert.deepEqual(notifications, []);
});

test("an open picker requests a render when its worker updates the index", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-resume-render-"));
  const indexDir = join(root, "index");
  const projectSessionDir = join(root, "sessions", "--repo--");
  const previousIndexDir = process.env.PI_FAST_RESUME_INDEX_DIR;
  process.env.PI_FAST_RESUME_INDEX_DIR = indexDir;
  await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      writeSession(join(projectSessionDir, `${String(index).padStart(2, "0")}.jsonl`), {
        id: `render-${index}`,
        firstMessage: `Filler session ${index}`,
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await writeSession(join(projectSessionDir, "zz-render.jsonl"), {
    id: "render-target",
    firstMessage: "Rendered without reopening",
  });

  const harness = createExtensionHarness();
  const ctx = createContext(projectSessionDir, {
    notify() {},
    custom(factory) {
      return renderUntilSession(factory, "Rendered without reopening");
    },
  });

  t.after(async () => {
    await harness.emit("session_shutdown", { reason: "quit" }, ctx);
    if (previousIndexDir === undefined) delete process.env.PI_FAST_RESUME_INDEX_DIR;
    else process.env.PI_FAST_RESUME_INDEX_DIR = previousIndexDir;
    await rm(root, { recursive: true, force: true });
  });

  await harness.command("rf")("", ctx);
});

test("a picker follows index updates while another process owns the scan lease", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-resume-lease-follow-"));
  const indexDir = join(root, "index");
  const indexPath = join(indexDir, "index.db");
  const projectSessionDir = join(root, "sessions", "--repo--");
  const previousIndexDir = process.env.PI_FAST_RESUME_INDEX_DIR;
  process.env.PI_FAST_RESUME_INDEX_DIR = indexDir;
  await mkdir(projectSessionDir, { recursive: true });

  const initializer = createExtensionHarness();
  const initCtx = createContext(projectSessionDir, { notify() {} });
  await initializer.emit("session_start", { reason: "startup" }, initCtx);
  await waitFor(() => existsSync(indexPath));
  await initializer.emit("session_shutdown", { reason: "quit" }, initCtx);

  const database = new Database(indexPath);
  database.prepare("INSERT OR REPLACE INTO scan_lease (key, owner_id, expires_at) VALUES ('scan', 'foreign-worker', ?)").run(Date.now() + 10_000);
  database.close();

  const harness = createExtensionHarness();
  let inserted = false;
  const ctx = createContext(projectSessionDir, {
    notify() {},
    custom(factory) {
      return renderUntilSession(factory, "Visible from foreign worker", () => {
        setTimeout(() => {
          const writer = new Database(indexPath);
          writer.prepare(`
            INSERT INTO sessions (
              path, id, cwd, name, parent_session_path, created_ms, modified_ms,
              source_mtime_ms, source_size, first_message, message_count, last_activity_ms, archived
            ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 0)
          `).run(
            join(projectSessionDir, "foreign.jsonl"),
            "foreign-session",
            "/repo",
            Date.now(),
            Date.now(),
            Date.now(),
            100,
            "Visible from foreign worker",
            1,
            Date.now(),
          );
          writer.close();
          inserted = true;
        }, 50);
      });
    },
  });

  t.after(async () => {
    await harness.emit("session_shutdown", { reason: "quit" }, ctx);
    if (previousIndexDir === undefined) delete process.env.PI_FAST_RESUME_INDEX_DIR;
    else process.env.PI_FAST_RESUME_INDEX_DIR = previousIndexDir;
    await rm(root, { recursive: true, force: true });
  });

  await harness.command("rf")("", ctx);
  assert.equal(inserted, true);
});
