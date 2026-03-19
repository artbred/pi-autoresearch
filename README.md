<div align="center">
<img src="https://github.com/user-attachments/assets/4a5c06ab-c1bb-4d9c-9173-1fd330763a59" width="250">
  
# pi-autoresearch
### Autonomous experiment loop for pi
**[Install](#install)** · **[Usage](#usage)** · **[How it works](#how-it-works)**

</div>

*Try an idea, measure it, keep what works, discard what doesn't, repeat forever.*

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch). Works for generic optimization targets and now ships with a Kaggle competition mode focused on chasing leaderboard gains with notebook submissions.

---

![pi-autoresearch dashboard](pi-autoresearch.png)

---

## Quick start

```bash
pi install https://github.com/davebcn87/pi-autoresearch
```

## What's included

| | |
|---|---|
| **Extension** | Tools + live widget + `/autoresearch` dashboard |
| **Skills** | Generic setup skill plus a Kaggle-first competition skill |

### Extension tools

| Tool | Description |
|------|-------------|
| `init_experiment` | One-time session config — name, metric, unit, direction |
| `run_experiment` | Runs any command, times wall-clock duration, captures output |
| `log_experiment` | Records result, auto-commits, updates widget and dashboard |

### `/autoresearch` command

| Subcommand | Description |
|------------|-------------|
| `/autoresearch <text>` | Enter autoresearch mode. If `autoresearch.md` exists, resumes the loop with `<text>` as context. Otherwise, sets up a new session. |
| `/autoresearch off` | Leave autoresearch mode. Stops auto-resume and clears runtime state but keeps `autoresearch.jsonl` intact. |
| `/autoresearch clear` | Delete `autoresearch.jsonl`, reset all state, and turn autoresearch mode off. Use this for a clean start. |

**Examples:**

```
/autoresearch optimize unit test runtime, monitor correctness
/autoresearch model training, run 5 minutes of train.py and note the loss ratio as optimization target
/autoresearch chase first place in titanic, mine discussions, and iterate on notebook submissions
/autoresearch off
/autoresearch clear
```

### Keyboard shortcuts

| Shortcut | Description |
|----------|-------------|
| `Ctrl+X` | Toggle dashboard expand/collapse (inline widget ↔ full results table above the editor) |
| `Ctrl+Shift+X` | Open fullscreen scrollable dashboard overlay. Navigate with `↑`/`↓`/`j`/`k`, `PageUp`/`PageDown`/`u`/`d`, `g`/`G` for top/bottom, `Escape` or `q` to close. |

### UI

- **Status widget** — always visible above the editor: `🔬 autoresearch 12 runs 8 kept │ best: 42.3s`
- **Expanded dashboard** — `Ctrl+X` expands the widget into a full results table with columns for commit, metric, status, and description.
- **Fullscreen overlay** — `Ctrl+Shift+X` opens a scrollable full-terminal dashboard. Shows a live spinner with elapsed time for running experiments.
### Skill

`autoresearch-create` handles generic optimization targets. `kaggle-autoresearch-create` is the new Kaggle-first skill for competition workflows. It asks or infers the competition slug, notebook paths, validation metric, submission artifact, file scope, and constraints — then writes the session files and starts the loop.

| File | Purpose |
|------|---------|
| `autoresearch.md` | Session document — objective, metrics, files in scope, what's been tried. A fresh agent can resume from this alone. |
| `autoresearch.sh` | Experiment script — pre-checks, runs the workload, outputs `METRIC name=number` lines. |
| `autoresearch.checks.sh` | *(optional)* Backpressure checks — tests, types, lint. Runs after each passing experiment command. Failures block `keep`. |
| `notebook.py` | *(Kaggle skill)* Editable source-of-truth notebook script. |
| `notebook.ipynb` | *(Kaggle skill)* Generated Kaggle upload artifact. |
| `build_notebook.py` | *(Kaggle skill)* Renders `notebook.py` to `notebook.ipynb`. |
| `kernel-metadata.json` | *(Kaggle skill)* Kaggle kernel packaging + resource flags. |

