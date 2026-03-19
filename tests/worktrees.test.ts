import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { ensureLaneWorktree } from "../extensions/pi-autoresearch/worktrees.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("lane worktrees isolate discard/revert to the owning lane", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-autoresearch-worktrees-"));
  git(repoDir, ["init"]);
  git(repoDir, ["checkout", "-b", "main"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Pi Autoresearch Test"]);

  fs.writeFileSync(path.join(repoDir, "model.txt"), "base\n");
  git(repoDir, ["add", "model.txt"]);
  git(repoDir, ["commit", "-m", "base"]);

  const worktreeRoot = path.join(repoDir, ".autoresearch", "worktrees");
  const exploit = ensureLaneWorktree({
    repoDir,
    worktreePath: path.join(worktreeRoot, "exploit"),
    laneId: "exploit",
    branchPrefix: "demo",
  });
  const explore = ensureLaneWorktree({
    repoDir,
    worktreePath: path.join(worktreeRoot, "explore"),
    laneId: "explore",
    branchPrefix: "demo",
  });

  fs.writeFileSync(path.join(exploit.worktreePath, "model.txt"), "exploit\n");
  fs.writeFileSync(path.join(explore.worktreePath, "model.txt"), "explore\n");

  git(exploit.worktreePath, ["checkout", "--", "."]);
  git(exploit.worktreePath, ["clean", "-fd"]);

  assert.equal(
    fs.readFileSync(path.join(exploit.worktreePath, "model.txt"), "utf8"),
    "base\n"
  );
  assert.equal(
    fs.readFileSync(path.join(explore.worktreePath, "model.txt"), "utf8"),
    "explore\n"
  );
  assert.equal(
    fs.readFileSync(path.join(repoDir, "model.txt"), "utf8"),
    "base\n"
  );
});
