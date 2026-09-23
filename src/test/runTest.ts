import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");
  const workspacePath = mkdtempSync(
    path.join(tmpdir(), "agent-diff-review-workspace-"),
  );
  const codexHome = mkdtempSync(path.join(tmpdir(), "agenttrail-test-codex-"));
  writeFileSync(path.join(workspacePath, "sample.txt"), "alpha\nbeta\ngamma\n");
  writeFileSync(path.join(workspacePath, "second.txt"), "red\ngreen\nblue\n");
  writeFileSync(path.join(workspacePath, "staged.txt"), "staged content\n");
  execFileSync("git", ["init", "--quiet"], { cwd: workspacePath });
  execFileSync("git", ["add", "staged.txt"], { cwd: workspacePath });

  try {
    await runTests({
      version: "stable",
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: { CODEX_HOME: codexHome },
      launchArgs: [workspacePath, "--disable-extensions", "--disable-workspace-trust"],
    });
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
