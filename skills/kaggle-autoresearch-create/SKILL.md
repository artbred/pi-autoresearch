---
name: kaggle-autoresearch-create
description: Set up and run a Kaggle competition autoresearch loop focused on climbing the leaderboard with notebook submissions, discussion mining, and rules-safe public data reuse.
---

# Kaggle Autoresearch

Autonomous Kaggle competition loop: research the competition, build stronger notebook variants, submit candidates, keep what improves public leaderboard position, and keep pushing toward first place.

## Tools

- **`init_experiment`** — initialize the session with `metric_name="public_rank"` and `direction="lower"`.
- **`run_experiment`** — run `./autoresearch.sh --local-only` for preflight work and quota-exhausted phases, or `./autoresearch.sh --submit` for a leaderboard-tracked iteration.
- **`log_experiment`** — record every run. Always include `public_score`, `cv_score`, and `submission_count` in the `metrics` dict.

## Mandatory Inputs

Ask or infer these before writing files:

1. **Competition** — Kaggle URL and slug.
2. **Notebook artifact path** — editable source path (`notebook.py` by default) and generated notebook path (`notebook.ipynb` by default).
3. **Local validation metric** — name plus whether higher or lower is better.
4. **Submission artifact** — expected file path, required columns, and how the local run produces it.
5. **Competition mode** — file-upload, notebook-only/code-submission, hybrid notebook-plus-file, or offline asset-backed workflow.
6. **Files in scope** — what may be edited.
7. **Resource flags** — GPU, internet, time limits, memory limits, daily submission cap.
8. **Hard constraints** — off-limits data, banned techniques, licensing limits, and competition-specific rules.

If the user does not specify them, infer conservative defaults and write those assumptions into `autoresearch.md`.

## Setup Workflow

1. Read the target repo and understand how training, feature generation, and submission files currently work.
2. Research the competition before writing code:
   - Competition overview, evaluation metric, rules, and allowed external data.
   - High-signal public discussions and notebooks.
   - Useful public datasets, models, and kernels that are allowed by the rules.
   - The exact score acquisition path: direct file upload, notebook-only submission, or notebook-run plus file upload.
3. Create a branch named `autoresearch/<competition-slug>-<date>`.
4. Materialize the Kaggle workbench from the templates in `templates/`:
   - `autoresearch.md.template` -> `autoresearch.md`
   - `autoresearch.sh.template` -> `autoresearch.sh`
   - `autoresearch.checks.sh.template` -> `autoresearch.checks.sh` when correctness/rules checks are required
   - `notebook.py.template` -> `notebook.py`
   - `build_notebook.py.template` -> `build_notebook.py`
   - `kernel-metadata.json.template` -> `kernel-metadata.json`
5. Replace template placeholders with the actual competition metadata, notebook paths, submission file path, validation metric, allowlists, guardrails, and competition mode.
6. Commit the generated session files once they are correct.
7. Call:
   - `init_experiment` with `name="<competition-slug> first-place chase"`, `metric_name="public_rank"`, `metric_unit=""`, and `direction="lower"`.
8. Run a baseline:
   - Start with `./autoresearch.sh --local-only` to confirm the notebook builds and the local pipeline writes the submission artifact and `cv_score`.
   - Once the submission path is valid, run the competition-mode-specific submission flow to establish the first public rank baseline.
9. Detect local acceleration early:
   - Check for CUDA, ROCm, or MPS on the current machine.
   - If a GPU is available, bias local training, ensembling, and notebook execution toward using it during long local iteration phases.

## Competition Mode Matrix

Before assuming anything about upload or score retrieval, classify the competition from the rules page, submission tab, and notebook UI.

### 1. File-upload competitions

- The competition expects a file such as `submission.csv` on the competition submission page.
- Run locally or via a notebook to produce the file.
- Submit with `kaggle competitions submit` or the competition upload UI.
- New score path:
  - upload file
  - wait for Kaggle evaluation
  - read the updated score from submissions / leaderboard

### 2. Notebook-only or code competitions

- The notebook version itself is the submission artifact.
- Do **not** assume `kaggle competitions submit` is the right path.
- Push the notebook, create a scored notebook version, and use the notebook submission flow defined by the competition.
- The score appears only after the notebook version finishes running and Kaggle evaluates that run.

### 3. Hybrid notebook-plus-file competitions

- The notebook must run first, but a file still needs to be submitted afterward.
- Push or run the notebook to generate `submission.csv`.
- Download or collect the produced file.
- Then submit that file to the competition page or with `kaggle competitions submit`.

### 4. Internet-off notebook competitions

- `enable_internet` must stay `false`.
- All non-built-in dependencies must be mounted from Kaggle datasets or models.
- Package wheel bundles as a Kaggle dataset and install from the mounted dataset path inside the notebook.
- Validate the full dependency install path locally with internet disabled before using a real submission slot.

### 5. Asset-backed competitions

- Large weights, tokenizers, embeddings, or wheel bundles must be uploaded separately.
- Use Kaggle datasets or Kaggle models, then reference them through `dataset_sources`, `model_sources`, or both.
- Keep the asset versions aligned with the notebook version that is supposed to score.

## Edge Cases To Handle Explicitly

