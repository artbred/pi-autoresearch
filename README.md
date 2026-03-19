<div align="center">
<img src="https://github.com/user-attachments/assets/4a5c06ab-c1bb-4d9c-9173-1fd330763a59" width="250">

# pi-autoresearch
### Autonomous experiment loop for pi
**[Install](#install)** · **[Usage](#usage)** · **[Kaggle Mode](#kaggle-mode)** · **[How It Works](#how-it-works)**

</div>

*Try an idea, measure it, keep what works, discard what doesn't, repeat.*

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch). This package provides a reusable autoresearch loop for pi: one generic extension plus domain-specific skills. It works for classic optimization problems like test speed or build time, and it now also ships with a Kaggle-first competition skill.

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

The extension provides the generic mechanics for this loop. The skill provides the domain knowledge for what to optimize and how to run it.

That split matters:

- The extension should stay reusable.
- The skill should encode domain-specific judgment.
- Session files should let a fresh agent resume without prior memory.

## Core Idea

This repo is built around three persistent artifacts:

- `autoresearch.jsonl`
  - append-only run history
  - metrics, status, commit, and description for every iteration
- `autoresearch.md`
  - living session memory
  - objective, constraints, what has been tried, dead ends, and next ideas
- `autoresearch.sh`
  - executable workload entrypoint
  - the thing that actually runs and emits metrics

That gives you an optimization loop that survives restarts, context resets, and long autonomous sessions.

## What's Included

| Part | Purpose |
|---|---|
| Extension | Tools, widget, dashboard, `/autoresearch` command |
| `autoresearch-create` | Generic optimization skill |
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
/autoresearch optimize unit test runtime, monitor correctness
/autoresearch model training, run 5 minutes of train.py and note the loss ratio as optimization target
/autoresearch chase first place in titanic, mine discussions, and iterate on notebook submissions
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

### Generic Autoresearch

Use the generic skill when you want to optimize a measurable workload:

```text
/skill:autoresearch-create
```

Typical examples:

- test runtime
- build time
- bundle size
- model loss
- Lighthouse score

### Kaggle Autoresearch

Use the Kaggle skill when the problem is not just "optimize code" but "win or climb a Kaggle competition":

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
- how the next score actually appears for this competition

That is why the Kaggle skill is more detailed than the generic skill.

## Kaggle Workflow

The generated Kaggle workbench usually includes:

| File | Purpose |
|---|---|
| `autoresearch.md` | competition memory, rules, leaderboard history, ideas |
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

### Local GPU Use

The generated Kaggle path detects the best local accelerator it can find and exports `LOCAL_ACCELERATOR`.

Current detection covers:

- CUDA
- ROCm
- MPS
- CPU fallback

That lets the agent keep running heavier local experiments while waiting for the next Kaggle submission window.

## Kaggle Prerequisites

Install the Kaggle CLI:

```bash
pip install kaggle
```

Preferred auth is environment-backed. The generated script loads `${KAGGLE_ENV_FILE:-.env}` automatically.

Supported credential patterns:

```bash
KAGGLE_USERNAME=your_username
KAGGLE_KEY=your_token
```

Also supported:

- `KAGGLE_API_TOKEN` as an alias for `KAGGLE_KEY`
- `KAGGLE_TOKEN_FILE=/path/to/access_token` together with `KAGGLE_USERNAME`
- legacy fallback `~/.kaggle/kaggle.json`

Example `.env`:

```bash
KAGGLE_USERNAME=your_username
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

## Example Domains

| Domain | Metric | Command |
|---|---|---|
| Test speed | seconds ↓ | `pnpm test` |
| Bundle size | KB ↓ | `pnpm build && du -sb dist` |
| LLM training | val_bpb ↓ | `uv run train.py` |
| Build speed | seconds ↓ | `pnpm build` |
| Lighthouse | perf score ↑ | `lighthouse http://localhost:3000 --output=json` |
| Kaggle competition | public rank ↓ | `./autoresearch.sh --submit` |

## How It Works

The extension is intentionally generic. The skills carry the domain logic.

```text
Extension:
  run_experiment
  log_experiment
  widget + dashboard
  autoresearch mode

Generic skill:
  command: pnpm test
  metric: seconds
  scope: code and config

Kaggle skill:
  command: ./autoresearch.sh --submit
  metric: public_rank
  scope: notebook, assets, submission flow, competition rules
```

This keeps one infrastructure layer and multiple domain playbooks.

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
