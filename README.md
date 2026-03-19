<div align="center">
<img src="https://github.com/user-attachments/assets/4a5c06ab-c1bb-4d9c-9173-1fd330763a59" width="250">

# pi-autoresearch
### Autonomous experiment loop for pi
**[Install](#install)** · **[Usage](#usage)** · **[Kaggle Mode](#kaggle-mode)** · **[How It Works](#how-it-works)**

</div>

*Run Kaggle experiments, score real submissions, keep what improves, repeat.*

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch). This package provides a Kaggle-first autoresearch loop for pi: a reusable extension plus a single Kaggle competition skill.

---

![pi-autoresearch dashboard](pi-autoresearch.png)

---

## What This Is

`pi-autoresearch` is a way to make the agent work like a persistent experiment runner instead of a one-shot assistant.

The core loop is simple:

1. Change something.
2. Run the workload.
3. Measure the result.
4. Keep the change if it improved the target.
5. Revert it if it did not.
6. Repeat until interrupted.

The extension provides the mechanics for this loop. The Kaggle skill provides the competition-specific judgment for what to optimize and how to run it.

That split matters:

- The extension should stay reusable.
- The skill should encode domain-specific judgment.
- Session files should let a fresh agent resume without prior memory.

## Core Idea

This repo is built around three persistent artifacts:

- `autoresearch.jsonl`
  - append-only run history
  - metrics, status, commit, and description for every iteration
- `autoresearch.orchestrator.json`
  - shared live state for lanes, candidates, pending submissions, and score freshness
- `autoresearch.md`
  - living session memory
  - objective, constraints, what has been tried, dead ends, and next ideas
- `autoresearch.sh`
  - executable workload entrypoint
  - the thing that actually runs and emits metrics

That gives you an optimization loop that survives restarts, context resets, and long autonomous sessions.

Parallel orchestration is now lane-based:

- `exploit` iterates on the best scored line
- `explore` pursues a materially different hypothesis
- `merge` builds artifact-level combinations from ready candidates
- If `pi` is not available on `PATH`, the extension degrades honestly to coordinator-only mode instead of pretending background workers exist

## What's Included

| Part | Purpose |
|---|---|
| Extension | Tools, widget, dashboard, `/autoresearch` command |
| `kaggle-autoresearch` | Kaggle competition skill |

### Extension Tools

| Tool | Description |
|---|---|
| `init_experiment` | Initialize session metadata: name, primary metric, unit, direction |
| `run_experiment` | Run the workload, time it, capture output, detect failure |
| `log_experiment` | Record result, update dashboard, commit or revert automatically |

### `/autoresearch` Command

| Command | Description |
|---|---|
| `/autoresearch <text>` | Start or resume autoresearch mode |
| `/autoresearch off` | Leave autoresearch mode |
| `/autoresearch clear` | Reset runtime state and delete `autoresearch.jsonl` |

Examples:

```text
/autoresearch chase first place in titanic, mine discussions, and iterate on notebook submissions
/autoresearch run kaggle autoresearch for house-prices and keep submitting the best legal candidates
/autoresearch set up a notebook-first kaggle loop for the current competition and keep climbing the leaderboard
```

### UI

- Status widget above the editor
- Expanded dashboard with recent runs
- Fullscreen dashboard overlay

Keyboard shortcuts:

- `Ctrl+X` toggles compact vs expanded dashboard
- `Ctrl+Shift+X` opens the fullscreen dashboard

## Install

```bash
pi install https://github.com/artbred/pi-autoresearch
```

Manual install:

```bash
cp -r extensions/pi-autoresearch ~/.pi/agent/extensions/
cp -r skills/* ~/.pi/agent/skills/
```

Then run `/reload` in pi.

## Usage

### Kaggle Autoresearch

This package ships only the Kaggle skill:

```text
/skill:kaggle-autoresearch
```

The Kaggle skill asks or infers:

- competition slug / URL
- notebook source path
- notebook artifact path
- submission artifact path
- local validation metric
- resource limits
- notebook runtime budget and safety margin
- competition mode
- rules and hard constraints

Then it creates the working session files and starts iterating.

## Kaggle Mode

The Kaggle skill exists because Kaggle is not a single workflow. Different competitions produce new scores in different ways.

The skill now tells the agent to classify the competition before deciding how to submit:

### 1. File-upload competitions

- The scored artifact is a file such as `submission.csv`.
- The notebook or local run produces the file.
- The file is uploaded to the competition page or submitted with `kaggle competitions submit`.
- The score appears after Kaggle evaluates that file.

### 2. Notebook-only or code competitions

- The notebook version itself is the submission.
- The agent must not blindly assume `kaggle competitions submit` is correct.
- The score appears only after Kaggle runs and evaluates that notebook version.

### 3. Hybrid notebook-plus-file competitions

- The notebook must run first.
- That notebook produces `submission.csv`.
- Then the produced file must still be submitted to the competition to get a score.

### 4. Internet-off notebook competitions

- The notebook cannot fetch dependencies from the internet.
- Wheels or other custom dependencies must be uploaded as a Kaggle dataset or attached assets.
- The notebook must install from mounted dataset paths with internet disabled.

### 5. Asset-backed competitions

- The run depends on large weights, tokenizers, embeddings, custom packages, or model artifacts.
- Those assets must be versioned and attached through Kaggle datasets or Kaggle models.

### Why This Matters

The skill is supposed to understand:

- what the real submission artifact is
- whether a notebook version itself is the scored submission
- whether a file upload is still required after the notebook finishes
- whether internet is disabled
- whether custom wheels must be packaged as datasets
- what notebook wall-clock limit the scored run must fit inside
- how the next score actually appears for this competition

That is why the Kaggle skill is detailed and competition-specific.

## Kaggle Workflow

