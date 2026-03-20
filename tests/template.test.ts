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

function defaultStubState() {
  return {
    submission_count: 0,
    score: 0.55,
    rank: 123,
    latest_submission_id: "",
    latest_submission_score: "",
    latest_submission_status: "pending",
    kernels_push_count: 0,
    kernel_version_id: "",
    kernel_run_id: "",
    kernel_status: "running",
    notebook_score_request_count: 0,
    notebook_score_requested_version_id: "",
  };
}

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

  fs.writeFileSync(
    path.join(dir, "kernel-metadata.json"),
    JSON.stringify({ id: "stub-owner/stub-kernel" }, null, 2) + "\n"
  );

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
      "    state = {",
      "        'submission_count': 0,",
      "        'score': 0.55,",
      "        'rank': 123,",
      "        'latest_submission_id': '',",
      "        'latest_submission_score': '',",
      "        'latest_submission_status': 'pending',",
      "        'kernels_push_count': 0,",
      "        'kernel_version_id': '',",
      "        'kernel_run_id': '',",
      "        'kernel_status': 'running',",
      "        'notebook_score_request_count': 0,",
      "        'notebook_score_requested_version_id': '',",
      "    }",
      "",
      "def save():",
      "    state_path.write_text(json.dumps(state))",
      "",
      "args = sys.argv[1:]",
      "if args[:2] == ['competitions', 'files']:",
      "    raise SystemExit(0)",
      "if args[:2] == ['competitions', 'submissions']:",
      "    print('SubmissionId,Date,Score,Status')",
      "    submission_id = state.get('latest_submission_id', '')",
      "    if submission_id:",
      "        print(f\"{submission_id},2026-03-20 12:00:00,{state.get('latest_submission_score', '')},{state.get('latest_submission_status', 'pending')}\")",
      "    raise SystemExit(0)",
      "if args[:2] == ['competitions', 'submit']:",
      "    state['submission_count'] = state.get('submission_count', 0) + 1",
      "    state['latest_submission_id'] = f\"sub-{state['submission_count']}\"",
      "    state['latest_submission_score'] = ''",
      "    state['latest_submission_status'] = 'pending'",
      "    save()",
      "    print(json.dumps({'submission_id': state['latest_submission_id']}))",
      "    raise SystemExit(0)",
      "if args[:2] == ['competitions', 'leaderboard']:",
      "    out_dir = Path(args[args.index('-p') + 1])",
      "    out_dir.mkdir(parents=True, exist_ok=True)",
      "    (out_dir / 'demo-leaderboard.csv').write_text(f\"TeamName,Rank,Score\\nstub-team,{state.get('rank', 123)},{state.get('score', 0.55)}\\n\")",
      "    raise SystemExit(0)",
      "if args[:2] == ['kernels', 'push']:",
      "    state['kernels_push_count'] = state.get('kernels_push_count', 0) + 1",
      "    state['kernel_version_id'] = f\"kv-{state['kernels_push_count']}\"",
      "    state['kernel_run_id'] = f\"kr-{state['kernels_push_count']}\"",
      "    state['kernel_status'] = state.get('kernel_status', 'running') or 'running'",
      "    save()",
      "    print(json.dumps({'kernel_version_id': state['kernel_version_id'], 'kernel_run_id': state['kernel_run_id'], 'status': state['kernel_status']}))",
      "    raise SystemExit(0)",
      "if args[:2] == ['kernels', 'status']:",
      "    print(json.dumps({'status': state.get('kernel_status', 'running'), 'kernel_version_id': state.get('kernel_version_id', ''), 'kernel_run_id': state.get('kernel_run_id', '')}))",
      "    raise SystemExit(0)",
      "if args[:2] == ['kernels', 'output']:",
      "    out_dir = Path(args[args.index('-p') + 1])",
      "    out_dir.mkdir(parents=True, exist_ok=True)",
      "    (out_dir / 'submission.csv').write_text('id,target\\n1,0.1000000000\\n2,0.2000000000\\n')",
      "    raise SystemExit(0)",
      "if args[:1] == ['notebook-score']:",
      "    state['notebook_score_request_count'] = state.get('notebook_score_request_count', 0) + 1",
      "    state['notebook_score_requested_version_id'] = os.environ.get('KERNEL_VERSION_ID', '')",
      "    state['submission_count'] = state.get('submission_count', 0) + 1",
      "    state['latest_submission_id'] = f\"sub-{state['submission_count']}\"",
      "    state['latest_submission_score'] = ''",
      "    state['latest_submission_status'] = 'pending'",
      "    save()",
      "    print(json.dumps({'score_request_id': f\"req-{state['notebook_score_request_count']}\", 'submission_id': state['latest_submission_id']}))",
      "    raise SystemExit(0)",
      "raise SystemExit(f'Unsupported kaggle stub args: {args}')",
      "",
    ].join("\n")
  );
  fs.chmodSync(path.join(binDir, "kaggle"), 0o755);
  fs.writeFileSync(
    path.join(dir, "kaggle_stub_state.json"),
    JSON.stringify(defaultStubState())
  );

  return dir;
}

