import type { IndexedSession } from "./protocol.ts";
export interface ParsedSession extends IndexedSession {
    lastEntryId?: string;
}
/**
 * Stream a Pi JSONL session and retain only picker metadata.
 * Malformed lines are ignored so an actively written transcript stays usable.
 */
export declare function parseSessionFile(path: string, archived: boolean): Promise<ParsedSession | null>;
export declare function isSubagentSession(session: Pick<IndexedSession, "name" | "parentSessionPath">): boolean;
//# sourceMappingURL=session-parser.d.ts.map