---

## Install

```bash
pi install https://github.com/davebcn87/pi-autoresearch
```

<details>
<summary>Manual install</summary>

```bash
cp -r extensions/pi-autoresearch ~/.pi/agent/extensions/
cp -r skills/* ~/.pi/agent/skills/
```

Then `/reload` in pi.

</details>

---

## Usage

### 1. Start autoresearch

```
/skill:autoresearch-create
/skill:kaggle-autoresearch-create
```

Use `/skill:autoresearch-create` for generic optimization work. Use `/skill:kaggle-autoresearch-create` for Kaggle competitions. The Kaggle skill asks about the competition, notebook paths, validation metric, submission artifact, file scope, and constraints, then creates a branch, writes the session files, runs a local baseline, and moves into leaderboard-focused iteration.

### 2. The loop

The agent runs autonomously: edit → commit → `run_experiment` → `log_experiment` → keep or revert → repeat. It never stops unless interrupted.

Every result is appended to `autoresearch.jsonl` in your project — one line per run. This means:

- **Survives restarts** — the agent can resume a session by reading the file
- **Survives context resets** — `autoresearch.md` captures what's been tried so a fresh agent has full context
- **Human readable** — open it anytime to see the full history
- **Branch-aware** — each branch has its own session

### 3. Monitor progress

- **Widget** — always visible above the editor
- **`/autoresearch`** — full dashboard with results table and best run
- **`Escape`** — interrupt anytime and ask for a summary

---

## Example domains

| Domain | Metric | Command |
|--------|--------|---------|
| Test speed | seconds ↓ | `pnpm test` |
| Bundle size | KB ↓ | `pnpm build && du -sb dist` |
| LLM training | val_bpb ↓ | `uv run train.py` |
| Build speed | seconds ↓ | `pnpm build` |
| Lighthouse | perf score ↑ | `lighthouse http://localhost:3000 --output=json` |
| Kaggle competition | public rank ↓ | `./autoresearch.sh --submit` |

## Kaggle First-Place Mode

`kaggle-autoresearch-create` keeps the extension generic while giving the agent a Kaggle-specific playbook:

- Research the competition page, rules, discussions, public notebooks, and allowed external datasets.
- Classify the competition first: file-upload, notebook-only/code-submission, hybrid notebook-plus-file, or offline asset-backed workflow.
- Maintain `autoresearch.md` as the competition memory file: rules, leakage bans, leaderboard history, discussion ideas, and notebook variants.
- Edit `notebook.py`, render it into `notebook.ipynb`, and submit through the Kaggle CLI.
- Optimize for `public_rank` with `lower` as better while tracking `public_score`, `cv_score`, and `submission_count`.

The generated `autoresearch.sh` supports two modes:

- `./autoresearch.sh --local-only` builds the notebook, runs the local validation path, checks that the submission artifact exists, and emits parseable metrics without spending a Kaggle submission.
- `./autoresearch.sh --submit` runs the local path, pushes the notebook with the Kaggle CLI, downloads kernel outputs, submits to the competition, refreshes leaderboard state, and emits the same metric set.
- If the daily Kaggle submission cap is already exhausted, `./autoresearch.sh --submit` does not stop the loop. It records the candidate in a pending queue, carries forward the last known public metrics, and keeps the loop in local iteration mode until submissions reopen.

The generated local path also detects the best local accelerator it can find and exports `LOCAL_ACCELERATOR` for the notebook or training command. Out of the box it checks for CUDA, ROCm, and MPS, so the agent can keep using GPU-backed local experiments while the submission window is closed.

Important edge case: not every competition uses the same score path. The Kaggle skill now expects the agent to distinguish between:

- file-upload competitions, where `submission.csv` goes straight to the competition page or `kaggle competitions submit`
- notebook-only or code competitions, where the notebook version itself is the scored submission
- hybrid competitions, where the notebook must run first and the resulting `submission.csv` must then be uploaded
- internet-off notebook competitions, where wheels or other custom dependencies must be uploaded as datasets and installed from mounted paths because `enable_internet` is `false`

