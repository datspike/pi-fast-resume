import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { SessionManager, SessionSelectorComponent, } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text, } from "@earendil-works/pi-tui";
import { isSubagentSession } from "./session-parser.js";
const SEARCH_TEXT_LIMIT = 4_096;
const WORKER_RPC_TIMEOUT_MS = 30_000;
const LEASE_RETRY_INTERVAL_MS = 500;
function toSessionInfo(session) {
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
/** Switch through Pi's public command-context API after picker confirmation. */
export async function resumeSelectedSession(ctx, sessionPath) {
    await ctx.switchSession(sessionPath, {
        withSession: async (newCtx) => newCtx.ui.notify(`Resumed: ${sessionPath}`, "info"),
    });
}
class WorkerClient {
    worker;
    requestId = 0;
    pending = new Map();
    terminalError;
    progressListener;
    updateListener;
    errorListener;
    constructor() {
        const workerFile = import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js";
        this.worker = new Worker(new URL(workerFile, import.meta.url));
        this.worker.on("message", (message) => this.onMessage(message));
        this.worker.on("error", (error) => this.failAll(error));
        this.worker.on("exit", (code) => {
            if (code !== 0)
                this.failAll(new Error(`Worker stopped with code ${code}`));
        });
    }
    onProgress(listener) {
        this.progressListener = listener;
    }
    onIndexUpdated(listener) {
        this.updateListener = listener;
    }
    onError(listener) {
        this.errorListener = listener;
    }
    async snapshot(cwd) {
        const response = await this.request({ type: "snapshot", cwd });
        if (response.type !== "snapshot")
            throw new Error("Unexpected worker response");
        return { sessions: response.sessions, projectKey: response.projectKey };
    }
    async sync(sessionDir, cwd, reindex = false) {
        const response = await this.request({ type: "sync", sessionDir, cwd, reindex });
        if (response.type !== "sync")
            throw new Error("Unexpected worker response");
        return response;
    }
    async rename(path, name) {
        const response = await this.request({ type: "rename", path, name });
        if (response.type !== "rename")
            throw new Error("Unexpected worker response");
    }
    async remove(path) {
        const response = await this.request({ type: "remove", path });
        if (response.type !== "remove")
            throw new Error("Unexpected worker response");
    }
    async shutdown() {
        try {
            await this.request({ type: "shutdown" });
        }
        finally {
            await this.worker.terminate();
        }
    }
    request(request) {
        if (this.terminalError)
            return Promise.reject(this.terminalError);
        const id = ++this.requestId;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Worker request timed out after ${WORKER_RPC_TIMEOUT_MS}ms: ${request.type}`));
            }, WORKER_RPC_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timeout });
            try {
                this.worker.postMessage({ ...request, id });
            }
            catch (error) {
                clearTimeout(timeout);
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    onMessage(message) {
        if (message.type === "progress") {
            this.progressListener?.(message.progress);
            return;
        }
        if (message.type === "index-updated") {
            this.updateListener?.();
            return;
        }
        if (message.type === "error") {
            const error = new Error(message.message);
            if (message.id !== undefined)
                this.rejectPending(message.id, error);
            this.errorListener?.(message.message);
            return;
        }
        const pending = this.pending.get(message.id);
        if (!pending)
            return;
        clearTimeout(pending.timeout);
        this.pending.delete(message.id);
        pending.resolve(message);
    }
    rejectPending(id, error) {
        const pending = this.pending.get(id);
        if (!pending)
            return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error);
    }
    failAll(error) {
        if (this.terminalError)
            return;
        this.terminalError = error;
        for (const id of this.pending.keys())
            this.rejectPending(id, error);
        this.errorListener?.(error.message);
    }
}
class FastResumeView extends Container {
    status = new Text("", 0, 0);
    selector;
    client;
    agentsShown = false;
    scope = "current";
    sessions = [];
    projectKey = "";
    cwd;
    excludedSessionPath;
    requestRender;
    _focused = false;
    get focused() {
        return this._focused;
    }
    set focused(value) {
        this._focused = value;
        this.selector.focused = value;
    }
    constructor(client, cwd, currentSessionFilePath, excludedSessionPath, keybindings, _theme, done, requestRender) {
        super();
        this.client = client;
        this.cwd = cwd;
        this.excludedSessionPath = excludedSessionPath;
        this.requestRender = requestRender;
        this.status = new Text("", 0, 0);
        const loader = (scope) => async () => {
            this.scope = scope;
            await this.refresh(scope);
            return this.filtered(scope);
        };
        this.selector = new SessionSelectorComponent(loader("current"), loader("all"), (path) => done(path), () => done(undefined), () => done(undefined), requestRender, {
            keybindings: keybindings,
            renameSession: async (path, name) => {
                await this.client.rename(path, name ?? "");
                await this.refresh(this.scope);
            },
        }, currentSessionFilePath);
        const sessionList = this.selector.getSessionList();
        sessionList.maxVisible = 20;
        const nativeDelete = sessionList.onDeleteSession;
        if (nativeDelete) {
            sessionList.onDeleteSession = async (path) => {
                await nativeDelete(path);
                await this.client.remove(path);
            };
        }
        this.addChild(this.status);
        this.addChild(this.selector);
        this.setStatusText("");
    }
    handleInput(data) {
        if (matchesKey(data, "alt+g")) {
            this.agentsShown = !this.agentsShown;
            this.selector.getSessionList().setSessions(this.filtered(this.scope), this.scope === "all");
            this.setStatusText(`Agents: ${this.agentsShown ? "shown" : "hidden"}`);
            return;
        }
        this.selector.handleInput(data);
    }
    setStatusText(message) {
        this.status.setText(message);
        this.invalidate();
        this.requestRender();
    }
    async refresh(scope = this.scope) {
        const snapshot = await this.client.snapshot(this.cwd);
        this.sessions = snapshot.sessions;
        this.projectKey = snapshot.projectKey;
        this.selector.getSessionList().setSessions(this.filtered(scope), scope === "all");
        this.requestRender();
    }
    updateFromIndex() {
        void this.refresh().catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.setStatusText(`Index error: ${message}`);
        });
    }
    filtered(scope) {
        return this.sessions
            .filter((session) => scope === "all" || session.projectKey === this.projectKey)
            .filter((session) => session.path !== this.excludedSessionPath)
            .filter((session) => this.agentsShown || !isSubagentSession(session))
            .map(toSessionInfo);
    }
}
function sessionRoot(ctx) {
    const projectSessionDir = ctx.sessionManager.getSessionDir();
    return projectSessionDir ? dirname(projectSessionDir) : undefined;
}
function delay(ms, signal) {
    if (signal.aborted)
        return Promise.resolve(false);
    return new Promise((resolve) => {
        const onAbort = () => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", onAbort);
            resolve(false);
        };
        const timeout = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve(true);
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
function isInteractive(ctx) {
    return ctx.mode === "tui" && ctx.hasUI;
}
export default function fastResume(pi) {
    let client;
    function getClient() {
        if (client)
            return client;
        client = new WorkerClient();
        return client;
    }
    async function forkSelectedSession(ctx, sourcePath) {
        try {
            const forked = SessionManager.forkFrom(sourcePath, ctx.cwd, ctx.sessionManager.getSessionDir());
            const forkedPath = forked.getSessionFile();
            if (!forkedPath)
                throw new Error("Forked session is not persisted");
            const result = await ctx.switchSession(forkedPath, {
                withSession: async (nextCtx) => nextCtx.ui.notify("Forked selected session", "info"),
            });
            if (result.cancelled)
                ctx.ui.notify("Fork created, but switching to it was cancelled", "warning");
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Failed to fork selected session: ${message}`, "error");
        }
    }
    async function openPicker(ctx, onSelected = (sessionPath) => resumeSelectedSession(ctx, sessionPath), excludedSessionPath) {
        if (!isInteractive(ctx)) {
            ctx.ui.notify("/rf requires interactive TUI mode", "warning");
            return;
        }
        const worker = getClient();
        const sessionDir = sessionRoot(ctx);
        if (!sessionDir) {
            ctx.ui.notify("Pi has no configured session directory", "warning");
            return;
        }
        const cwd = ctx.sessionManager.getCwd();
        const currentSessionFilePath = ctx.sessionManager.getSessionFile();
        let view;
        let pickerOpen = true;
        let leaseFollower;
        const leaseFollowerAbort = new AbortController();
        worker.onProgress((state) => view?.setStatusText(state.phase === "ready" ? "" : state.message));
        worker.onIndexUpdated(() => view?.updateFromIndex());
        worker.onError((message) => view?.setStatusText(`Index error: ${message}`));
        const sync = await worker.sync(sessionDir, cwd);
        const followForeignLease = async () => {
            while (pickerOpen && (await delay(LEASE_RETRY_INTERVAL_MS, leaseFollowerAbort.signal))) {
                if (!pickerOpen)
                    return;
                await view?.refresh();
                if (!pickerOpen)
                    return;
                const retry = await worker.sync(sessionDir, cwd);
                if (retry.started || retry.reason === "already-running") {
                    view?.setStatusText("Index warming up…");
                    return;
                }
            }
        };
        let selected;
        try {
            selected = await ctx.ui.custom((tui, theme, keybindings, done) => {
                const requestRender = () => tui.requestRender();
                view = new FastResumeView(worker, cwd, currentSessionFilePath, excludedSessionPath, keybindings, theme, done, requestRender);
                const status = sync.started || sync.reason === "already-running"
                    ? "Index warming up…"
                    : sync.reason === "lease-held"
                        ? "Following index scan from another Pi process…"
                        : "";
                view.setStatusText(status);
                if (sync.reason === "lease-held") {
                    leaseFollower = followForeignLease().catch((error) => {
                        const message = error instanceof Error ? error.message : String(error);
                        view?.setStatusText(`Index error: ${message}`);
                    });
                }
                return view;
            }, {
                overlay: true,
                overlayOptions: {
                    width: "100%",
                    maxHeight: "100%",
                    margin: 0,
                },
            });
        }
        finally {
            pickerOpen = false;
            leaseFollowerAbort.abort();
            worker.onProgress(undefined);
            worker.onIndexUpdated(undefined);
            worker.onError(undefined);
            view = undefined;
            await leaseFollower;
        }
        if (!selected)
            return;
        await onSelected(selected);
    }
    pi.on("session_start", async (_event, ctx) => {
        if (!isInteractive(ctx))
            return;
        const sessionDir = sessionRoot(ctx);
        if (!sessionDir)
            return;
        try {
            await getClient().sync(sessionDir, ctx.sessionManager.getCwd());
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Fast-resume background index failed: ${message}`, "warning");
        }
    });
    pi.registerCommand("rf", {
        description: "Open fast resume picker backed by a worker-thread metadata index",
        handler: async (args, ctx) => {
            if (args.trim() === "reindex") {
                const worker = getClient();
                const sessionDir = sessionRoot(ctx);
                if (!sessionDir) {
                    ctx.ui.notify("Pi has no configured session directory", "warning");
                    return;
                }
                const result = await worker.sync(sessionDir, ctx.sessionManager.getCwd(), true);
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
    const forkHandler = async (args, ctx) => {
        if (args.trim()) {
            ctx.ui.notify("Usage: /fork-resume or /fr", "warning");
            return;
        }
        await ctx.waitForIdle();
        await openPicker(ctx, (sourcePath) => forkSelectedSession(ctx, sourcePath), ctx.sessionManager.getSessionFile());
    };
    pi.registerCommand("fork-resume", {
        description: "Fork a session selected through the fast resume picker",
        handler: forkHandler,
    });
    pi.registerCommand("fr", {
        description: "Alias for /fork-resume",
        handler: forkHandler,
    });
    pi.on("session_shutdown", async () => {
        const current = client;
        client = undefined;
        if (current)
            await current.shutdown();
    });
}
//# sourceMappingURL=index.js.map