/** Expand home-directory spellings and lexically normalize absolute cwd values. */
export declare function normalizeWorkingDirectory(value: string, homeDirectory?: string): string | undefined;
/** Resolve project identity off the TUI thread, preferring explicit historical mappings. */
export declare class ProjectIdentityResolver {
    private readonly cache;
    private readonly mappings;
    private readonly homeDirectory;
    readonly sourceFingerprint: string;
    readonly warning?: string;
    private constructor();
    static fingerprint(mapPath: string): Promise<string>;
    static create(mapPath: string, homeDirectory?: string): Promise<ProjectIdentityResolver>;
    resolve(cwd: string): Promise<string>;
    private resolveUncached;
}
//# sourceMappingURL=project-identity.d.ts.map