function runScript(
  workspace: string,
  args: string[],
  extraEnv: Record<string, string> = {}
) {
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
      COMPETITION_MODE: "file_upload",
      KERNEL_OWNER: "stub-owner",
      KERNEL_SLUG: "stub-kernel",
      NOTEBOOK_RUNTIME_LIMIT_SECONDS: "10",
      NOTEBOOK_RUNTIME_SAFETY_MARGIN_SECONDS: "2",
      NOTEBOOK_RUNTIME_BUDGET_SECONDS: "8",
      MAX_DAILY_SUBMISSIONS: "5",
      CV_DIRECTION: "higher",
      SUBMISSION_FILE: "submission.csv",
      KAGGLE_NOTEBOOK_POLL_SECONDS: "0",
      KAGGLE_SCORE_POLL_SECONDS: "0",
      KAGGLE_PENDING_TIMEOUT_MINUTES: "180",
      LOCAL_ACCELERATOR: "cpu",
      ...extraEnv,
    },
  });
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readStubState(workspace: string) {
  return readJson(path.join(workspace, "kaggle_stub_state.json"));
}

function writeStubState(workspace: string, updates: Record<string, unknown>) {
  const current = readStubState(workspace);
  fs.writeFileSync(
    path.join(workspace, "kaggle_stub_state.json"),
    JSON.stringify({ ...current, ...updates })
  );
}

