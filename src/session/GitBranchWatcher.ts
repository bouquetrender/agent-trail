import { execFile } from "child_process";
import { watch } from "fs";
import type { FSWatcher } from "fs";
import { readFile } from "fs/promises";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class GitBranchWatcher {
  private readonly watchers: FSWatcher[] = [];
  private disposed = false;

  constructor(
    private readonly onDidChange: () => void,
    private readonly onError: (error: unknown) => void,
  ) {}

  async start(workspacePaths: readonly string[]): Promise<void> {
    const directories = new Set<string>();
    for (const workspacePath of workspacePaths) {
      let directory: string;
      try {
        const { stdout } = await execFileAsync(
          "git", ["rev-parse", "--absolute-git-dir"], { cwd: workspacePath },
        );
        directory = stdout.trim();
      } catch (error) {
        if (
          error instanceof Error && "code" in error &&
          (error.code === 128 || error.code === "ENOENT")
        ) {
          // Non-Git workspaces and machines without Git keep memory baselines.
          continue;
        }
        throw error;
      }
      if (this.disposed) {
        return;
      }
      if (directories.has(directory)) {
        continue;
      }
      directories.add(directory);
      const headPath = path.join(directory, "HEAD");
      let previousHead = await readFile(headPath, "utf8");
      if (this.disposed) {
        return;
      }
      let pending = Promise.resolve();
      const check = (): void => {
        pending = pending.then(async () => {
          if (this.disposed) {
            return;
          }
          const head = await readFile(headPath, "utf8");
          if (!this.disposed && head !== previousHead) {
            previousHead = head;
            this.onDidChange();
          }
        }).catch((error) => {
          if (!this.disposed) {
            this.onError(error);
          }
        });
      };
      // Git replaces HEAD atomically; watch its directory, including worktree Git dirs.
      // Comparing the symbolic ref also detects branches at the same commit,
      // without resetting the review on ordinary commits to the current branch.
      const watcher = watch(directory, (_event, filename) => {
        if (filename === null || filename === "HEAD") {
          check();
        }
      });
      watcher.on("error", this.onError);
      this.watchers.push(watcher);
      check();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.watchers.forEach((watcher) => watcher.close());
    this.watchers.length = 0;
  }
}