- Some competitions score uploaded files, some score notebook versions, and some require both. Never guess.
- Some competitions disable internet. Dependency packaging, wheel uploads, and mounted install paths become part of the core submission workflow.
- Some competitions require custom wheels or private libraries. Upload them as datasets and install from the mounted path inside the notebook.
- Some competitions require a very strict `submission.csv` schema or row ordering. Validate this in `autoresearch.checks.sh`.
- Some competitions delay score publication until a notebook version finishes or a backend evaluation queue clears. Do not mistake delayed scoring for failure.
- Some competitions expose only a public leaderboard proxy and a later private leaderboard. Treat local CV robustness as essential.

## Kaggle Session Files

### `autoresearch.md`

This file must be Kaggle-specific and good enough for a fresh agent to resume the competition immediately.

It must contain:

- Competition summary: title, slug, URL, deadline, evaluation metric, leaderboard context, and competition mode.
- Rules and leakage bans: forbidden external data, sharing limits, and any special competition constraints.
- Submission budget: daily cap, reserve policy, and when to spend a submission.
- Dependency packaging plan: wheels datasets, model attachments, mounted assets, and install order.
- Local validation strategy: folds, time split or leakage controls, and tie-breaker logic.
- Score acquisition path: exactly how a new score appears for this competition.
- Discussion mining notes: top threads, notebook ideas, and public kernels worth testing.
- Allowed external datasets and how they may be used.
- Leaderboard history: public rank, public score, CV score, and notes per submission.
- Notebook variant log: what was tried, what failed, and why.
- Keep/discard policy:
  - Keep when `public_rank` improves.
  - If `public_rank` is unchanged, keep only when `public_score` improves.
  - Otherwise discard.

### `autoresearch.sh`

This is the Kaggle loop entrypoint. It must support:

- `./autoresearch.sh --local-only`
  - Build `notebook.ipynb` from `notebook.py`
  - Run the local validation / training path
  - Verify the submission artifact exists
  - Emit machine-readable metrics for:
    - `public_rank`
    - `public_score`
    - `cv_score`
    - `submission_count`
- `./autoresearch.sh --submit`
  - Treat the current template as the default hybrid/file-upload path unless the competition rules require notebook-only submission.
  - Run the local path first.
  - Verify Kaggle CLI auth and accepted rules.
  - If the daily submission cap is exhausted, do **not** stop:
    - queue the candidate for the next submission window
    - emit the last known public metrics plus the current `cv_score`
    - continue iterating locally
  - If the competition is hybrid/file-upload:
    - push the notebook
    - wait for notebook completion
    - collect `submission.csv`
    - submit the file to the competition
  - If the competition is notebook-only/code-submission:
    - replace the submit path so the notebook version itself becomes the scored submission
    - do not force `kaggle competitions submit`
  - Refresh the correct score surface for the chosen mode and emit the same metric set

Fail fast on:

- Missing Kaggle credentials or missing `kaggle` CLI
- Rules not accepted for the competition
- Missing submission artifact
- Kernel run failure
- Missing kernel output files

Do **not** fail-stop on the daily submission cap. When the cap is reached, switch into local iteration mode and keep building stronger candidates for the next opening.

Credential sources should be tried in this order:

1. `KAGGLE_USERNAME` + `KAGGLE_KEY` from the environment or a sourced `.env` file.
2. `KAGGLE_USERNAME` plus `KAGGLE_API_TOKEN` or `KAGGLE_TOKEN_FILE` / `access_token`.
3. `~/.kaggle/kaggle.json` as a fallback for legacy setups.

### `autoresearch.checks.sh`

Use when the user requires correctness or rules backpressure. The checks must validate:

- The notebook rebuilds successfully.
- The submission file schema matches the competition contract.
- `kernel-metadata.json` resource flags stay inside the allowed limits.
- Disallowed datasets, file paths, or banned patterns are not present.

## Loop Rules

**Never stop unless interrupted.**

- Treat public leaderboard position as the primary objective.
- Every `log_experiment` call must include:
  - `public_score`
  - `cv_score`
  - `submission_count`
- Keep/discard policy is strict:
  - Keep if `public_rank` improves.
  - If `public_rank` ties, use improved `public_score` as the tie-breaker.
  - Otherwise discard.
- `--local-only` runs are preflight checks, not proof of leaderboard improvement.
  - Carry forward the last known public metrics or a large placeholder rank until the first real submission.
  - Use local CV to decide whether a candidate is worth spending a Kaggle submission on.
- When the daily submission limit is exhausted:
  - Do not stop.
  - Continue with `--local-only` experiments, discussion mining, feature work, and ensembling.
  - Prefer GPU-backed local runs when CUDA, ROCm, or MPS is available on the machine.
  - Queue strong candidates for the next submission window.
  - It is acceptable to keep a candidate provisionally when `cv_score` or robustness improves materially during a submission blackout; record clearly in `autoresearch.md` that the leaderboard validation is still pending.
- When the competition is internet-off or notebook-only:
  - treat packaging, dependency installation, and submission mechanics as first-class optimization work
  - keep a written checklist for wheel datasets, mounted paths, notebook version IDs, and score retrieval steps
- Mine discussions, public notebooks, and public datasets aggressively, but stay inside the written rules.
- Never use leaked labels, private sharing rings, forbidden external data, or any technique that risks disqualification.
- Write promising but deferred ideas to `autoresearch.ideas.md`.
- Update `autoresearch.md` continuously so a fresh agent can continue the race without prior context.

## Resume Behavior

If `autoresearch.md` already exists:

1. Read it first.
2. Read the recent git history.
3. Check `autoresearch.ideas.md`.
4. Resume with the most promising legal next notebook variant.
