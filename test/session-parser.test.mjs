import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isSubagentSession, parseSessionFile } from "../src/session-parser.ts";

async function fixture(lines) {
  const dir = await mkdtemp(join(tmpdir(), "pi-fast-resume-parser-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

test("parser retains the last name and Pi picker metadata", async () => {
  const path = await fixture([
    JSON.stringify({ type: "session", version: 3, id: "session-id", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "First request" }] } }),
    JSON.stringify({ type: "session_info", id: "n1", parentId: "u1", timestamp: "2026-01-01T00:02:00.000Z", name: "Initial name" }),
    JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:03:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Answer" }] } }),
    "{partial-json",
    JSON.stringify({ type: "session_info", id: "n2", parentId: "a1", timestamp: "2026-01-01T00:04:00.000Z", name: "Final name" }),
  ]);

  const parsed = await parseSessionFile(path, false);
  assert.ok(parsed);
  assert.equal(parsed.id, "session-id");
  assert.equal(parsed.cwd, "/repo");
  assert.equal(parsed.firstMessage, "First request");
  assert.equal(parsed.messageCount, 2);
  assert.equal(parsed.name, "Final name");
  assert.equal(parsed.lastEntryId, "n2");
});

test("subagent classification preserves ordinary fork sessions", () => {
  assert.equal(isSubagentSession({ parentSessionPath: "/parent", name: "scout#deadbeef" }), true);
  assert.equal(isSubagentSession({ parentSessionPath: "/parent", name: "A normal fork" }), false);
  assert.equal(isSubagentSession({ name: "scout#deadbeef" }), false);
});
