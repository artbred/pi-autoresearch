import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface EnsureLaneWorktreeOptions {
  repoDir: string;
  worktreePath: string;
  laneId: string;
  branchPrefix: string;
}

export interface EnsureLaneWorktreeResult {
  branchName: string;
  worktreePath: string;
  created: boolean;
}

export function sanitizeBranchSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return sanitized || "lane";
}

export function buildLaneBranchName(
  branchPrefix: string,
  laneId: string
): string {
  return `autoresearch/${sanitizeBranchSegment(branchPrefix)}-${sanitizeBranchSegment(laneId)}`;
}

export function ensureLaneWorktree(
  options: EnsureLaneWorktreeOptions
): EnsureLaneWorktreeResult {
  const branchName = buildLaneBranchName(options.branchPrefix, options.laneId);
  const worktreePath = path.resolve(options.worktreePath);

  if (fs.existsSync(path.join(worktreePath, ".git")) || fs.existsSync(path.join(worktreePath, ".git", "index"))) {
    return { branchName, worktreePath, created: false };
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  if (gitBranchExists(options.repoDir, branchName)) {
    execGit(options.repoDir, ["worktree", "add", "-f", worktreePath, branchName]);
  } else {
    execGit(options.repoDir, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
  }

  return { branchName, worktreePath, created: true };
}

function gitBranchExists(repoDir: string, branchName: string): boolean {
  try {
    execGit(repoDir, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

function execGit(repoDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
