import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { IndexedSession } from "./protocol.ts";

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .flatMap((block) => {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        "text" in block &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return [(block as { text: string }).text];
      }
      return [];
    })
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function dateMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface ParsedSession extends IndexedSession {
  lastEntryId?: string;
}

/**
 * Stream a Pi JSONL session and retain only picker metadata.
 * Malformed lines are ignored so an actively written transcript stays usable.
 */
export async function parseSessionFile(path: string, archived: boolean): Promise<ParsedSession | null> {
  const fingerprint = await stat(path);
  let header: Record<string, unknown> | undefined;
  let name: string | undefined;
  let firstMessage = "";
  let messageCount = 0;
  let lastActivityMs: number | undefined;
  let lastEntryId: string | undefined;

  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;

    if (!header) {
      if (entry.type !== "session") return null;
      header = entry;
      continue;
    }

    if (typeof entry.id === "string") lastEntryId = entry.id;

    if (entry.type === "session_info") {
      name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
      continue;
    }

    if (entry.type !== "message") continue;
    messageCount += 1;
    const activity = dateMs(entry.timestamp);
    if (activity !== undefined) lastActivityMs = Math.max(lastActivityMs ?? activity, activity);

    if (!isRecord(entry.message) || entry.message.role !== "user" || firstMessage) continue;
    firstMessage = extractText(entry.message.content);
  }

  if (!header || typeof header.id !== "string") return null;
  const createdMs = dateMs(header.timestamp) ?? fingerprint.birthtimeMs;

  return {
    path,
    id: header.id,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name,
    parentSessionPath: typeof header.parentSession === "string" ? header.parentSession : undefined,
    createdMs,
    modifiedMs: lastActivityMs ?? fingerprint.mtimeMs,
    sourceMtimeMs: fingerprint.mtimeMs,
    sourceSize: fingerprint.size,
    firstMessage,
    messageCount,
    lastActivityMs,
    archived,
    lastEntryId,
  };
}

export function isSubagentSession(session: Pick<IndexedSession, "name" | "parentSessionPath">): boolean {
  return Boolean(session.parentSessionPath && session.name && /^[^#]+#[0-9a-f]{8}$/i.test(session.name));
}