### Kaggle prerequisites

Install and authenticate the Kaggle CLI before running the submit path:

```bash
pip install kaggle
```

Preferred auth is environment-backed. The generated `autoresearch.sh` loads `${KAGGLE_ENV_FILE:-.env}` automatically and supports these inputs:

```bash
KAGGLE_USERNAME=your_username
KAGGLE_KEY=your_token
```

It also accepts:

- `KAGGLE_API_TOKEN` as an alias for `KAGGLE_KEY`
- `KAGGLE_TOKEN_FILE=/path/to/access_token` together with `KAGGLE_USERNAME`
- fallback legacy `~/.kaggle/kaggle.json`

Example `.env`:

```bash
KAGGLE_USERNAME=your_username
KAGGLE_API_TOKEN=your_token
LEADERBOARD_TEAM_NAME=your_team_name
```

If you still use the legacy file flow:

```bash
mkdir -p ~/.kaggle
# Put kaggle.json in ~/.kaggle/kaggle.json and chmod 600 it
chmod 600 ~/.kaggle/kaggle.json
```

Also accept the competition rules on Kaggle before the first download or submission. The generated scripts fail fast if auth is missing, the rules were not accepted, the submission quota is exhausted, or the kernel outputs do not contain the expected submission file.

---

## How it works

The **extension** is domain-agnostic infrastructure. The **skills** encode domain knowledge. This separation means one extension serves unlimited domains, including Kaggle competition loops.

```
┌──────────────────────┐     ┌──────────────────────────┐
│  Extension (global)  │     │  Skill (per-domain)       │
│                      │     │                           │
│  run_experiment      │◄────│  command: pnpm test       │
│  log_experiment      │     │  metric: seconds (lower)  │
│  widget + dashboard  │     │  scope: vitest configs    │
│                      │     │  ideas: pool, parallel…   │
├──────────────────────┤     ├──────────────────────────┤
│  run_experiment      │◄────│  command: ./autoresearch.sh --submit │
│  log_experiment      │     │  metric: public_rank (lower)         │
│  widget + dashboard  │     │  scope: notebook.py, metadata        │
│                      │     │  ideas: folds, blending, datasets…   │
└──────────────────────┘     └──────────────────────────┘
```

Two files keep the session alive across restarts and context resets:

```
autoresearch.jsonl   — append-only log of every run (metric, status, commit, description)
autoresearch.md      — living document: objective, what's been tried, dead ends, key wins
```

A fresh agent with no memory can read these two files and continue exactly where the previous session left off.

---

## Configuration (optional)

Create `autoresearch.config.json` in your pi session directory to customize behavior:

```json
{
  "workingDir": "/path/to/project",
  "maxIterations": 50
}
```

| Field | Type | Description |
|-------|------|-------------|
| `workingDir` | string | Override the directory for all autoresearch operations — file I/O, command execution, and git. Supports absolute or relative paths (resolved against the pi session cwd). The config file itself always stays in the session cwd. Fails if the directory doesn't exist. |
| `maxIterations` | number | Maximum experiments before auto-stopping. The agent is told to stop and won't run more experiments until a new segment is initialized. |

---

## Backpressure checks (optional)

Create `autoresearch.checks.sh` to run correctness checks (tests, types, lint) after every passing experiment command. This ensures optimizations don't break things.

```bash
#!/bin/bash
set -euo pipefail
pnpm test --run
pnpm typecheck
```

**How it works:**

- If the file doesn't exist, everything behaves exactly as before — no changes to the loop.
- If it exists, it runs automatically after every experiment command that exits 0.
- Checks execution time does **not** affect the primary metric.
- If checks fail, the experiment is logged as `checks_failed` (same behavior as a crash — no commit, revert changes).
- The `checks_failed` status is shown separately in the dashboard so you can distinguish correctness failures from experiment crashes.
- Checks have a separate timeout (default 300s, configurable via `checks_timeout_seconds` in `run_experiment`).

---

## License

MIT
