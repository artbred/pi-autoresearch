import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);
const templatePath = path.join(
  repoRoot,
  "skills",
  "kaggle-autoresearch",
  "templates",
  "autoresearch.sh.template"
);

function setupWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-autoresearch-template-"));
  fs.copyFileSync(templatePath, path.join(dir, "autoresearch.sh"));
  fs.chmodSync(path.join(dir, "autoresearch.sh"), 0o755);

  fs.writeFileSync(
    path.join(dir, "build_notebook.py"),
    [
      "#!/usr/bin/env python3",
      "import argparse",
      "from pathlib import Path",
      "parser = argparse.ArgumentParser()",
      "parser.add_argument('--input')",
      "parser.add_argument('--output')",
      "args = parser.parse_args()",
      "Path(args.output).write_text('{}\\n')",
      "",
    ].join("\n")
  );
  fs.chmodSync(path.join(dir, "build_notebook.py"), 0o755);

  fs.writeFileSync(
    path.join(dir, "notebook.py"),
    [
      "#!/usr/bin/env python3",
      "import csv",
      "import json",
      "from pathlib import Path",
      "Path('outputs').mkdir(parents=True, exist_ok=True)",
      "Path('outputs/metrics.json').write_text(json.dumps({'cv_score': 0.42, 'wall_clock_seconds': 1.0}, indent=2) + '\\n')",
      "with Path('submission.csv').open('w', newline='') as handle:",
      "    writer = csv.DictWriter(handle, fieldnames=['id', 'target'])",
      "    writer.writeheader()",
      "    writer.writerow({'id': '1', 'target': '0.1000000000'})",
      "    writer.writerow({'id': '2', 'target': '0.2000000000'})",
      "",
    ].join("\n")
  );
  fs.chmodSync(path.join(dir, "notebook.py"), 0o755);

  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "kaggle"),
    [
      "#!/usr/bin/env python3",
      "import json",
      "import os",
      "import sys",
      "from pathlib import Path",
      "",
      "state_path = Path(os.environ['KAGGLE_STUB_STATE'])",
      "if state_path.exists():",
      "    state = json.loads(state_path.read_text())",
      "else:",
      "    state = {'submission_count': 0, 'score': 0.55, 'rank': 123}",
      "",
      "args = sys.argv[1:]",
      "if args[:2] == ['competitions', 'files']:",
      "    raise SystemExit(0)",
      "if args[:2] == ['competitions', 'submissions']:",
      "    print('SubmissionId,Date,Score')",
      "    count = state.get('submission_count', 0)",
      "    if count:",
      "        print(f\"sub-{count},2026-03-20 12:00:00,{state.get('score', 0.55)}\")",
      "    raise SystemExit(0)",
      "if args[:2] == ['competitions', 'submit']:",
      "    state['submission_count'] = state.get('submission_count', 0) + 1",
      "    state_path.write_text(json.dumps(state))",
      "    print(f\"submitted sub-{state['submission_count']}\")",
      "    raise SystemExit(0)",
      "if args[:2] == ['competitions', 'leaderboard']:",
      "    out_dir = Path(args[args.index('-p') + 1])",
      "    out_dir.mkdir(parents=True, exist_ok=True)",
      "    (out_dir / 'demo-leaderboard.csv').write_text('TeamName,Rank,Score\\nstub-team,123,0.55\\n')",
      "    raise SystemExit(0)",
      "if args[:2] == ['kernels', 'push']:",
      "    raise SystemExit(0)",
      "if args[:2] == ['kernels', 'status']:",
      "    print('complete')",
      "    raise SystemExit(0)",
      "if args[:2] == ['kernels', 'output']:",
      "    raise SystemExit(0)",
      "raise SystemExit(f'Unsupported kaggle stub args: {args}')",
      "",
    ].join("\n")
  );
  fs.chmodSync(path.join(binDir, "kaggle"), 0o755);
  fs.writeFileSync(path.join(dir, "kaggle_stub_state.json"), JSON.stringify({ submission_count: 0 }));

  return dir;
}

