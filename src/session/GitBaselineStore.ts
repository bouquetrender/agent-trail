import { spawn } from "child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { TextDecoder } from "util";
import * as vscode from "vscode";
import { localize } from "../localize";
import type {
  BaselineCaptureOptions,
  BaselineStore,
} from "./BaselineStore";

interface GitEntry {
  readonly uri: vscode.Uri;
  readonly path: string;
}

export class GitBaselineStore implements BaselineStore {
  readonly kind = "git" as const;

  private readonly entries = new Map<string, GitEntry>();
  private readonly tempDirectory: string;
  private readonly indexPath: string;
  private readonly objectDirectory: string;
  private treeId: string | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly repositoryRoot: string,
    private readonly repositoryObjectDirectory: string,
    private readonly realIndexPath: string,
    private readonly workspaceRoot: string,
    private readonly workspaceRootUri: vscode.Uri,
    private readonly repositoryRelativeWorkspaceRoot: string,
  ) {
    this.tempDirectory = mkdtempSync(path.join(tmpdir(), "agent-diff-review-git-"));
    this.indexPath = path.join(this.tempDirectory, "index");
    this.objectDirectory = path.join(this.tempDirectory, "objects");
    mkdirSync(this.objectDirectory);
  }

  static async create(workspaceRoot: vscode.Uri): Promise<GitBaselineStore> {
    if (workspaceRoot.scheme !== "file") {
      throw new Error("Git baselines require a local file workspace.");
    }

    const discoveredRoot = (
      await runGit(workspaceRoot.fsPath, ["rev-parse", "--show-toplevel"])
    )
      .toString("utf8")
      .trim();
    const repositoryRoot = realpathSync(discoveredRoot);
    const objectPath = (
      await runGit(repositoryRoot, ["rev-parse", "--git-path", "objects"])
    )
      .toString("utf8")
      .trim();
    const discoveredObjectDirectory = path.isAbsolute(objectPath)
      ? objectPath
      : path.resolve(repositoryRoot, objectPath);
    const repositoryObjectDirectory = realpathSync(discoveredObjectDirectory);
    const indexPath = (
      await runGit(repositoryRoot, ["rev-parse", "--git-path", "index"])
    )
      .toString("utf8")
      .trim();
    const realIndexPath = path.isAbsolute(indexPath)
      ? indexPath
      : path.resolve(repositoryRoot, indexPath);
    const workspaceRootPath = path.resolve(workspaceRoot.fsPath);
    const canonicalWorkspaceRoot = realpathSync(workspaceRootPath);
    const repositoryRelativeWorkspaceRoot = path
      .relative(repositoryRoot, canonicalWorkspaceRoot)
      .split(path.sep)
      .join("/");

    return new GitBaselineStore(
      repositoryRoot,
      repositoryObjectDirectory,
      realIndexPath,
      workspaceRootPath,
      workspaceRoot,
      repositoryRelativeWorkspaceRoot,
    );
  }

  async capture(options?: BaselineCaptureOptions): Promise<void> {
    this.entries.clear();
    this.treeId = undefined;
    options?.report?.(localize("Discovering Git workspace files…", "正在查找 Git 工作区文件…"));
    const uris = options?.uris ?? (await this.discoverUris());
    options?.report?.(localize(`Preparing isolated Git index for ${uris.length} files…`, `正在准备 ${uris.length} 个文件的审查基线…`));

    if (existsSync(this.realIndexPath)) {
      copyFileSync(this.realIndexPath, this.indexPath);
    } else {
      await this.git(["read-tree", "--empty"]);
    }

    const paths: string[] = [];
    for (const uri of uris) {
      const relativePath = this.relativePath(uri);
      if (!relativePath || !isRegularFile(uri)) {
        continue;
      }
      this.entries.set(uri.toString(), { uri, path: relativePath });
      paths.push(relativePath);
    }

    if (paths.length > 0) {
      options?.report?.(localize("Writing workspace state to temporary Git tree…", "正在保存工作区基线…"));
      await this.git(
        [
          "add",
          "--all",
          "--force",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ],
        Buffer.from(`${paths.join("\0")}\0`),
      );
    }
    this.treeId = (await this.git(["write-tree"])).toString("utf8").trim();
  }

  clear(): void {
    this.entries.clear();
    this.treeId = undefined;
    void this.writeQueue.finally(() => {
      rmSync(this.tempDirectory, { recursive: true, force: true });
    });
  }

  has(uri: vscode.Uri): boolean {
    return this.entries.has(uri.toString());
  }

  async get(uri: vscode.Uri): Promise<string | undefined> {
    await this.writeQueue;
    const entry = this.entries.get(uri.toString());
    if (!entry || !this.treeId) {
      return undefined;
    }

    const bytes = await this.git(["show", `${this.treeId}:${entry.path}`]);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  async set(uri: vscode.Uri, content: string): Promise<void> {
    const entry = this.entries.get(uri.toString());
    if (!entry) {
      return;
    }

    const write = this.writeQueue.then(() => this.updateEntry(entry, content));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private async updateEntry(entry: GitEntry, content: string): Promise<void> {
    const stage = (
      await this.git(["ls-files", "--stage", "--", entry.path])
    ).toString("utf8");
    const mode = /^(\d{6})\s/.exec(stage)?.[1] ?? "100644";
    const objectId = (
      await this.git(["hash-object", "-w", "--stdin"], Buffer.from(content, "utf8"))
    )
      .toString("utf8")
      .trim();
    await this.git([
      "update-index",
      "--add",
      "--cacheinfo",
      mode,
      objectId,
      entry.path,
    ]);
    this.treeId = (await this.git(["write-tree"])).toString("utf8").trim();
  }

  uris(): readonly vscode.Uri[] {
    return [...this.entries.values()].map(({ uri }) => uri);
  }

  private relativePath(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== "file") {
      return undefined;
    }
    const workspaceRelativePath = path.relative(
      this.workspaceRoot,
      path.resolve(uri.fsPath),
    );
    if (
      workspaceRelativePath === "" ||
      workspaceRelativePath === ".." ||
      workspaceRelativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(workspaceRelativePath)
    ) {
      return undefined;
    }
    return path.posix.join(
      this.repositoryRelativeWorkspaceRoot,
      workspaceRelativePath.split(path.sep).join("/"),
    );
  }

  private async discoverUris(): Promise<vscode.Uri[]> {
    const pathspec = this.repositoryRelativeWorkspaceRoot || ".";
    const output = await runGit(this.repositoryRoot, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      pathspec,
    ]);
    const paths = output.toString("utf8").split("\0").filter(Boolean);

    return paths.flatMap((repositoryPath) => {
      const workspacePath = path.posix.relative(
        this.repositoryRelativeWorkspaceRoot || ".",
        repositoryPath,
      );
      if (
        workspacePath === "" ||
        workspacePath === ".." ||
        workspacePath.startsWith("../") ||
        workspacePath.split("/").includes("node_modules")
      ) {
        return [];
      }
      return [vscode.Uri.joinPath(this.workspaceRootUri, ...workspacePath.split("/"))];
    });
  }

  private git(args: readonly string[], input?: Buffer): Promise<Buffer> {
    return runGit(this.repositoryRoot, args, input, {
      GIT_INDEX_FILE: this.indexPath,
      GIT_OBJECT_DIRECTORY: this.objectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: this.repositoryObjectDirectory,
    });
  }
}

function isRegularFile(uri: vscode.Uri): boolean {
  try {
    return lstatSync(uri.fsPath).isFile();
  } catch {
    return false;
  }
}

function runGit(
  cwd: string,
  args: readonly string[],
  input?: Buffer,
  environment?: NodeJS.ProcessEnv,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", () => {
      // Process exit is reported by the close handler with Git's stderr.
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        reject(
          new Error(
            `git ${args[0] ?? "command"} failed (${code}): ${Buffer.concat(
              stderr,
            ).toString("utf8")}`,
          ),
        );
      }
    });
    child.stdin.end(input);
  });
}
