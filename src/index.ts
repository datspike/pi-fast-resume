import { Worker } from "node:worker_threads";
import {
  type KeybindingsManager as AgentKeybindingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionInfo,
  SessionSelectorComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type Focusable,
  type KeybindingsManager,
  matchesKey,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import type { IndexedSession, WorkerProgress, WorkerRequest, WorkerRequestPayload, WorkerResponse } from "./protocol.ts";
import { isSubagentSession } from "./session-parser.ts";

const SEARCH_TEXT_LIMIT = 4_096;

function toSessionInfo(session: IndexedSession): SessionInfo {
  const allMessagesText = `${session.name ?? ""} ${session.firstMessage} ${session.cwd}`
    .trim()
    .slice(0, SEARCH_TEXT_LIMIT);
  return {
    path: session.path,
    id: session.id,
    cwd: session.cwd,
    name: session.name,
    parentSessionPath: session.parentSessionPath,
    created: new Date(session.createdMs),
    modified: new Date(session.modifiedMs),
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
    allMessagesText,
  };
}

class WorkerClient {
  private readonly worker: Worker;
  private requestId = 0;
  private readonly pending = new Map<number, { resolve: (value: WorkerResponse) => void; reject: (error: Error) => void }>();
  private progressListener?: (progress: WorkerProgress) => void;
  private updateListener?: () => void;
  private errorListener?: (message: string) => void;

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url));
    this.worker.on("message", (message: WorkerResponse) => this.onMessage(message));
    this.worker.on("error", (error: Error) => this.errorListener?.(error.message));
    this.worker.on("exit", (code) => {
      if (code !== 0) this.errorListener?.(`Worker stopped with code ${code}`);
    });
  }

  onProgress(listener: (progress: WorkerProgress) => void): void {
    this.progressListener = listener;
  }

  onIndexUpdated(listener: () => void): void {
    this.updateListener = listener;
  }

  onError(listener: (message: string) => void): void {
    this.errorListener = listener;
  }

  async snapshot(cwd: string): Promise<IndexedSession[]> {
    const response = await this.request({ type: "snapshot", cwd });
    if (response.type !== "snapshot") throw new Error("Unexpected worker response");
    return response.sessions;
  }

  async sync(sessionDir: string, reindex = false): Promise<{ started: boolean; reason?: "lease-held" | "already-running" }> {
    const response = await this.request({ type: "sync", sessionDir, reindex });
    if (response.type !== "sync") throw new Error("Unexpected worker response");
    return response;
  }

  async rename(path: string, name: string): Promise<void> {
    const response = await this.request({ type: "rename", path, name });
    if (response.type !== "rename") throw new Error("Unexpected worker response");
  }

  async shutdown(): Promise<void> {
    try {
      await this.request({ type: "shutdown" });
    } finally {
      await this.worker.terminate();
    }
  }

  private request(request: WorkerRequestPayload): Promise<WorkerResponse> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id } satisfies WorkerRequest);
    });
  }

  private onMessage(message: WorkerResponse): void {
    if (message.type === "progress") {
      this.progressListener?.(message.progress);
      return;
    }
    if (message.type === "index-updated") {
      this.updateListener?.();
      return;
    }
    if (message.type === "error") {
      this.errorListener?.(message.message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.resolve(message);
  }
}

class FastResumeView extends Container implements Focusable {
  private readonly status = new Text("", 0, 0);
  private readonly selector: SessionSelectorComponent;
  private agentsShown = false;
  private scope: "current" | "all" = "current";
  private sessions: IndexedSession[] = [];
  private readonly cwd: string;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.selector.focused = value;
  }

  constructor(
    private readonly client: WorkerClient,
    cwd: string,
    keybindings: KeybindingsManager,
    _theme: Theme,
    done: (path: string | undefined) => void,
    requestRender: () => void,
  ) {
    super();
    this.cwd = cwd;
    this.status = new Text("", 0, 0);

    const loader = (scope: "current" | "all") => async () => {
      this.scope = scope;
      await this.refresh(scope);
      return this.filtered(scope);
    };

    this.selector = new SessionSelectorComponent(
      loader("current"),
      loader("all"),
      (path) => done(path),
      () => done(undefined),
      () => done(undefined),
      requestRender,
      {
        keybindings: keybindings as unknown as AgentKeybindingsManager,
        renameSession: async (path, name) => {
          await this.client.rename(path, name ?? "");
          await this.refresh(this.scope);
        },
      },
    );
    this.addChild(this.status);
    this.addChild(this.selector);
    this.setStatusText("");
  }

  handleInput(data: string): void {
    if (matchesKey(data, "alt+g")) {
      this.agentsShown = !this.agentsShown;
      this.selector.getSessionList().setSessions(this.filtered(this.scope), this.scope === "all");
      this.setStatusText(`Agents: ${this.agentsShown ? "shown" : "hidden"}`);
      return;
    }
    this.selector.handleInput(data);
  }

  setStatusText(message: string): void {
    this.status.setText(message);
    this.invalidate();
  }

  async refresh(scope = this.scope): Promise<void> {
    this.sessions = await this.client.snapshot(this.cwd);
    this.selector.getSessionList().setSessions(this.filtered(scope), scope === "all");
  }

  updateFromIndex(): void {
    void this.refresh();
  }

  private filtered(scope: "current" | "all"): SessionInfo[] {
    return this.sessions
      .filter((session) => scope === "all" || session.cwd === this.cwd)
      .filter((session) => this.agentsShown || !isSubagentSession(session))
      .map(toSessionInfo);
  }

}