The generated Kaggle workbench usually includes:

| File | Purpose |
|---|---|
| `autoresearch.md` | competition memory, rules, leaderboard history, ideas |
| `autoresearch.orchestrator.json` | shared lane state, candidate registry, freshness gates |
| `autoresearch.sh` | local run + submit workflow |
| `autoresearch.checks.sh` | schema, rules, packaging, and guardrail checks |
| `notebook.py` | editable source-of-truth notebook script |
| `notebook.ipynb` | generated Kaggle notebook artifact |
| `build_notebook.py` | renders `notebook.py` to `.ipynb` |
| `kernel-metadata.json` | Kaggle kernel packaging and resource flags |

### Kaggle Metrics

Primary metric:

- `public_rank`

Tracked secondary metrics:

- `public_score`
- `cv_score`
- `submission_count`

### Kaggle Keep / Discard Logic

- Keep when `public_rank` improves.
- If `public_rank` is unchanged, use improved `public_score` as the tie-breaker.
- During submission blackout, the loop may keep a candidate provisionally based on stronger local validation or robustness, but it must mark that leaderboard validation is still pending.

### Submission Limits

The Kaggle loop does not stop when the daily submission cap is exhausted.

Instead it:

- keeps iterating locally
- records the best pending candidates
- carries forward the last known public metrics
- uses local CV to triage ideas
- resumes leaderboard validation when submissions reopen

But local-only work is not supposed to be the default steady state while submissions are still available:

- get a real public baseline as soon as the submission path works
- periodically submit the best compliant candidate for a real score
- iterate on top of refreshed leaderboard feedback, not just on CV-only changes

The generated notebook and scripts also treat notebook runtime as a hard gate:

- the notebook records wall-clock runtime
- local preflight rejects candidates that exceed the runtime budget
- the agent is expected to keep a safety margin instead of aiming at the hard cap

### Candidate Commands

- `./autoresearch.sh --local-only <candidate-id>` builds a candidate locally and refreshes `outputs/candidates/<candidate-id>/manifest.json`
- `./autoresearch.sh --submit-candidate <candidate-id>` submits a previously built candidate deterministically
- `./autoresearch.sh --merge-candidates <candidate-a,candidate-b,...>` creates an artifact-level merge candidate before any code-level promotion

### Config

`autoresearch.config.json` can now separate mutable state from the repo worktree and tune freshness policies:

```json
{
  "workingDir": ".",
  "stateDir": ".",
  "parallelism": {
    "enabled": true,
    "maxWorkers": 2,
    "workerBackend": "auto",
    "worktreeRoot": ".autoresearch/worktrees"
  },
  "policy": {
    "maxLocalKeepsWithoutScore": 3,
    "maxMinutesWithoutFreshScore": 90,
    "maxNonImprovingRunsPerLane": 2
  }
}
```

### Local GPU Use

The generated Kaggle path detects the best local accelerator it can find and exports `LOCAL_ACCELERATOR`.

Current detection covers:

- CUDA
- ROCm
- MPS
- CPU fallback

That lets the agent keep running heavier local experiments while waiting for the next Kaggle submission window.

## Kaggle Prerequisites

Install the Kaggle CLI on the host so `kaggle` is available on `PATH` for the generated shell scripts:

```bash
python3 -m pip install --user kaggle
```

Use the CLI directly for auth, pushes, status checks, output download, and submissions. Do not replace the submission flow with project-local Python packages or wrappers.

Preferred auth is environment-backed. The generated script loads `${KAGGLE_ENV_FILE:-.env}` automatically.

Supported credential patterns:

```bash
KAGGLE_API_TOKEN=your_token
```

Also supported:

- `KAGGLE_TOKEN_FILE=/path/to/access_token`
- `~/.kaggle/access_token`
- legacy fallback `~/.kaggle/kaggle.json`

Example `.env`:

```bash
KAGGLE_API_TOKEN=your_token
LEADERBOARD_TEAM_NAME=your_team_name
```

Legacy file flow:

```bash
mkdir -p ~/.kaggle
chmod 600 ~/.kaggle/kaggle.json
```

Before the first real submission:

- authenticate the CLI
- accept the competition rules
- confirm the competition mode
- confirm how a new score is supposed to appear
- set `LEADERBOARD_TEAM_NAME` only if automatic leaderboard matching needs an explicit team/display name

## Example Domain

| Domain | Metric | Command |
|---|---|---|
| Kaggle competition | public rank ↓ | `./autoresearch.sh --submit` |

## How It Works

The extension handles the loop mechanics. The Kaggle skill carries the domain logic.

```text
Extension:
  run_experiment
  log_experiment
  widget + dashboard
  autoresearch mode

Kaggle skill:
  command: ./autoresearch.sh --submit
  metric: public_rank
  scope: notebook, assets, submission flow, competition rules
```

This keeps one infrastructure layer with one Kaggle-specific playbook.

## Session Persistence

Two files are the backbone of resume behavior:

```text
autoresearch.jsonl   append-only run history
autoresearch.md      objective, constraints, ideas, and experiment memory
```

A fresh agent can read these and continue.

## Configuration

Optional `autoresearch.config.json`:

```json
{
  "workingDir": "/path/to/project",
  "maxIterations": 50
}
```

| Field | Type | Description |
|---|---|---|
| `workingDir` | string | Override the directory used for autoresearch files, command execution, and git operations |
| `maxIterations` | number | Maximum experiments before auto-stop |

## Backpressure Checks

If `autoresearch.checks.sh` exists, it runs after every passing experiment command.

Typical use:

- tests
- type checks
- lint
- submission schema validation
- Kaggle packaging validation
- offline dependency checks

If checks fail:

- the run is logged as `checks_failed`
- the change is not kept
- autoresearch files are preserved

## License

MIT