function runScript(workspace: string, args: string[], extraEnv: Record<string, string> = {}) {
  return execFileSync("bash", ["autoresearch.sh", ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(workspace, "bin")}:${process.env.PATH ?? ""}`,
      KAGGLE_STUB_STATE: path.join(workspace, "kaggle_stub_state.json"),
      KAGGLE_API_TOKEN: "dummy",
      LEADERBOARD_TEAM_NAME: "stub-team",
      COMPETITION_SLUG: "demo",
      COMPETITION_URL: "https://example.com/demo",
      KERNEL_OWNER: "stub-owner",
      KERNEL_SLUG: "stub-kernel",
      NOTEBOOK_RUNTIME_LIMIT_SECONDS: "10",
      NOTEBOOK_RUNTIME_SAFETY_MARGIN_SECONDS: "2",
      NOTEBOOK_RUNTIME_BUDGET_SECONDS: "8",
      MAX_DAILY_SUBMISSIONS: "5",
      CV_DIRECTION: "higher",
      SUBMISSION_FILE: "submission.csv",
      POST_SUBMIT_SLEEP_SECONDS: "0",
      LOCAL_ACCELERATOR: "cpu",
      ...extraEnv,
    },
  });
}

function writeCandidateFixture(
  workspace: string,
  candidateId: string,
  rows: Array<{ id: string; target: string }>,
  cvScore: number
) {
  const candidateDir = path.join(workspace, "outputs", "candidates", candidateId);
  fs.mkdirSync(candidateDir, { recursive: true });
  const submissionRelative = path.join("outputs", "candidates", candidateId, "submission.csv");
  const submissionPath = path.join(workspace, submissionRelative);
  const csv =
    "id,target\n" +
    rows.map((row) => `${row.id},${row.target}`).join("\n") +
    "\n";
  fs.writeFileSync(submissionPath, csv);
  fs.writeFileSync(
    path.join(candidateDir, "manifest.json"),
    JSON.stringify(
      {
        candidate_id: candidateId,
        submission_file: submissionRelative,
        metrics: { cv_score: cvScore },
        pending_priority: cvScore,
        public_rank: 999999,
        public_score: 0,
      },
      null,
      2
    ) + "\n"
  );
}

test("local-only mode creates a candidate manifest", () => {
  const workspace = setupWorkspace();
  runScript(workspace, ["--local-only", "alpha"]);

  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(workspace, "outputs", "candidates", "alpha", "manifest.json"),
      "utf8"
    )
  );
  assert.equal(manifest.candidate_id, "alpha");
  assert.equal(manifest.score_state, "local_only");
  assert.equal(manifest.metrics.cv_score, 0.42);
});

test("merge-candidates mode builds an artifact-level merged candidate", () => {
  const workspace = setupWorkspace();
  writeCandidateFixture(workspace, "alpha", [
    { id: "1", target: "0.10" },
    { id: "2", target: "0.20" },
  ], 0.41);
  writeCandidateFixture(workspace, "beta", [
    { id: "1", target: "0.30" },
    { id: "2", target: "0.40" },
  ], 0.55);

  runScript(workspace, ["--merge-candidates", "alpha,beta"], {
    CANDIDATE_ID: "merged",
  });

  const mergedManifest = JSON.parse(
    fs.readFileSync(
      path.join(workspace, "outputs", "candidates", "merged", "manifest.json"),
      "utf8"
    )
  );
  const mergedCsv = fs.readFileSync(path.join(workspace, "submission.csv"), "utf8");
  assert.equal(mergedManifest.candidate_id, "merged");
  assert.deepEqual(mergedManifest.merge_inputs, ["alpha", "beta"]);
  assert.match(mergedCsv, /1,0\.2000000000/);
  assert.match(mergedCsv, /2,0\.3000000000/);
});

test("submit-candidate mode refreshes public state deterministically", () => {
  const workspace = setupWorkspace();
  writeCandidateFixture(workspace, "alpha", [
    { id: "1", target: "0.10" },
    { id: "2", target: "0.20" },
  ], 0.62);
  fs.mkdirSync(path.join(workspace, "outputs"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "outputs", "pending_submission_queue.jsonl"),
    JSON.stringify({ candidate_id: "alpha", priority: 0.62, timestamp: 1 }) + "\n"
  );

  runScript(workspace, ["--submit-candidate", "alpha"]);

  const state = JSON.parse(
    fs.readFileSync(path.join(workspace, "outputs", "kaggle_state.json"), "utf8")
  );
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(workspace, "outputs", "candidates", "alpha", "manifest.json"),
      "utf8"
    )
  );
  const queue = fs.readFileSync(
    path.join(workspace, "outputs", "pending_submission_queue.jsonl"),
    "utf8"
  );

  assert.equal(state.last_candidate_id, "alpha");
  assert.equal(state.last_submission_id, "sub-1");
  assert.equal(manifest.score_state, "public_scored");
  assert.equal(queue.trim(), "");
});
