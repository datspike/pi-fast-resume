export interface IndexedSession {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  createdMs: number;
  modifiedMs: number;
  sourceMtimeMs: number;
  sourceSize: number;
  firstMessage: string;
  messageCount: number;
  lastActivityMs?: number;
  archived: boolean;
}

export interface WorkerProgress {
  phase: "scanning" | "ready" | "error";
  completed: number;
  total: number;
  message: string;
}

export type WorkerRequest =
  | { id: number; type: "snapshot"; cwd: string }
  | { id: number; type: "sync"; sessionDir: string; reindex?: boolean }
  | { id: number; type: "rename"; path: string; name: string }
  | { id: number; type: "shutdown" };

export type WorkerResponse =
  | { id: number; type: "snapshot"; sessions: IndexedSession[] }
  | { id: number; type: "sync"; started: boolean; reason?: "lease-held" | "already-running" }
  | { id: number; type: "rename" }
  | { id: number; type: "shutdown" }
  | { type: "progress"; progress: WorkerProgress }
  | { type: "index-updated" }
  | { type: "error"; message: string };

export type WorkerRequestPayload =
  | { type: "snapshot"; cwd: string }
  | { type: "sync"; sessionDir: string; reindex?: boolean }
  | { type: "rename"; path: string; name: string }
  | { type: "shutdown" };
