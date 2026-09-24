import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { normalizeWorkingDirectory, ProjectIdentityResolver } from "../src/project-identity.ts";

async function createGitRepository(path) {
  await mkdir(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", path]);
  await writeFile(join(path, "README.md"), "synthetic fixture\n", "utf8");
  execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    path,
    "-c",
    "user.name=Pi Fast Resume Test",
    "-c",
    "user.email=pi-fast-resume@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
}

test("normalizes tilde and HOME spellings without resolving relative paths against the process", () => {
  const home = join(tmpdir(), "pi-fast-resume-home");
  assert.equal(normalizeWorkingDirectory("~", home), home);
  assert.equal(normalizeWorkingDirectory("~/repo/../repo", home), join(home, "repo"));
  assert.equal(normalizeWorkingDirectory("$HOME/repo", home), join(home, "repo"));
  assert.equal(normalizeWorkingDirectory("relative/repo", home), undefined);
  assert.equal(normalizeWorkingDirectory("", home), undefined);
});

test("uses the shared Git common directory for nested paths and linked worktrees", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-resume-project-git-"));
  const home = join(root, "home");
  const repository = join(home, "projects", "shared-name");
  const nested = join(repository, "packages", "nested");
  const worktree = join(home, "worktrees", "task");
  const resolver = await ProjectIdentityResolver.create(join(root, "missing-map.json"), home);
  await mkdir(nested, { recursive: true });
  await createGitRepository(repository);
  execFileSync("git", ["-C", repository, "worktree", "add", "--quiet", "--detach", worktree]);
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.ok(existsSync(nested));
  assert.equal(await resolver.resolve(repository), await resolver.resolve(nested));
  assert.equal(await resolver.resolve(repository), await resolver.resolve(worktree));
});

test("does not merge independent repositories with the same basename", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-resume-project-clones-"));
  const home = join(root, "home");
  const first = join(home, "one", "same-name");
  const second = join(home, "two", "same-name");
  await createGitRepository(first);
  await createGitRepository(second);
  const resolver = await ProjectIdentityResolver.create(join(root, "missing-map.json"), home);
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.notEqual(await resolver.resolve(first), await resolver.resolve(second));
});

test("uses normalized path identity for non-Git and unresolved directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-resume-project-path-"));
  const home = join(root, "home");
  const nonGit = join(home, "notes");
  await mkdir(nonGit, { recursive: true });
  const resolver = await ProjectIdentityResolver.create(join(root, "missing-map.json"), home);
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(await resolver.resolve(nonGit), await resolver.resolve("$HOME/notes", home));
  assert.notEqual(await resolver.resolve(nonGit), await resolver.resolve(join(home, "deleted", "notes")));
});

test("maps a missing historical worktree only through an explicit longest path-prefix mapping", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-resume-project-map-"));
  const home = join(root, "home");
  const repository = join(home, "projects", "canonical");
  const configPath = join(root, "project-map.json");
  await createGitRepository(repository);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      mappings: [
        { cwdPrefix: "~/workspaces/team", projectRoot: repository },
        { cwdPrefix: "~/workspaces/team/special", projectRoot: repository },
      ],
    }),
    "utf8",
  );
  const resolver = await ProjectIdentityResolver.create(configPath, home);
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(await resolver.resolve("~/workspaces/team/deleted/task"), await resolver.resolve(repository));
  assert.equal(await resolver.resolve("~/workspaces/team/special/deleted/task"), await resolver.resolve(repository));
  assert.notEqual(await resolver.resolve("~/workspaces/team-other/task"), await resolver.resolve(repository));
});

test("an absent or empty project map falls back to Git identity and then normalized path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-resume-project-empty-map-"));
  const home = join(root, "home");
  const repository = join(home, "repo");
  const mapPath = join(root, "project-map.json");
  await createGitRepository(repository);
  await mkdir(join(repository, "nested"), { recursive: true });
  await writeFile(mapPath, JSON.stringify({ version: 1, mappings: [] }), "utf8");
  const resolver = await ProjectIdentityResolver.create(mapPath, home);
  const missingMapResolver = await ProjectIdentityResolver.create(join(root, "absent.json"), home);
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(await resolver.resolve(repository), await resolver.resolve(join(repository, "nested")));
  assert.equal(await resolver.resolve(repository), await missingMapResolver.resolve(repository));
  assert.equal(await missingMapResolver.resolve("~/deleted/repo"), await missingMapResolver.resolve(join(home, "deleted", "repo")));
});