function isInteractive(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" && ctx.hasUI;
}

export default function fastResume(pi: ExtensionAPI): void {
  let client: WorkerClient | undefined;

  function getClient(): WorkerClient {
    if (client) return client;
    client = new WorkerClient();
    return client;
  }

  async function openPicker(ctx: ExtensionCommandContext): Promise<void> {
    if (!isInteractive(ctx)) {
      ctx.ui.notify("/rf requires interactive TUI mode", "warning");
      return;
    }

    const worker = getClient();
    const sessionDir = ctx.sessionManager.getSessionDir();
    if (!sessionDir) {
      ctx.ui.notify("Pi has no configured session directory", "warning");
      return;
    }
    const cwd = ctx.sessionManager.getCwd();
    let view: FastResumeView | undefined;
    let requestRender: (() => void) | undefined;

    worker.onProgress((state) => view?.setStatusText(state.phase === "ready" ? "" : state.message));
    worker.onIndexUpdated(() => view?.updateFromIndex());
    worker.onError((message) => view?.setStatusText(`Index error: ${message}`));

    const sync = await worker.sync(sessionDir);
    if (!sync.started && sync.reason === "lease-held") {
      // Another Pi process owns the scan; this picker still opens from the last index.
    }

    const selected = await ctx.ui.custom<string | undefined>(
      (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done) => {
        requestRender = () => tui.requestRender();
        view = new FastResumeView(worker, cwd, keybindings, theme, done, requestRender);
        view.setStatusText(sync.started ? "Index warming up…" : sync.reason === "lease-held" ? "Index scan owned by another Pi process" : "");
        return view as Component & Focusable;
      },
      {
        overlay: true,
        overlayOptions: {
          width: "100%",
          maxHeight: "100%",
          margin: 0,
        },
      },
    );

    if (!selected) return;
    await ctx.switchSession(selected, {
      withSession: async (newCtx) => newCtx.ui.notify(`Resumed: ${selected}`, "info"),
    });
  }

  pi.registerCommand("rf", {
    description: "Open fast resume picker backed by a worker-thread metadata index",
    handler: async (args, ctx) => {
      if (args.trim() === "reindex") {
        const worker = getClient();
        const sessionDir = ctx.sessionManager.getSessionDir();
        if (!sessionDir) {
          ctx.ui.notify("Pi has no configured session directory", "warning");
          return;
        }
        const result = await worker.sync(sessionDir, true);
        ctx.ui.notify(result.started ? "Fast-resume rebuild started" : `Rebuild unavailable: ${result.reason}`, result.started ? "info" : "warning");
        return;
      }
      if (args.trim()) {
        ctx.ui.notify("Usage: /rf or /rf reindex", "warning");
        return;
      }
      await openPicker(ctx);
    },
  });

  pi.registerCommand("resume-fast", {
    description: "Alias for /rf",
    handler: async (args, ctx) => {
      if (args.trim()) {
        await pi.sendUserMessage(`/rf ${args.trim()}`, { deliverAs: "followUp" });
        return;
      }
      await openPicker(ctx);
    },
  });

  pi.on("session_shutdown", async () => {
    const current = client;
    client = undefined;
    if (current) await current.shutdown();
  });
}