function writeCandidateFixture(
  workspace: string,
  candidateId: string,
  rows: Array<{ id: string; target: string }>,
  cvScore: number
) {
  const candidateDir = path.join(workspace, "outputs", "candidates", candidateId);
  const artifactsDir = path.join(candidateDir, "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  const submissionRelative = path.join(
    "outputs",
    "candidates",
    candidateId,
    "artifacts",
    "submission.csv"
  );
  const notebookRelative = path.join(
    "outputs",
    "candidates",
    candidateId,
    "artifacts",
    "notebook.ipynb"
  );
  const submissionPath = path.join(workspace, submissionRelative);
  const csv =
    "id,target\n" +
    rows.map((row) => `${row.id},${row.target}`).join("\n") +
    "\n";
  fs.writeFileSync(submissionPath, csv);
  fs.writeFileSync(path.join(workspace, notebookRelative), "{}\n");
  fs.writeFileSync(
    path.join(candidateDir, "manifest.json"),
    JSON.stringify(
      {
        candidate_id: candidateId,
        submission_file: submissionRelative,
        notebook_ipynb: notebookRelative,
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

  const manifest = readJson(
    path.join(workspace, "outputs", "candidates", "alpha", "manifest.json")
  );
  assert.equal(manifest.candidate_id, "alpha");
  assert.equal(manifest.score_state, "local_only");
  assert.equal(manifest.metrics.cv_score, 0.42);
  assert.match(manifest.notebook_ipynb, /notebook\.ipynb$/);
});

test("merge-candidates mode builds an artifact-level merged candidate", () => {
  const workspace = setupWorkspace();
  writeCandidateFixture(
    workspace,
    "alpha",
    [
      { id: "1", target: "0.10" },
      { id: "2", target: "0.20" },
    ],
    0.41
  );
  writeCandidateFixture(
    workspace,
    "beta",
    [
      { id: "1", target: "0.30" },
      { id: "2", target: "0.40" },
    ],
    0.55
  );

  runScript(workspace, ["--merge-candidates", "alpha,beta"], {
    CANDIDATE_ID: "merged",
  });

  const mergedManifest = readJson(
    path.join(workspace, "outputs", "candidates", "merged", "manifest.json")
  );
  const mergedCsv = fs.readFileSync(path.join(workspace, "submission.csv"), "utf8");
  assert.equal(mergedManifest.candidate_id, "merged");
  assert.deepEqual(mergedManifest.merge_inputs, ["alpha", "beta"]);
  assert.match(mergedCsv, /1,0\.2000000000/);
  assert.match(mergedCsv, /2,0\.3000000000/);
});

test("file-upload submission is non-blocking and finalized by refresh-score", () => {
  const workspace = setupWorkspace();
  writeCandidateFixture(
    workspace,
    "alpha",
    [
      { id: "1", target: "0.10" },
      { id: "2", target: "0.20" },
    ],
    0.62
  );

  runScript(workspace, ["--submit-candidate", "alpha"], {
    COMPETITION_MODE: "file_upload",
  });

  let manifest = readJson(
    path.join(workspace, "outputs", "candidates", "alpha", "manifest.json")
  );
  let stubState = readStubState(workspace);
  assert.equal(manifest.score_state, "score_request_submitted");
  assert.equal(manifest.submission_id, "sub-1");
  assert.equal(stubState.submission_count, 1);

  writeStubState(workspace, {
    latest_submission_score: "0.55",
    latest_submission_status: "complete",
    score: 0.55,
    rank: 101,
  });

  runScript(workspace, ["--refresh-score", "alpha"], {
    COMPETITION_MODE: "file_upload",
  });

  const state = readJson(path.join(workspace, "outputs", "kaggle_state.json"));
  manifest = readJson(
    path.join(workspace, "outputs", "candidates", "alpha", "manifest.json")
  );

  assert.equal(state.last_candidate_id, "alpha");
  assert.equal(state.last_submission_id, "sub-1");
  assert.equal(manifest.score_state, "public_scored");
});

test("notebook-scored competitions require notebook completion and exact version scoring", () => {
  const workspace = setupWorkspace();

  runScript(workspace, ["--submit", "alpha"], {
    COMPETITION_MODE: "notebook_scored",
  });

  let manifest = readJson(
    path.join(workspace, "outputs", "candidates", "alpha", "manifest.json")
  );
  let stubState = readStubState(workspace);
  assert.equal(manifest.score_state, "notebook_run_submitted");
  assert.equal(manifest.kernel_version_id, "kv-1");
  assert.equal(stubState.kernels_push_count, 1);
  assert.equal(stubState.submission_count, 0);

  writeStubState(workspace, { kernel_status: "complete" });
  runScript(workspace, ["--refresh-score", "alpha"], {
    COMPETITION_MODE: "notebook_scored",
  });

  manifest = readJson(
    path.join(workspace, "outputs", "candidates", "alpha", "manifest.json")
  );
  stubState = readStubState(workspace);
  assert.equal(manifest.score_state, "score_request_submitted");
  assert.equal(stubState.submission_count, 1);
  assert.equal(
    stubState.notebook_score_requested_version_id,
    manifest.kernel_version_id
  );

  writeStubState(workspace, {
    latest_submission_score: "0.61",
    latest_submission_status: "complete",
    score: 0.61,
    rank: 88,
  });
  runScript(workspace, ["--refresh-score", "alpha"], {
    COMPETITION_MODE: "notebook_scored",
  });

  const state = readJson(path.join(workspace, "outputs", "kaggle_state.json"));
  manifest = readJson(
    path.join(workspace, "outputs", "candidates", "alpha", "manifest.json")
  );
  assert.equal(state.last_candidate_id, "alpha");
  assert.equal(state.last_submission_id, "sub-1");
  assert.equal(manifest.score_state, "public_scored");
});

test("hybrid competitions push notebook first and submit file on refresh", () => {
  const workspace = setupWorkspace();

  runScript(workspace, ["--submit", "alpha"], {
    COMPETITION_MODE: "hybrid",
  });

  let manifest = readJson(
    path.join(workspace, "outputs", "candidates", "alpha", "manifest.json")
  );
  let stubState = readStubState(workspace);
  assert.equal(manifest.score_state, "notebook_run_submitted");
  assert.equal(stubState.submission_count, 0);

  writeStubState(workspace, { kernel_status: "complete" });
  runScript(workspace, ["--refresh-score", "alpha"], {
    COMPETITION_MODE: "hybrid",
  });

  manifest = readJson(
    path.join(workspace, "outputs", "candidates", "alpha", "manifest.json")
  );
  stubState = readStubState(workspace);
  assert.equal(manifest.score_state, "score_request_submitted");
  assert.equal(manifest.submission_id, "sub-1");
  assert.equal(stubState.submission_count, 1);

  writeStubState(workspace, {
    latest_submission_score: "0.57",
    latest_submission_status: "complete",
    score: 0.57,
    rank: 95,
  });
  runScript(workspace, ["--refresh-score", "alpha"], {
    COMPETITION_MODE: "hybrid",
  });

  const state = readJson(path.join(workspace, "outputs", "kaggle_state.json"));
  manifest = readJson(
    path.join(workspace, "outputs", "candidates", "alpha", "manifest.json")
  );
  assert.equal(state.last_candidate_id, "alpha");
  assert.equal(state.last_submission_id, "sub-1");
  assert.equal(manifest.score_state, "public_scored");
});
