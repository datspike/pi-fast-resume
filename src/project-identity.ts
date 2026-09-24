import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

interface ProjectMapEntry {
  cwdPrefix: string;
  projectRoot: string;
}

interface ResolvedProjectMapEntry {
  cwdPrefix: string;
  projectKey: string;
}

interface ProjectMapFile {
  version: number;
  mappings: ProjectMapEntry[];
}

const GIT_TIMEOUT_MS = 1_500;

/** Expand home-directory spellings and lexically normalize absolute cwd values. */
export function normalizeWorkingDirectory(value: string, homeDirectory = homedir()): string | undefined {
  if (!value || value.includes("\0")) return undefined;

  let expanded = value;
  if (expanded === "~" || expanded === "$HOME") expanded = homeDirectory;
  else if (expanded.startsWith("~/")) expanded = resolve(homeDirectory, expanded.slice(2));
  else if (expanded.startsWith("$HOME/")) expanded = resolve(homeDirectory, expanded.slice(6));

  return isAbsolute(expanded) ? resolve(expanded) : undefined;
}

/** Resolve project identity off the TUI thread, preferring explicit historical mappings. */
export class ProjectIdentityResolver {
  private readonly cache = new Map<string, Promise<string>>();
  private readonly mappings: ResolvedProjectMapEntry[];
  private readonly homeDirectory: string;
  readonly sourceFingerprint: string;
  readonly warning?: string;

  private constructor(
    mappings: ResolvedProjectMapEntry[],
    homeDirectory: string,
    sourceFingerprint: string,
    warning?: string,
  ) {
    this.mappings = mappings;
    this.homeDirectory = homeDirectory;
    this.sourceFingerprint = sourceFingerprint;
    this.warning = warning;
  }

  static async fingerprint(mapPath: string): Promise<string> {
    try {
      return fingerprintContents(await readFile(mapPath));
    } catch (error) {
      return isMissingFile(error) ? "missing" : "unreadable";
    }
  }

  static async create(mapPath: string, homeDirectory = homedir()): Promise<ProjectIdentityResolver> {
    let contents: Buffer;
    try {
      contents = await readFile(mapPath);
    } catch (error) {
      if (isMissingFile(error)) return new ProjectIdentityResolver([], homeDirectory, "missing");
      return new ProjectIdentityResolver([], homeDirectory, "unreadable", "Project map could not be read; using Git/path fallback");
    }

    const sourceFingerprint = fingerprintContents(contents);
    let payload: ProjectMapFile;
    try {
      payload = JSON.parse(contents.toString("utf8")) as ProjectMapFile;
    } catch {
      return new ProjectIdentityResolver([], homeDirectory, sourceFingerprint, "Project map could not be read; using Git/path fallback");
    }

    if (payload?.version !== 1 || !Array.isArray(payload.mappings)) {
      return new ProjectIdentityResolver([], homeDirectory, sourceFingerprint, "Project map has an unsupported format; using Git/path fallback");
    }

    const mappings: ResolvedProjectMapEntry[] = [];
    let skipped = 0;
    for (const entry of payload.mappings) {
      if (!entry || typeof entry.cwdPrefix !== "string" || typeof entry.projectRoot !== "string") {
        skipped += 1;
        continue;
      }
      const cwdPrefix = normalizeWorkingDirectory(entry.cwdPrefix, homeDirectory);
      const projectRoot = normalizeWorkingDirectory(entry.projectRoot, homeDirectory);
      if (!cwdPrefix || !projectRoot || !(await isDirectory(projectRoot))) {
        skipped += 1;
        continue;
      }
      const commonDirectory = await getGitCommonDirectory(projectRoot, homeDirectory);
      if (!commonDirectory) {
        skipped += 1;
        continue;
      }
      mappings.push({ cwdPrefix, projectKey: `git:${commonDirectory}` });
    }

    const warning = skipped ? `Project map skipped ${skipped} invalid or non-Git entr${skipped === 1 ? "y" : "ies"}` : undefined;
    mappings.sort((left, right) => right.cwdPrefix.length - left.cwdPrefix.length);
    return new ProjectIdentityResolver(mappings, homeDirectory, sourceFingerprint, warning);
  }

  resolve(cwd: string): Promise<string> {
    const normalized = normalizeWorkingDirectory(cwd, this.homeDirectory);
    if (!normalized) return Promise.resolve(`path:unresolved:${cwd}`);

    const cached = this.cache.get(normalized);
    if (cached) return cached;

    const pending = this.resolveUncached(normalized);
    this.cache.set(normalized, pending);
    return pending;
  }

  private async resolveUncached(cwd: string): Promise<string> {
    const mapping = this.mappings.find((entry) => isWithin(cwd, entry.cwdPrefix));
    if (mapping) return mapping.projectKey;

    if (!(await isDirectory(cwd))) return `path:${cwd}`;
    const commonDirectory = await getGitCommonDirectory(cwd, this.homeDirectory);
    return commonDirectory ? `git:${commonDirectory}` : `path:${cwd}`;
  }
}


function isWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith(sep) ? prefix : `${prefix}${sep}`);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function getGitCommonDirectory(cwd: string, homeDirectory: string): Promise<string | undefined> {
  return new Promise((resolveResult) => {
    execFile(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 4_096, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolveResult(undefined);
          return;
        }
        const commonDirectory = normalizeWorkingDirectory(stdout.trim(), homeDirectory);
        resolveResult(commonDirectory);
      },
    );
  });
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function fingerprintContents(contents: Uint8Array): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}
