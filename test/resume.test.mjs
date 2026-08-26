import assert from "node:assert/strict";
import test from "node:test";
import { resumeSelectedSession } from "../src/index.ts";

test("picker selection switches through Pi command context", async () => {
  const calls = [];
  const ctx = {
    async switchSession(path, options) {
      calls.push(path);
      await options.withSession({
        ui: { notify(message, level) { calls.push(`${level}:${message}`); } },
      });
      return { cancelled: false };
    },
  };

  await resumeSelectedSession(ctx, "/tmp/selected.jsonl");
  assert.deepEqual(calls, ["/tmp/selected.jsonl", "info:Resumed: /tmp/selected.jsonl"]);
});
