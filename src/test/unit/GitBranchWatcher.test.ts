import * as assert from "assert";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { GitBranchWatcher } from "../../session/GitBranchWatcher";

suite("Git branch watcher", () => {
  let directory: string;
  let repository: string;
  let watcher: GitBranchWatcher;
  let changes: number;
  let errors: unknown[];

  setup(() => {
    directory = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-branch-watch-")));
    repository = path.join(directory, "repository");
    mkdirSync(repository);
    git(repository, "init", "--quiet", "--initial-branch=main");
    writeFileSync(path.join(repository, "sample.txt"), "original\n");
    git(repository, "add", "sample.txt");
    git(repository, "commit", "--quiet", "-m", "Initial");
    changes = 0;
    errors = [];
    watcher = new GitBranchWatcher(() => changes++, (error) => errors.push(error));
  });

  teardown(() => {
    watcher.dispose();
    rmSync(directory, { recursive: true, force: true });
    assert.deepStrictEqual(errors, []);
  });

  test("detects switches at the same commit but ignores ordinary commits and file edits", async () => {
    const nested = path.join(repository, "nested");
    mkdirSync(nested);
    await watcher.start([repository, nested]);
    git(repository, "switch", "--quiet", "-c", "feature");
    await waitFor(() => changes === 1);

    writeFileSync(path.join(repository, "sample.txt"), "updated\n");
    git(repository, "add", "sample.txt");
    git(repository, "commit", "--quiet", "-m", "Update");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.strictEqual(changes, 1);

    git(repository, "switch", "--quiet", "main");
    await waitFor(() => changes === 2);
  });

  test("observes the worktree Git directory and detached HEAD transitions", async () => {
    const worktree = path.join(directory, "linked");
    git(repository, "worktree", "add", "--quiet", "-b", "linked", worktree);
    await watcher.start([worktree]);
    git(worktree, "switch", "--quiet", "-c", "linked-feature");
    await waitFor(() => changes === 1);
    git(worktree, "checkout", "--quiet", "--detach", "HEAD");
    await waitFor(() => changes === 2);
    git(worktree, "switch", "--quiet", "linked");
    await waitFor(() => changes === 3);
  });

  test("supports non-Git roots and stops delivering changes after disposal", async () => {
    await watcher.start([directory, repository]);
    watcher.dispose();
    git(repository, "switch", "--quiet", "-c", "after-dispose");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.strictEqual(changes, 0);
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [
    "-c", "user.name=Agent Review Test", "-c", "user.email=review@example.test",
    "-c", "commit.gpgsign=false", ...args,
  ], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(condition(), "Git branch change was not observed");
}
