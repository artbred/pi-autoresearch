/**
 * autoresearch — Pi Extension
 *
 * Generic autonomous experiment loop infrastructure.
 * Domain-specific behavior comes from skills (what command to run, what to optimize).
 *
 * Provides:
 * - `run_experiment` tool — runs any command, times it, captures output, detects pass/fail
 * - `log_experiment` tool — records results with session-persisted state
 * - Status widget showing experiment count + best metric
 * - Ctrl+X toggle to expand/collapse full dashboard inline above the editor
 * - Adds autoresearch guidance to the system prompt and points the agent at autoresearch.md
 * - Injects autoresearch.md into context on every turn via before_agent_start
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { truncateTail } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text, truncateToWidth, matchesKey } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  applyExperimentToOrchestrator,
  buildBranchPrefix,
  clearLaneRunning,
  cloneExperimentState,
  createExperimentState,
  createOrchestratorState,
  currentResults,
  findBaselineMetric,
  findBaselineRunNumber,
  findBaselineSecondary,
  getRunBlockReason,
  looksLikeSubmissionCommand,
  markLaneRunning,
  metricUnitFromName,
  resolveAutoresearchConfig,
  resolveWorkerBackend,
  restoreExperimentStateFromJsonl,
  type ActionType,
  type AutoresearchConfig,
  type ExperimentResult,
  type ExperimentState,
  type MetricDef,
  type OrchestratorState,
  type ResolvedAutoresearchConfig,
  type ScoreState,
} from "./orchestration";
import { ensureLaneWorktree } from "./worktrees";

interface RunDetails {
  command: string;
  exitCode: number | null;
  durationSeconds: number;
  passed: boolean;
  crashed: boolean;
  timedOut: boolean;
  tailOutput: string;
  /** null = checks not run (no file or benchmark failed), true/false = ran */
  checksPass: boolean | null;
  checksTimedOut: boolean;
  checksOutput: string;
  checksDuration: number;
  laneId?: string;
  strategyId?: string;
  candidateId?: string;
  resolvedWorkDir?: string;
}

interface LogDetails {
  experiment: ExperimentResult;
  state: ExperimentState;
  orchestrator?: OrchestratorState;
}

interface AutoresearchRuntime {
  autoresearchMode: boolean;
  dashboardExpanded: boolean;
  lastAutoResumeTime: number;
  experimentsThisSession: number;
  autoResumeTurns: number;
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
  runningExperiment: {
    startedAt: number;
    command: string;
    laneId?: string;
    strategyId?: string;
    candidateId?: string;
    workDir?: string;
  } | null;
  state: ExperimentState;
  orchestrator: OrchestratorState | null;
  settings: ResolvedAutoresearchConfig | null;
}

// ---------------------------------------------------------------------------
// Tool Schemas
// ---------------------------------------------------------------------------

const RunParams = Type.Object({
  command: Type.String({
    description:
      "Shell command to run (e.g. 'pnpm test:vitest', 'uv run train.py')",
  }),
  lane_id: Type.Optional(
    Type.String({
      description:
        "Logical lane ID for this run. Use exploit, explore, or merge when parallel orchestration is active.",
    })
  ),
  strategy_id: Type.Optional(
    Type.String({
      description:
        "Stable strategy identifier for this lane. Change it when rotating to a materially different hypothesis.",
    })
  ),
  candidate_id: Type.Optional(
    Type.String({
      description:
        "Candidate identifier for the artifact or branch line this run is evaluating.",
    })
  ),
  timeout_seconds: Type.Optional(
    Type.Number({
      description: "Kill after this many seconds (default: 600)",
    })
  ),
  checks_timeout_seconds: Type.Optional(
    Type.Number({
      description:
        "Kill autoresearch.checks.sh after this many seconds (default: 300). Only relevant when the checks file exists.",
    })
  ),
});

const InitParams = Type.Object({
  name: Type.String({
    description:
      'Human-readable name for this experiment session (e.g. "Optimizing liquid for fastest execution and parsing")',
  }),
  metric_name: Type.String({
    description:
      'Display name for the primary metric (e.g. "total_µs", "bundle_kb", "val_bpb"). Shown in dashboard headers.',
  }),
  metric_unit: Type.Optional(
    Type.String({
      description:
        'Unit for the primary metric. Use "µs", "ms", "s", "kb", "mb", or "" for unitless. Affects number formatting. Default: ""',
    })
  ),
  direction: Type.Optional(
    Type.String({
      description:
        'Whether "lower" or "higher" is better for the primary metric. Default: "lower".',
    })
  ),
});

const LogParams = Type.Object({
  commit: Type.String({ description: "Git commit hash (short, 7 chars)" }),
  metric: Type.Number({
    description:
      "The primary optimization metric value (e.g. seconds, val_bpb). 0 for crashes.",
  }),
  status: StringEnum(["keep", "discard", "crash", "checks_failed"] as const),
  description: Type.String({
    description: "Short description of what this experiment tried",
  }),
  lane_id: Type.Optional(
    Type.String({
      description:
        "Logical lane that owned this experiment. Use exploit, explore, or merge when parallel orchestration is active.",
    })
  ),
  strategy_id: Type.Optional(
    Type.String({
      description:
        "Stable strategy identifier for this lane. Change it when rotating to a new hypothesis.",
    })
  ),
  candidate_id: Type.Optional(
    Type.String({
      description:
        "Candidate identifier for the artifact or branch line this experiment produced or evaluated.",
    })
  ),
  action_type: Type.Optional(
    StringEnum([
      "experiment",
      "baseline",
      "local_only",
      "submit",
      "merge",
      "promote",
      "refresh",
    ] as const)
  ),
  score_state: Type.Optional(
    StringEnum([
      "unknown",
      "local_only",
      "pending_submission",
      "public_scored",
      "provisional",
      "quota_exhausted",
    ] as const)
  ),
  provisional: Type.Optional(
    Type.Boolean({
      description:
        "Whether this keep is provisional pending a real public score refresh.",
    })
  ),
  public_metrics_timestamp: Type.Optional(
    Type.Number({
      description:
        "Unix epoch milliseconds for the public metrics this result is anchored to, if known.",
    })
  ),
  metrics: Type.Optional(
    Type.Record(Type.String(), Type.Number(), {
      description:
        'Additional metrics to track as { name: value } pairs, e.g. { "compile_µs": 4200, "render_µs": 9800 }. These are shown alongside the primary metric for tradeoff monitoring.',
    })
  ),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Set to true to allow adding a new secondary metric that wasn't tracked before. Only use for metrics that have proven very valuable to watch.",
    })
  ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a number with comma-separated thousands: 15586 → "15,586" */
function commas(n: number): string {
  const s = String(Math.round(n));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return parts.join(",");
}

/** Format number with commas, preserving one decimal for fractional values */
function fmtNum(n: number, decimals: number = 0): string {
  if (decimals > 0) {
    const int = Math.floor(Math.abs(n));
    const frac = (Math.abs(n) - int).toFixed(decimals).slice(1); // ".3"
    return (n < 0 ? "-" : "") + commas(int) + frac;
  }
  return commas(n);
}

function formatNum(value: number | null, unit: string): string {
  if (value === null) return "—";
  const u = unit || "";
  // Integers: no decimals
  if (value === Math.round(value)) return fmtNum(value) + u;
  // Fractional: 2 decimal places
  return fmtNum(value, 2) + u;
}

function isBetter(
  current: number,
  best: number,
  direction: "lower" | "higher"
): boolean {
  return direction === "lower" ? current < best : current > best;
}

interface SessionPaths {
  settings: ResolvedAutoresearchConfig;
  workDir: string;
  stateDir: string;
  jsonlPath: string;
  orchestratorPath: string;
  mdPath: string;
  ideasPath: string;
  checksPath: string;
  candidatesDir: string;
  worktreeRoot: string;
  lanesDir: string;
}

/** Read autoresearch.config.json from the given directory (always ctx.cwd) */
function readConfig(cwd: string): AutoresearchConfig {
  try {
    const configPath = path.join(cwd, "autoresearch.config.json");
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as AutoresearchConfig;
  } catch {
    return {};
  }
}

function hasExecutableInPath(executable: string): boolean {
  const pathValue = process.env.PATH;
  if (!pathValue) return false;
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${executable}${suffix}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        // Keep searching.
      }
    }
  }
  return false;
}

function pickSharedFile(stateDir: string, workDir: string, filename: string): string {
  const statePath = path.join(stateDir, filename);
  if (fs.existsSync(statePath)) return statePath;
  return path.join(workDir, filename);
}

function getSessionPaths(ctxCwd: string): SessionPaths {
  const settings = resolveAutoresearchConfig(ctxCwd, readConfig(ctxCwd));
  return {
    settings,
    workDir: settings.workingDir,
    stateDir: settings.stateDir,
    jsonlPath: path.join(settings.stateDir, "autoresearch.jsonl"),
    orchestratorPath: path.join(settings.stateDir, "autoresearch.orchestrator.json"),
    mdPath: pickSharedFile(settings.stateDir, settings.workingDir, "autoresearch.md"),
    ideasPath: pickSharedFile(settings.stateDir, settings.workingDir, "autoresearch.ideas.md"),
    checksPath: path.join(settings.workingDir, "autoresearch.checks.sh"),
    candidatesDir: path.join(settings.stateDir, "outputs", "candidates"),
    worktreeRoot: settings.parallelism.worktreeRoot,
    lanesDir: path.join(settings.stateDir, "lanes"),
  };
}

function validateWorkDir(ctxCwd: string): string | null {
  const { workDir } = getSessionPaths(ctxCwd);
  try {
    const stat = fs.statSync(workDir);
    if (!stat.isDirectory()) {
      return `workingDir "${workDir}" (from autoresearch.config.json) is not a directory.`;
    }
  } catch {
    return `workingDir "${workDir}" (from autoresearch.config.json) does not exist.`;
  }
  return null;
}

function ensureStateDirs(paths: SessionPaths): void {
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.worktreeRoot, { recursive: true });
  fs.mkdirSync(paths.candidatesDir, { recursive: true });
  fs.mkdirSync(paths.lanesDir, { recursive: true });
}

function readOrchestrator(paths: SessionPaths, state: ExperimentState): OrchestratorState {
  ensureStateDirs(paths);
  const backend = resolveWorkerBackend(
    paths.settings.parallelism.workerBackend,
    hasExecutableInPath("pi")
  );
  const branchPrefix = buildBranchPrefix(state.name, paths.workDir);
  let existing: Partial<OrchestratorState> | null = null;
  if (fs.existsSync(paths.orchestratorPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(paths.orchestratorPath, "utf-8")) as OrchestratorState;
    } catch {
      existing = null;
    }
  }
  const orchestrator = createOrchestratorState({
    workDir: paths.workDir,
    stateDir: paths.stateDir,
    worktreeRoot: paths.worktreeRoot,
    branchPrefix,
    settings: paths.settings,
    backend,
    existing,
  });
  for (const lane of Object.values(orchestrator.lanes)) {
    fs.mkdirSync(path.dirname(lane.notesPath), { recursive: true });
    if (!fs.existsSync(lane.notesPath)) {
      fs.writeFileSync(
        lane.notesPath,
        `# ${lane.id} lane notes\n\nTrack lane-local observations here.\n`
      );
    }
  }
  fs.writeFileSync(paths.orchestratorPath, JSON.stringify(orchestrator, null, 2) + "\n");
  return orchestrator;
}

function writeOrchestrator(paths: SessionPaths, orchestrator: OrchestratorState): void {
  ensureStateDirs(paths);
  fs.writeFileSync(paths.orchestratorPath, JSON.stringify(orchestrator, null, 2) + "\n");
}

function createSessionRuntime(): AutoresearchRuntime {
  return {
    autoresearchMode: false,
    dashboardExpanded: false,
    lastAutoResumeTime: 0,
    experimentsThisSession: 0,
    autoResumeTurns: 0,
    lastRunChecks: null,
    runningExperiment: null,
    state: createExperimentState(),
    orchestrator: null,
    settings: null,
  };
}

function createRuntimeStore() {
  const runtimes = new Map<string, AutoresearchRuntime>();

  return {
    ensure(sessionKey: string): AutoresearchRuntime {
      let runtime = runtimes.get(sessionKey);
      if (!runtime) {
        runtime = createSessionRuntime();
        runtimes.set(sessionKey, runtime);
      }
      return runtime;
    },

    clear(sessionKey: string): void {
      runtimes.delete(sessionKey);
    },
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dashboard table renderer (pure function, no UI deps)
// ---------------------------------------------------------------------------

function renderDashboardLines(
  st: ExperimentState,
  orchestrator: OrchestratorState | null,
  width: number,
  th: Theme,
  maxRows: number = 6
): string[] {
  const lines: string[] = [];

  if (st.results.length === 0) {
    lines.push(`  ${th.fg("dim", "No experiments yet.")}`);
    return lines;
  }

  const cur = currentResults(st.results, st.currentSegment);
  const kept = cur.filter((r) => r.status === "keep").length;
  const discarded = cur.filter((r) => r.status === "discard").length;
  const crashed = cur.filter((r) => r.status === "crash").length;
  const checksFailed = cur.filter((r) => r.status === "checks_failed").length;

  const baseline = st.bestMetric;
  const baselineRunNumber = findBaselineRunNumber(st.results, st.currentSegment);
  const baselineSec = findBaselineSecondary(st.results, st.currentSegment, st.secondaryMetrics);

  // Find best kept primary metric and its run number (current segment only)
  let bestPrimary: number | null = null;
  let bestSecondary: Record<string, number> = {};
  let bestRunNum = 0;
  for (let i = st.results.length - 1; i >= 0; i--) {
    const r = st.results[i];
    if (r.segment !== st.currentSegment) continue;
    if (r.status === "keep" && r.metric > 0) {
      if (bestPrimary === null || isBetter(r.metric, bestPrimary, st.bestDirection)) {
        bestPrimary = r.metric;
        bestSecondary = r.metrics ?? {};
        bestRunNum = i + 1;
      }
    }
  }

  // Runs summary
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Runs:")} ${th.fg("text", String(st.results.length))}` +
        `  ${th.fg("success", `${kept} kept`)}` +
        (discarded > 0 ? `  ${th.fg("warning", `${discarded} discarded`)}` : "") +
        (crashed > 0 ? `  ${th.fg("error", `${crashed} crashed`)}` : "") +
        (checksFailed > 0 ? `  ${th.fg("error", `${checksFailed} checks failed`)}` : ""),
      width
    )
  );

  if (orchestrator) {
    lines.push(
      truncateToWidth(
        `  ${th.fg("muted", "Backend:")} ` +
          (orchestrator.backend.available
            ? th.fg("success", orchestrator.backend.resolved)
            : th.fg("warning", `${orchestrator.backend.resolved} degraded`)) +
          (orchestrator.backend.degradedReason
            ? th.fg("dim", `  ${orchestrator.backend.degradedReason}`)
            : ""),
        width
      )
    );
    if (orchestrator.policy.forcedSubmitRequired) {
      lines.push(
        truncateToWidth(
          `  ${th.fg("warning", "Submission Gate:")} ${th.fg("text", orchestrator.policy.forcedSubmitReason ?? "Fresh public score required.")}`,
          width
        )
      );
    }
    for (const lane of Object.values(orchestrator.lanes)) {
      const candidateText = lane.currentCandidateId ? ` candidate=${lane.currentCandidateId}` : "";
      const strategyText = lane.currentStrategyId ? ` strategy=${lane.currentStrategyId}` : "";
      const streakText =
        lane.consecutiveNonImprovingRuns > 0
          ? ` streak=${lane.consecutiveNonImprovingRuns}`
          : "";
      const statusColor =
        lane.status === "ready"
          ? "success"
          : lane.status === "yield_required"
            ? "warning"
            : lane.status === "degraded"
              ? "error"
              : "muted";
      lines.push(
        truncateToWidth(
          `  ${th.fg("muted", `${lane.id}:`)} ${th.fg(statusColor, lane.status)}${th.fg("dim", `${strategyText}${candidateText}${streakText}`)}`,
          width
        )
      );
    }
  }

  // Baseline: first run's primary metric
  const baselineSuffix = baselineRunNumber === null ? "" : ` #${baselineRunNumber}`;
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Baseline:")} ${th.fg("dim", `★ ${st.metricName}: ${formatNum(baseline, st.metricUnit)}${baselineSuffix}`)}`,
      width
    )
  );


  // Progress: best primary metric with delta + run number
  if (bestPrimary !== null) {
    let progressLine = `  ${th.fg("muted", "Progress:")} ${th.fg("warning", th.bold(`★ ${st.metricName}: ${formatNum(bestPrimary, st.metricUnit)}`))}${th.fg("dim", ` #${bestRunNum}`)}`;

    if (baseline !== null && baseline !== 0 && bestPrimary !== baseline) {
      const pct = ((bestPrimary - baseline) / baseline) * 100;
      const sign = pct > 0 ? "+" : "";
      const color = isBetter(bestPrimary, baseline, st.bestDirection) ? "success" : "error";
      progressLine += th.fg(color, ` (${sign}${pct.toFixed(1)}%)`);
    }

    lines.push(truncateToWidth(progressLine, width));

    // Progress secondary metrics on next line with deltas
    if (st.secondaryMetrics.length > 0) {
      const secParts: string[] = [];
      for (const sm of st.secondaryMetrics) {
        const val = bestSecondary[sm.name];
        const bv = baselineSec[sm.name];
        if (val !== undefined) {
          let part = `${sm.name}: ${formatNum(val, sm.unit)}`;
          if (bv !== undefined && bv !== 0 && val !== bv) {
            const p = ((val - bv) / bv) * 100;
            const s = p > 0 ? "+" : "";
            const c = val <= bv ? "success" : "error";
            part += th.fg(c, ` ${s}${p.toFixed(1)}%`);
          }
          secParts.push(part);
        }
      }
      if (secParts.length > 0) {
        lines.push(
          truncateToWidth(
            `  ${th.fg("dim", "          ")}${th.fg("muted", secParts.join("  "))}`,
            width
          )
        );
      }
    }
  }

  lines.push("");

  // Determine visible rows for column pruning
  const effectiveMax = maxRows <= 0 ? st.results.length : maxRows;
  const startIdx = Math.max(0, st.results.length - effectiveMax);
  const visibleRows = st.results.slice(startIdx);

  // Only show secondary metric columns that have at least one value in visible rows
  const secMetrics = st.secondaryMetrics.filter((sm) =>
    visibleRows.some((r) => (r.metrics ?? {})[sm.name] !== undefined)
  );

  // Column definitions
  const col = { idx: 3, commit: 8, primary: 11, status: 15 };
  const secColWidth = 11;
  const totalSecWidth = secMetrics.length * secColWidth;
  const descW = Math.max(
    10,
    width - col.idx - col.commit - col.primary - totalSecWidth - col.status - 6
  );

  // Table header — primary metric name bolded with ★
  let headerLine =
    `  ${th.fg("muted", "#".padEnd(col.idx))}` +
    `${th.fg("muted", "commit".padEnd(col.commit))}` +
    `${th.fg("warning", th.bold(("★ " + st.metricName).slice(0, col.primary - 1).padEnd(col.primary)))}`;

  for (const sm of secMetrics) {
    headerLine += th.fg(
      "muted",
      sm.name.slice(0, secColWidth - 1).padEnd(secColWidth)
    );
  }

  headerLine +=
    `${th.fg("muted", "status".padEnd(col.status))}` +
    `${th.fg("muted", "description")}`;

  lines.push(truncateToWidth(headerLine, width));
  lines.push(
    truncateToWidth(
      `  ${th.fg("borderMuted", "─".repeat(width - 4))}`,
      width
    )
  );

  // Baseline values for delta display (current segment only)
  const baselinePrimary = findBaselineMetric(st.results, st.currentSegment);
  const baselineSecondary = findBaselineSecondary(
    st.results,
    st.currentSegment,
    st.secondaryMetrics
  );

  // Show max 6 recent runs, with a note about hidden earlier ones
  if (startIdx > 0) {
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", `… ${startIdx} earlier run${startIdx === 1 ? "" : "s"}`)}`,
        width
      )
    );
  }

  for (let i = startIdx; i < st.results.length; i++) {
    const r = st.results[i];
    const isOld = r.segment !== st.currentSegment;
    const isBaseline = !isOld && i === st.results.findIndex((x) => x.segment === st.currentSegment);

    const color = isOld
      ? "dim"
      : r.status === "keep"
        ? "success"
        : r.status === "crash" || r.status === "checks_failed"
          ? "error"
          : "warning";

    // Primary metric with color coding
    const primaryStr = formatNum(r.metric, st.metricUnit);
    let primaryColor: Parameters<typeof th.fg>[0] = isOld ? "dim" : "text";
    if (!isOld) {
      if (isBaseline) {
        primaryColor = "muted"; // baseline row
      } else if (
        baselinePrimary !== null &&
        r.status === "keep" &&
        r.metric > 0
      ) {
        if (isBetter(r.metric, baselinePrimary, st.bestDirection)) {
          primaryColor = "success";
        } else if (r.metric !== baselinePrimary) {
          primaryColor = "error";
        }
      }
    }

    const idxStr = th.fg("dim", String(i + 1).padEnd(col.idx));
    const commitStr = isOld ? "(old)".padEnd(col.commit) : r.commit.padEnd(col.commit);

    let rowLine =
      `  ${idxStr}` +
      `${th.fg(isOld ? "dim" : "accent", commitStr)}` +
      `${th.fg(primaryColor, isOld ? primaryStr.padEnd(col.primary) : th.bold(primaryStr.padEnd(col.primary)))}`;

    // Secondary metrics
    const rowMetrics = r.metrics ?? {};
    for (const sm of secMetrics) {
      const val = rowMetrics[sm.name];
      if (val !== undefined) {
        const secStr = formatNum(val, sm.unit);
        let secColor: Parameters<typeof th.fg>[0] = "dim";
        if (!isOld) {
          const bv = baselineSecondary[sm.name];
          if (isBaseline) {
            secColor = "muted"; // baseline row
          } else if (bv !== undefined && bv !== 0) {
            secColor = val <= bv ? "success" : "error";
          }
        }
        rowLine += th.fg(secColor, secStr.padEnd(secColWidth));
      } else {
        rowLine += th.fg("dim", "—".padEnd(secColWidth));
      }
    }

    rowLine +=
      `${th.fg(color, r.status.padEnd(col.status))}` +
      `${th.fg("muted", r.description.slice(0, descW))}`;

    lines.push(truncateToWidth(rowLine, width));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function autoresearchExtension(pi: ExtensionAPI) {
  const MAX_AUTORESUME_TURNS = 20;
  const EVALUATION_GUARDRAIL =
    "Be careful not to overfit to the evaluation loop and do not game the metric.";

  const runtimeStore = createRuntimeStore();
  const getSessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const getRuntime = (ctx: ExtensionContext): AutoresearchRuntime =>
    runtimeStore.ensure(getSessionKey(ctx));
  const loadSessionState = (ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx);
    const paths = getSessionPaths(ctx.cwd);
    runtime.settings = paths.settings;
    runtime.orchestrator = readOrchestrator(paths, runtime.state);
    return { runtime, paths };
  };

  const ensureLaneWorkspace = (
    paths: SessionPaths,
    orchestrator: OrchestratorState,
    laneId: string,
    experimentName: string | null
  ): string => {
    const lane = orchestrator.lanes[laneId];
    if (!lane) {
      throw new Error(`Unknown lane: ${laneId}`);
    }
    const result = ensureLaneWorktree({
      repoDir: paths.workDir,
      worktreePath: lane.worktreePath,
      laneId,
      branchPrefix: buildBranchPrefix(experimentName, paths.workDir),
    });
    lane.branchName = result.branchName;
    lane.worktreePath = result.worktreePath;
    writeOrchestrator(paths, orchestrator);
    return lane.worktreePath;
  };

  const resolveActionType = (params: Record<string, unknown>): ActionType =>
    (params.action_type as ActionType | undefined) ?? "experiment";

  const resolveScoreState = (params: Record<string, unknown>): ScoreState => {
    const explicit = params.score_state as ScoreState | undefined;
    if (explicit) return explicit;
    if (params.provisional === true) return "provisional";
    if (params.action_type === "submit") return "public_scored";
    if (params.action_type === "local_only") return "local_only";
    return "unknown";
  };

  const makeCandidateId = (
    laneId: string | undefined,
    strategyId: string | undefined,
    timestamp: number
  ) => {
    const lane = (laneId ?? "candidate").replace(/[^a-zA-Z0-9_-]+/g, "-");
    const strategy = (strategyId ?? "run").replace(/[^a-zA-Z0-9_-]+/g, "-");
    return `${lane}-${strategy}-${timestamp}`;
  };

  const collectArtifactPaths = (workDir: string): string[] => {
    const results: string[] = [];
    const preferred = [
      "outputs/metrics.json",
      "outputs/pending_submission_queue.jsonl",
      "outputs/local-run.log",
      "submission.csv",
      "submission.parquet",
    ];
    for (const relative of preferred) {
      const absolute = path.join(workDir, relative);
      if (fs.existsSync(absolute)) results.push(absolute);
    }
    const outputsDir = path.join(workDir, "outputs");
    if (fs.existsSync(outputsDir)) {
      for (const entry of fs.readdirSync(outputsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const lower = entry.name.toLowerCase();
        if (
          lower.includes("submission") ||
          lower.includes("prediction") ||
          lower.includes("candidate") ||
          lower.includes("pool") ||
          lower === "metrics.json"
        ) {
          results.push(path.join(outputsDir, entry.name));
        }
      }
    }
    return [...new Set(results)];
  };

  const writeCandidateManifest = (args: {
    paths: SessionPaths;
    candidateId: string;
    laneId?: string;
    strategyId?: string;
    experiment: ExperimentResult;
    workDir: string;
    artifactPaths: string[];
  }) => {
    const candidateDir = path.join(args.paths.candidatesDir, args.candidateId);
    fs.mkdirSync(candidateDir, { recursive: true });
    const manifest = {
      candidate_id: args.candidateId,
      lane_id: args.laneId ?? null,
      strategy_id: args.strategyId ?? null,
      commit: args.experiment.commit,
      metric: args.experiment.metric,
      metrics: args.experiment.metrics,
      status: args.experiment.status,
      description: args.experiment.description,
      action_type: args.experiment.actionType ?? null,
      score_state: args.experiment.scoreState ?? null,
      provisional: args.experiment.provisional ?? false,
      public_metrics_timestamp: args.experiment.publicMetricsTimestamp ?? null,
      worktree_path: args.workDir,
      artifact_dir: candidateDir,
      artifact_paths: args.artifactPaths,
      lineage:
        args.experiment.candidateId && args.experiment.candidateId !== args.candidateId
          ? [args.experiment.candidateId]
          : [],
      updated_at: args.experiment.timestamp,
    };
    fs.writeFileSync(
      path.join(candidateDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n"
    );
  };

  const buildProtectedRelativePaths = (paths: SessionPaths, cwd: string): string[] => {
    const candidatesDir = path.relative(cwd, paths.candidatesDir);
    const lanesDir = path.relative(cwd, paths.lanesDir);
    const shared = [
      path.relative(cwd, paths.jsonlPath),
      path.relative(cwd, paths.orchestratorPath),
      path.relative(cwd, paths.mdPath),
      path.relative(cwd, paths.ideasPath),
      "autoresearch.sh",
      "autoresearch.checks.sh",
      candidatesDir,
      lanesDir,
    ];
    return [...new Set(shared.filter((entry) => entry && !entry.startsWith("..")))];
  };

  const buildRevertCommand = (protectedPaths: string[]): string => {
    const stageable = protectedPaths.filter(
      (entry) =>
        !entry.includes("outputs/candidates") &&
        !entry.includes("/lanes") &&
        !entry.startsWith("lanes")
    );
    const protectedAdds = stageable
      .map((entry) => `git add -- "${entry}" 2>/dev/null || true`)
      .join("; ");
    const cleanExcludes = protectedPaths
      .map((entry) => `-e "${entry}"`)
      .join(" ");
    return `${protectedAdds}; git checkout -- .; git clean -fd ${cleanExcludes}`;
  };

  // Running experiment state (for spinner in fullscreen overlay)
  let overlayTui: { requestRender: () => void } | null = null;
  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;
  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  const clearOverlay = () => {
    overlayTui = null;
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
  };

  const clearSessionUi = (ctx: ExtensionContext) => {
    clearOverlay();
    if (ctx.hasUI) {
      ctx.ui.setWidget("autoresearch", undefined);
    }
  };

  const autoresearchHelp = () =>
    [
      "Usage: /autoresearch [off|clear|<text>]",
      "",
      "<text> enters autoresearch mode and starts or resumes the loop.",
      "off leaves autoresearch mode.",
      "clear deletes autoresearch.jsonl and autoresearch.orchestrator.json, then turns autoresearch mode off.",
      "",
      "Examples:",
      "  /autoresearch optimize unit test runtime, monitor correctness",
      "  /autoresearch model training, run 5 minutes of train.py and note the loss ratio as optimization target",
      "  /autoresearch chase first place in titanic, mine discussions, and iterate on notebook submissions",
    ].join("\n");

  // -----------------------------------------------------------------------
  // State reconstruction
  // -----------------------------------------------------------------------

  const reconstructState = (ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx);
    runtime.lastRunChecks = null;
    runtime.runningExperiment = null;
    runtime.lastAutoResumeTime = 0;
    runtime.experimentsThisSession = 0;
    runtime.autoResumeTurns = 0;
    runtime.state = createExperimentState();
    runtime.orchestrator = null;
    runtime.settings = null;

    let state = runtime.state;
    const paths = getSessionPaths(ctx.cwd);
    runtime.settings = paths.settings;
    let loadedFromJsonl = false;
    try {
      if (fs.existsSync(paths.jsonlPath)) {
        runtime.state = restoreExperimentStateFromJsonl(
          fs.readFileSync(paths.jsonlPath, "utf-8")
        );
        state = runtime.state;
        if (state.results.length > 0) {
          loadedFromJsonl = true;
        }
      }
    } catch {
      // Fall through to session history
    }

    // Fallback: reconstruct from session history (backward compat)
    if (!loadedFromJsonl) {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role !== "toolResult" || msg.toolName !== "log_experiment")
          continue;
        const details = msg.details as LogDetails | undefined;
        if (details?.state) {
          runtime.state = cloneExperimentState(details.state);
          state = runtime.state;
          if (!state.secondaryMetrics) state.secondaryMetrics = [];
          if (state.metricUnit === "s" && state.metricName === "metric") {
            state.metricUnit = "";
          }
          for (const r of state.results) {
            if (!r.metrics) r.metrics = {};
          }
        }
      }
    }

    state.maxExperiments = paths.settings.maxIterations;
    runtime.orchestrator = readOrchestrator(paths, state);

    runtime.autoresearchMode =
      fs.existsSync(paths.jsonlPath) || fs.existsSync(paths.orchestratorPath);

    updateWidget(ctx);
  };

  const updateWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    const runtime = getRuntime(ctx);
    const state = runtime.state;

    if (state.results.length === 0) {
      if (!runtime.runningExperiment) {
        ctx.ui.setWidget("autoresearch", undefined);
        return;
      }

      ctx.ui.setWidget("autoresearch", (_tui, theme) => {
        const parts = [
          theme.fg("accent", "🔬"),
          theme.fg("warning", " running…"),
        ];

        if (state.name) {
          parts.push(theme.fg("dim", ` │ ${state.name}`));
        }

        if (runtime.orchestrator && !runtime.orchestrator.backend.available) {
          parts.push(theme.fg("warning", " │ degraded backend"));
        }

        parts.push(theme.fg("dim", ` │ ${runtime.runningExperiment.command}`));
        parts.push(theme.fg("dim", "  (waiting for first logged result)"));

        return new Text(parts.join(""), 0, 0);
      });
      return;
    }

    if (runtime.dashboardExpanded) {
      // Expanded: full dashboard table rendered as widget
      ctx.ui.setWidget("autoresearch", (_tui, theme) => {
        const width = process.stdout.columns || 120;
        const lines: string[] = [];

        const hintText = " ctrl+x collapse • ctrl+shift+x fullscreen ";
        const labelPrefix = "🔬 autoresearch";
        const nameStr = state.name ? `: ${state.name}` : "";
        // 3 leading dashes + space + label + space + fill + hint
        const maxLabelLen = width - 3 - 2 - hintText.length - 1;
        let label = labelPrefix + nameStr;
        if (label.length > maxLabelLen) {
          label = label.slice(0, maxLabelLen - 1) + "…";
        }
        const fillLen = Math.max(0, width - 3 - 1 - label.length - 1 - hintText.length);
        lines.push(
          truncateToWidth(
            theme.fg("borderMuted", "───") +
              theme.fg("accent", " " + label + " ") +
              theme.fg("borderMuted", "─".repeat(fillLen)) +
              theme.fg("dim", hintText),
            width
          )
        );

        lines.push(...renderDashboardLines(state, runtime.orchestrator, width, theme));

        return new Text(lines.join("\n"), 0, 0);
      });
    } else {
      // Collapsed: compact one-liner — compute everything inside render
      ctx.ui.setWidget("autoresearch", (_tui, theme) => {
        const cur = currentResults(state.results, state.currentSegment);
        const kept = cur.filter((r) => r.status === "keep").length;
        const crashed = cur.filter((r) => r.status === "crash").length;
        const checksFailed = cur.filter((r) => r.status === "checks_failed").length;
        const baseline = state.bestMetric;
        const baselineSec = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
        const orchestrator = runtime.orchestrator;

        // Find best kept primary metric, its secondary values, and run number
        let bestPrimary: number | null = null;
        let bestSec: Record<string, number> = {};
        let bestRunNum = 0;
        for (let i = state.results.length - 1; i >= 0; i--) {
          const r = state.results[i];
          if (r.segment !== state.currentSegment) continue;
          if (r.status === "keep" && r.metric > 0) {
            if (bestPrimary === null || isBetter(r.metric, bestPrimary, state.bestDirection)) {
              bestPrimary = r.metric;
              bestSec = r.metrics ?? {};
              bestRunNum = i + 1;
            }
          }
        }

        const displayVal = bestPrimary ?? baseline;
        const parts = [
          theme.fg("accent", "🔬"),
          theme.fg("muted", ` ${state.results.length} runs`),
          theme.fg("success", ` ${kept} kept`),
          crashed > 0 ? theme.fg("error", ` ${crashed}💥`) : "",
          checksFailed > 0 ? theme.fg("error", ` ${checksFailed}⚠`) : "",
          theme.fg("dim", " │ "),
          theme.fg("warning", theme.bold(`★ ${state.metricName}: ${formatNum(displayVal, state.metricUnit)}`)),
          bestRunNum > 0 ? theme.fg("dim", ` #${bestRunNum}`) : "",
        ];

        // Show delta % vs baseline for primary
        if (baseline !== null && bestPrimary !== null && baseline !== 0 && bestPrimary !== baseline) {
          const pct = ((bestPrimary - baseline) / baseline) * 100;
          const sign = pct > 0 ? "+" : "";
          const deltaColor = isBetter(bestPrimary, baseline, state.bestDirection) ? "success" : "error";
          parts.push(theme.fg(deltaColor, ` (${sign}${pct.toFixed(1)}%)`));
        }

        // Show secondary metrics with delta %
        if (state.secondaryMetrics.length > 0) {
          for (const sm of state.secondaryMetrics) {
            const val = bestSec[sm.name];
            const bv = baselineSec[sm.name];
            if (val !== undefined) {
              parts.push(theme.fg("dim", "  "));
              let secText = `${sm.name}: ${formatNum(val, sm.unit)}`;
              if (bv !== undefined && bv !== 0 && val !== bv) {
                const p = ((val - bv) / bv) * 100;
                const s = p > 0 ? "+" : "";
                const c = val <= bv ? "success" : "error";
                secText += theme.fg(c, ` ${s}${p.toFixed(1)}%`);
              }
              parts.push(theme.fg("muted", secText));
            }
          }
        }

        if (state.name) {
          parts.push(theme.fg("dim", ` │ ${state.name}`));
        }

        if (orchestrator) {
          parts.push(
            theme.fg(
              orchestrator.backend.available ? "muted" : "warning",
              orchestrator.backend.available ? " │ lanes active" : " │ lanes degraded"
            )
          );
          if (orchestrator.policy.forcedSubmitRequired) {
            parts.push(theme.fg("warning", " │ submit now"));
          }
        }

        parts.push(theme.fg("dim", "  (ctrl+x expand • ctrl+shift+x fullscreen)"));

        return new Text(parts.join(""), 0, 0);
      });
    }
  };

  pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_switch", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_fork", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_before_switch", async () => {
    clearOverlay();
  });
  pi.on("session_shutdown", async (_e, ctx) => {
    clearSessionUi(ctx);
    runtimeStore.clear(getSessionKey(ctx));
  });

  // Reset per-session experiment counter when agent starts
  pi.on("agent_start", async (_event, ctx) => {
    getRuntime(ctx).experimentsThisSession = 0;
  });

  // Clear running experiment state when agent stops; check ideas file for continuation
  pi.on("agent_end", async (_event, ctx) => {
    const runtime = getRuntime(ctx);
    runtime.runningExperiment = null;
    if (overlayTui) overlayTui.requestRender();

    if (!runtime.autoresearchMode) return;

    // Don't auto-resume if no experiments ran this session (user likely stopped manually)
    if (runtime.experimentsThisSession === 0) return;

    // Rate-limit auto-resume to once every 5 minutes
    const now = Date.now();
    if (now - runtime.lastAutoResumeTime < 5 * 60 * 1000) return;
    runtime.lastAutoResumeTime = now;

    if (runtime.autoResumeTurns >= MAX_AUTORESUME_TURNS) {
      ctx.ui.notify(
        `Autoresearch auto-resume limit reached (${MAX_AUTORESUME_TURNS} turns)`,
        "info"
      );
      return;
    }

    const { runtime: refreshed, paths } = loadSessionState(ctx);
    const hasIdeas = fs.existsSync(paths.ideasPath);
    const orchestratorNote =
      refreshed.orchestrator && !refreshed.orchestrator.backend.available
        ? " The worker backend is degraded, so lane work must be rotated serially unless `pi` becomes available."
        : "";

    let resumeMsg = "Autoresearch loop ended (likely context limit). Resume the experiment loop — read autoresearch.md and git log for context.";
    if (hasIdeas) {
      resumeMsg += " Check autoresearch.ideas.md for promising paths to explore. Prune stale/tried ideas.";
    }
    resumeMsg += ` Read ${paths.orchestratorPath} before choosing the next lane.`;
    if (refreshed.orchestrator?.policy.forcedSubmitRequired) {
      resumeMsg += ` ${refreshed.orchestrator.policy.forcedSubmitReason ?? "A scored submission is required before more local-only work."}`;
    }
    resumeMsg += orchestratorNote;
    resumeMsg += ` ${EVALUATION_GUARDRAIL}`;

    runtime.autoResumeTurns++;
    pi.sendUserMessage(resumeMsg);
  });

  // When in autoresearch mode, add a static note to the system prompt.
  // Only a short pointer — no file content, fully cache-safe.
  pi.on("before_agent_start", async (event, ctx) => {
    const { runtime, paths } = loadSessionState(ctx);
    if (!runtime.autoresearchMode) return;
    const hasIdeas = fs.existsSync(paths.ideasPath);
    const hasChecks = fs.existsSync(paths.checksPath);

    let extra =
      "\n\n## Autoresearch Mode (ACTIVE)" +
      "\nYou are in autoresearch mode. Optimize the primary metric through an autonomous experiment loop." +
      "\nUse init_experiment, run_experiment, and log_experiment tools. NEVER STOP until interrupted." +
      `\nExperiment rules: ${paths.mdPath} — read this file at the start of every session and after compaction.` +
      `\nOrchestrator state: ${paths.orchestratorPath} — read this file before selecting a lane or candidate.` +
      "\nWrite promising but deferred optimizations as bullet points to autoresearch.ideas.md — don't let good ideas get lost." +
      "\nWhen parallel orchestration is enabled, use lane_ids exploit, explore, and merge. Always pass lane_id and strategy_id to run_experiment and log_experiment when you are operating inside a lane." +
      "\nCandidate-producing keeps should carry a candidate_id so the coordinator can compare, queue, and merge them." +
      "\nThe merge lane is for artifact-level merges or ensembles first. Do not auto-merge code branches." +
      `\n${EVALUATION_GUARDRAIL}` +
      "\nIf the user sends a follow-on message while an experiment is running, finish the current run_experiment + log_experiment cycle first, then address their message in the next iteration.";

    if (runtime.orchestrator) {
      extra +=
        `\nParallel backend: ${runtime.orchestrator.backend.resolved}` +
        (runtime.orchestrator.backend.available
          ? " (available)."
          : ` (degraded). ${runtime.orchestrator.backend.degradedReason ?? ""}`);
      extra +=
        "\nLane notes:" +
        Object.values(runtime.orchestrator.lanes)
          .map((lane) => ` ${lane.id}=${lane.notesPath}`)
          .join(",");
      if (runtime.orchestrator.policy.forcedSubmitRequired) {
        extra += `\nSubmission freshness gate: ${runtime.orchestrator.policy.forcedSubmitReason ?? "A fresh public score is required now."}`;
      }
    }

    if (hasChecks) {
      extra +=
        "\n\n## Backpressure Checks (ACTIVE)" +
        `\n${paths.checksPath} exists and runs automatically after every passing experiment command in run_experiment.` +
        "\nIf the experiment command passes but checks fail, run_experiment will report it clearly." +
        "\nUse status 'checks_failed' in log_experiment when this happens — it behaves like a crash (no commit, changes auto-reverted)." +
        "\nYou cannot use status 'keep' when checks have failed." +
        "\nThe checks execution time does NOT affect the primary metric.";
    }

    if (hasIdeas) {
      extra += `\n\n💡 Ideas backlog exists at ${paths.ideasPath} — check it for promising experiment paths. Prune stale entries.`;
    }

    return {
      systemPrompt: event.systemPrompt + extra,
    };
  });

  // -----------------------------------------------------------------------
  // init_experiment tool — one-time setup
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "init_experiment",
    label: "Init Experiment",
    description:
      "Initialize the experiment session. Call once before the first run_experiment to set the name, primary metric, unit, and direction. Writes the config header to autoresearch.jsonl.",
    promptSnippet:
      "Initialize experiment session (name, metric, unit, direction). Call once before first run.",
    promptGuidelines: [
      "Call init_experiment exactly once at the start of an autoresearch session, before the first run_experiment.",
      "If autoresearch.jsonl already exists with a config, do NOT call init_experiment again.",
      "If the optimization target changes (different experiment workflow, metric, or workload), call init_experiment again to insert a new config header and reset the baseline.",
    ],
    parameters: InitParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const state = runtime.state;
      const { paths } = loadSessionState(ctx);

      // Validate working directory exists
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }

      const isReinit = state.results.length > 0;

      state.name = params.name;
      state.metricName = params.metric_name;
      state.metricUnit = params.metric_unit ?? "";
      if (params.direction === "lower" || params.direction === "higher") {
        state.bestDirection = params.direction;
      }
      // Reset results for new baseline segment
      state.results = [];
      state.bestMetric = null;
      state.secondaryMetrics = [];

      // Read max experiments from config file (config always in ctx.cwd)
      state.maxExperiments = paths.settings.maxIterations;

      // Write config header to jsonl (append for re-init, create for first)
      try {
        const config = JSON.stringify({
          type: "config",
          name: state.name,
          metricName: state.metricName,
          metricUnit: state.metricUnit,
          bestDirection: state.bestDirection,
        });
        if (isReinit) {
          fs.appendFileSync(paths.jsonlPath, config + "\n");
        } else {
          fs.writeFileSync(paths.jsonlPath, config + "\n");
        }
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: `⚠️ Failed to write autoresearch.jsonl: ${e instanceof Error ? e.message : String(e)}`,
          }],
          details: {},
        };
      }

      runtime.autoresearchMode = true;
      runtime.orchestrator = readOrchestrator(paths, state);
      updateWidget(ctx);

      const reinitNote = isReinit ? " (re-initialized — previous results archived, new baseline needed)" : "";
      const limitNote = state.maxExperiments !== null ? `\nMax iterations: ${state.maxExperiments} (from autoresearch.config.json)` : "";
      const workDirNote = paths.workDir !== ctx.cwd ? `\nWorking directory: ${paths.workDir}` : "";
      const stateDirNote = paths.stateDir !== paths.workDir ? `\nState directory: ${paths.stateDir}` : "";
      return {
        content: [{
          type: "text",
          text: `✅ Experiment initialized: "${state.name}"${reinitNote}\nMetric: ${state.metricName} (${state.metricUnit || "unitless"}, ${state.bestDirection} is better)${limitNote}${workDirNote}${stateDirNote}\nConfig written to ${paths.jsonlPath}. Now run the baseline with run_experiment.`,
        }],
        details: { state: cloneExperimentState(state), orchestrator: runtime.orchestrator },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("init_experiment "));
      text += theme.fg("accent", args.name ?? "");
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // run_experiment tool
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "run_experiment",
    label: "Run Experiment",
    description:
      "Run a shell command as an experiment. Times wall-clock duration, captures output, detects pass/fail via exit code. Use for any autoresearch experiment.",
    promptSnippet:
      "Run a timed experiment command (captures duration, output, exit code)",
    promptGuidelines: [
      "Use run_experiment instead of bash when running experiment commands — it handles timing and output capture automatically.",
      "After run_experiment, always call log_experiment to record the result.",
    ],
    parameters: RunParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { runtime, paths } = loadSessionState(ctx);
      const state = runtime.state;
      const orchestrator = runtime.orchestrator ?? readOrchestrator(paths, state);

      // Validate working directory exists
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }

      // Block if max experiments limit already reached
      if (state.maxExperiments !== null) {
        const segCount = currentResults(state.results, state.currentSegment).length;
        if (segCount >= state.maxExperiments) {
          return {
            content: [{ type: "text", text: `🛑 Maximum experiments reached (${state.maxExperiments}). The experiment loop is done. To continue, call init_experiment to start a new segment.` }],
            details: {},
          };
        }
      }

      const blockReason = getRunBlockReason(
        orchestrator,
        params.command,
        params.lane_id,
        params.strategy_id
      );
      if (blockReason) {
        return {
          content: [{ type: "text", text: `🛑 ${blockReason}` }],
          details: {},
        };
      }

      let execWorkDir = paths.workDir;
      if (params.lane_id && paths.settings.parallelism.enabled) {
        try {
          execWorkDir = ensureLaneWorkspace(
            paths,
            orchestrator,
            params.lane_id,
            state.name
          );
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `❌ Failed to prepare lane ${params.lane_id}: ${error instanceof Error ? error.message : String(error)}`,
            }],
            details: {},
          };
        }
      }

      const timeout = (params.timeout_seconds ?? 600) * 1000;

      const startedAt = Date.now();
      runtime.runningExperiment = {
        startedAt,
        command: params.command,
        laneId: params.lane_id,
        strategyId: params.strategy_id,
        candidateId: params.candidate_id,
        workDir: execWorkDir,
      };
      markLaneRunning(orchestrator, {
        laneId: params.lane_id ?? "",
        strategyId: params.strategy_id,
        candidateId: params.candidate_id,
        timestamp: startedAt,
      });
      writeOrchestrator(paths, orchestrator);
      updateWidget(ctx);
      if (overlayTui) overlayTui.requestRender();

      onUpdate?.({
        content: [{
          type: "text",
          text:
            `Running: ${params.command}` +
            (params.lane_id ? `\nLane: ${params.lane_id}` : "") +
            `\nWorkdir: ${execWorkDir}`,
        }],
        details: { phase: "running" },
      });

      const t0 = startedAt;

      let result;
      try {
        result = await pi.exec("bash", ["-c", params.command], {
          signal,
          timeout,
          cwd: execWorkDir,
        });
      } finally {
        runtime.runningExperiment = null;
        clearLaneRunning(orchestrator, params.lane_id, Date.now());
        writeOrchestrator(paths, orchestrator);
        updateWidget(ctx);
        if (overlayTui) overlayTui.requestRender();
      }

      const durationSeconds = (Date.now() - t0) / 1000;
      const output = (result.stdout + "\n" + result.stderr).trim();
      const benchmarkPassed = result.code === 0 && !result.killed;

      // Run backpressure checks if benchmark passed and checks file exists
      let checksPass: boolean | null = null;
      let checksTimedOut = false;
      let checksOutput = "";
      let checksDuration = 0;

      const laneChecksPath = path.join(execWorkDir, "autoresearch.checks.sh");
      const checksPath = fs.existsSync(laneChecksPath) ? laneChecksPath : paths.checksPath;
      const checksCwd = fs.existsSync(laneChecksPath) ? execWorkDir : paths.workDir;
      if (benchmarkPassed && fs.existsSync(checksPath)) {
        const checksTimeout = (params.checks_timeout_seconds ?? 300) * 1000;
        const ct0 = Date.now();
        try {
          const checksResult = await pi.exec("bash", [checksPath], {
            signal,
            timeout: checksTimeout,
            cwd: checksCwd,
          });
          checksDuration = (Date.now() - ct0) / 1000;
          checksTimedOut = !!checksResult.killed;
          checksPass = checksResult.code === 0 && !checksResult.killed;
          checksOutput = (checksResult.stdout + "\n" + checksResult.stderr).trim();
        } catch (e) {
          checksDuration = (Date.now() - ct0) / 1000;
          checksPass = false;
          checksOutput = e instanceof Error ? e.message : String(e);
        }
      }

      // Store checks result for log_experiment gate
      runtime.lastRunChecks = checksPass !== null ? { pass: checksPass, output: checksOutput, duration: checksDuration } : null;

      // Overall pass: benchmark must pass AND checks must pass (if they ran)
      const passed = benchmarkPassed && (checksPass === null || checksPass);

      const details: RunDetails = {
        command: params.command,
        exitCode: result.code,
        durationSeconds,
        passed,
        crashed: !passed,
        timedOut: !!result.killed,
        tailOutput: output.split("\n").slice(-80).join("\n"),
        checksPass,
        checksTimedOut,
        checksOutput: checksOutput.split("\n").slice(-80).join("\n"),
        checksDuration,
        laneId: params.lane_id,
        strategyId: params.strategy_id,
        candidateId: params.candidate_id,
        resolvedWorkDir: execWorkDir,
      };

      // Build LLM response
      let text = "";
      if (details.timedOut) {
        text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s\n`;
      } else if (!benchmarkPassed) {
        text += `💥 FAILED (exit code ${result.code}) in ${durationSeconds.toFixed(1)}s\n`;
      } else if (checksTimedOut) {
        text += `✅ Experiment PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `⏰ CHECKS TIMEOUT (autoresearch.checks.sh) after ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed' — the primary metric is valid but checks timed out.\n`;
      } else if (checksPass === false) {
        text += `✅ Experiment PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `💥 CHECKS FAILED (autoresearch.checks.sh) in ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed' — the primary metric is valid but correctness checks did not pass.\n`;
      } else {
        text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`;
        if (checksPass === true) {
          text += `✅ Checks passed in ${checksDuration.toFixed(1)}s\n`;
        }
      }

      if (params.lane_id) {
        text += `🧭 Lane: ${params.lane_id}\n`;
      }

      if (state.bestMetric !== null) {
        text += `📊 Current best ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}\n`;
      }

      text += `\nLast 80 lines of output:\n${details.tailOutput}`;

      if (checksPass === false) {
        text += `\n\n── Checks output (last 80 lines) ──\n${details.checksOutput}`;
      }

      const truncation = truncateTail(text, {
        maxLines: 150,
        maxBytes: 40000,
      });

      return {
        content: [{ type: "text", text: truncation.content }],
        details,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("run_experiment "));
      text += theme.fg("muted", args.command);
      if (args.lane_id) {
        text += theme.fg("dim", ` [${args.lane_id}]`);
      }
      if (args.timeout_seconds) {
        text += theme.fg("dim", ` (timeout: ${args.timeout_seconds}s)`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(
          theme.fg("warning", "⏳ Running experiment..."),
          0,
          0
        );
      }

      const d = result.details as RunDetails | undefined;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      if (d.timedOut) {
        let text = theme.fg(
          "error",
          `⏰ TIMEOUT ${d.durationSeconds.toFixed(1)}s`
        );
        if (expanded) text += "\n" + theme.fg("dim", d.tailOutput.slice(-500));
        return new Text(text, 0, 0);
      }

      if (d.checksTimedOut) {
        // Benchmark passed but checks timed out
        let text =
          theme.fg("success", `✅ ${d.durationSeconds.toFixed(1)}s`) +
          theme.fg("error", ` ⏰ checks timeout ${d.checksDuration.toFixed(1)}s`);
        if (expanded) {
          text += "\n" + theme.fg("dim", d.checksOutput.slice(-500));
        }
        return new Text(text, 0, 0);
      }

      if (d.checksPass === false) {
        // Benchmark passed but checks failed
        let text =
          theme.fg("success", `✅ ${d.durationSeconds.toFixed(1)}s`) +
          theme.fg("error", ` 💥 checks failed ${d.checksDuration.toFixed(1)}s`);
        if (expanded) {
          text += "\n" + theme.fg("dim", d.checksOutput.slice(-500));
        }
        return new Text(text, 0, 0);
      }

      if (d.crashed) {
        let text = theme.fg(
          "error",
          `💥 FAIL exit=${d.exitCode} ${d.durationSeconds.toFixed(1)}s`
        );
        if (expanded) text += "\n" + theme.fg("dim", d.tailOutput.slice(-500));
        return new Text(text, 0, 0);
      }

      let text =
        theme.fg("success", "✅ ") +
        theme.fg("accent", `${d.durationSeconds.toFixed(1)}s`);

      if (d.checksPass === true) {
        text += theme.fg("success", ` ✓ checks ${d.checksDuration.toFixed(1)}s`);
      }

      if (expanded) {
        text += "\n" + theme.fg("dim", d.tailOutput.slice(-1000));
      }

      return new Text(text, 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // log_experiment tool
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "log_experiment",
    label: "Log Experiment",
    description:
      "Record an experiment result. Tracks metrics, updates the status widget and dashboard. Call after every run_experiment.",
    promptSnippet:
      "Log experiment result (commit, metric, status, description)",
    promptGuidelines: [
      "Always call log_experiment after run_experiment to record the result.",
      "log_experiment automatically runs git add -A && git commit on 'keep', and auto-reverts code changes on 'discard'/'crash'/'checks_failed' (autoresearch files are preserved). Do NOT commit or revert manually.",
      "Use status 'keep' if the PRIMARY metric improved. 'discard' if worse or unchanged. 'crash' if it failed. If the primary metric is tied, an explicitly chosen secondary tie-breaker may decide keep/discard; explain that in the description.",
      "If you discover complex but promising optimizations you won't pursue immediately, append them as bullet points to autoresearch.ideas.md. Don't let good ideas get lost.",
    ],
    parameters: LogParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { runtime, paths } = loadSessionState(ctx);
      const state = runtime.state;
      const orchestrator = runtime.orchestrator ?? readOrchestrator(paths, state);

      // Validate working directory exists
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }
      const secondaryMetrics = (params.metrics ?? {}) as Record<string, number>;
      const actionType = resolveActionType(params as Record<string, unknown>);
      const scoreState = resolveScoreState(params as Record<string, unknown>);
      const timestamp = Date.now();
      const candidateId =
        params.candidate_id ??
        (params.status === "keep"
          ? makeCandidateId(params.lane_id, params.strategy_id, timestamp)
          : undefined);

      let execWorkDir = paths.workDir;
      if (params.lane_id && paths.settings.parallelism.enabled) {
        try {
          execWorkDir = ensureLaneWorkspace(
            paths,
            orchestrator,
            params.lane_id,
            state.name
          );
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `❌ Failed to prepare lane ${params.lane_id}: ${error instanceof Error ? error.message : String(error)}`,
            }],
            details: {},
          };
        }
      }

      // Gate: prevent "keep" when last run's checks failed
      if (params.status === "keep" && runtime.lastRunChecks && !runtime.lastRunChecks.pass) {
        return {
          content: [{
            type: "text",
            text: `❌ Cannot keep — autoresearch.checks.sh failed.\n\n${runtime.lastRunChecks.output.slice(-500)}\n\nLog as 'checks_failed' instead. The primary metric is valid but correctness checks did not pass.`,
          }],
          details: {},
        };
      }

      if (params.status === "keep" && scoreState === "quota_exhausted" && !params.provisional) {
        return {
          content: [{
            type: "text",
            text: "❌ Quota-exhausted local keeps must be marked provisional=true so they are not treated as fresh public progress.",
          }],
          details: {},
        };
      }

      // Validate secondary metrics consistency (after first experiment establishes them)
      if (state.secondaryMetrics.length > 0) {
        const knownNames = new Set(state.secondaryMetrics.map((m) => m.name));
        const providedNames = new Set(Object.keys(secondaryMetrics));

        // Check for missing metrics
        const missing = [...knownNames].filter((n) => !providedNames.has(n));
        if (missing.length > 0) {
          return {
            content: [{
              type: "text",
              text: `❌ Missing secondary metrics: ${missing.join(", ")}\n\nYou must provide all previously tracked metrics. Expected: ${[...knownNames].join(", ")}\nGot: ${[...providedNames].join(", ") || "(none)"}\n\nFix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`,
            }],
            details: {},
          };
        }

        // Check for new metrics not yet tracked
        const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
        if (newMetrics.length > 0 && !params.force) {
          return {
            content: [{
              type: "text",
              text: `❌ New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}\n\nExisting metrics: ${[...knownNames].join(", ")}\n\nIf this metric has proven very valuable to watch, call log_experiment again with force: true to add it. Otherwise, remove it from the metrics parameter.`,
            }],
            details: {},
          };
        }
      }

      const experiment: ExperimentResult = {
        commit: params.commit.slice(0, 7),
        metric: params.metric,
        metrics: secondaryMetrics,
        status: params.status,
        description: params.description,
        timestamp,
        segment: state.currentSegment,
        laneId: params.lane_id,
        strategyId: params.strategy_id,
        candidateId,
        actionType,
        scoreState,
        provisional: params.provisional,
        publicMetricsTimestamp: params.public_metrics_timestamp ?? null,
      };

      state.results.push(experiment);
      runtime.experimentsThisSession++;

      // Register any new secondary metric names
      for (const name of Object.keys(secondaryMetrics)) {
        if (!state.secondaryMetrics.find((m) => m.name === name)) {
          state.secondaryMetrics.push({ name, unit: metricUnitFromName(name) });
        }
      }

      // Baseline = first run in current segment
      state.bestMetric = findBaselineMetric(state.results, state.currentSegment);

      // Build response text
      const segmentCount = currentResults(state.results, state.currentSegment).length;
      let text = `Logged #${state.results.length}: ${experiment.status} — ${experiment.description}`;

      if (state.bestMetric !== null) {
        text += `\nBaseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`;
        if (segmentCount > 1 && params.status === "keep" && params.metric > 0) {
          const delta = params.metric - state.bestMetric;
          const pct = ((delta / state.bestMetric) * 100).toFixed(1);
          const sign = delta > 0 ? "+" : "";
          text += ` | this: ${formatNum(params.metric, state.metricUnit)} (${sign}${pct}%)`;
        }
      }

      // Show secondary metrics
      if (Object.keys(secondaryMetrics).length > 0) {
        const baselines = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
        const parts: string[] = [];
        for (const [name, value] of Object.entries(secondaryMetrics)) {
          const def = state.secondaryMetrics.find((m) => m.name === name);
          const unit = def?.unit ?? "";
          let part = `${name}: ${formatNum(value, unit)}`;
          const bv = baselines[name];
          if (bv !== undefined && state.results.length > 1 && bv !== 0) {
            const d = value - bv;
            const p = ((d / bv) * 100).toFixed(1);
            const s = d > 0 ? "+" : "";
            part += ` (${s}${p}%)`;
          }
          parts.push(part);
        }
        text += `\nSecondary: ${parts.join("  ")}`;
      }

      text += `\n(${segmentCount} experiments`;
      if (state.maxExperiments !== null) {
        text += ` / ${state.maxExperiments} max`;
      }
      text += `)`;
      if (params.lane_id) {
        text += `\nLane: ${params.lane_id}`;
      }
      if (params.strategy_id) {
        text += ` | strategy: ${params.strategy_id}`;
      }
      if (candidateId) {
        text += ` | candidate: ${candidateId}`;
      }
      text += `\nScore state: ${scoreState}`;

      // Auto-commit only on keep — discards/crashes get reverted anyway
      if (params.status === "keep") {
        try {
          const resultData: Record<string, unknown> = {
            status: params.status,
            [state.metricName || "metric"]: params.metric,
            ...secondaryMetrics,
            lane_id: params.lane_id ?? null,
            strategy_id: params.strategy_id ?? null,
            candidate_id: candidateId ?? null,
            action_type: actionType,
            score_state: scoreState,
          };
          const trailerJson = JSON.stringify(resultData);
          const commitMsg = `${params.description}\n\nResult: ${trailerJson}`;

          const execOpts = { cwd: execWorkDir, timeout: 10000 };
          const addResult = await pi.exec("git", ["add", "-A"], execOpts);
          if (addResult.code !== 0) {
            const addErr = (addResult.stdout + addResult.stderr).trim();
            throw new Error(`git add failed (exit ${addResult.code}): ${addErr.slice(0, 200)}`);
          }

          const diffResult = await pi.exec("git", ["diff", "--cached", "--quiet"], execOpts);
          if (diffResult.code === 0) {
            text += `\n📝 Git: nothing to commit (working tree clean)`;
          } else {
            const gitResult = await pi.exec("git", ["commit", "-m", commitMsg], execOpts);
            const gitOutput = (gitResult.stdout + gitResult.stderr).trim();
            if (gitResult.code === 0) {
              const firstLine = gitOutput.split("\n")[0] || "";
              text += `\n📝 Git: committed — ${firstLine}`;

              try {
                const shaResult = await pi.exec("git", ["rev-parse", "--short=7", "HEAD"], { cwd: execWorkDir, timeout: 5000 });
                const newSha = (shaResult.stdout || "").trim();
                if (newSha && newSha.length >= 7) {
                  experiment.commit = newSha;
                }
              } catch {
                // Keep the original commit hash if rev-parse fails
              }
            } else {
              text += `\n⚠️ Git commit failed (exit ${gitResult.code}): ${gitOutput.slice(0, 200)}`;
            }
          }
        } catch (e) {
          text += `\n⚠️ Git commit error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      const artifactPaths = collectArtifactPaths(execWorkDir);
      if (params.status === "keep" && candidateId) {
        writeCandidateManifest({
          paths,
          candidateId,
          laneId: params.lane_id,
          strategyId: params.strategy_id,
          experiment,
          workDir: execWorkDir,
          artifactPaths,
        });
      }

      applyExperimentToOrchestrator(orchestrator, {
        laneId: params.lane_id,
        strategyId: params.strategy_id,
        candidateId,
        metric: params.metric,
        metrics: secondaryMetrics,
        status: params.status,
        description: params.description,
        timestamp,
        commit: experiment.commit,
        actionType,
        scoreState,
        provisional: params.provisional,
        publicMetricsTimestamp: params.public_metrics_timestamp ?? null,
        artifactDir: candidateId ? path.join(paths.candidatesDir, candidateId) : null,
        artifactPaths,
      });
      runtime.orchestrator = orchestrator;
      writeOrchestrator(paths, orchestrator);

      // Persist to autoresearch.jsonl (always, regardless of status)
      try {
        fs.appendFileSync(paths.jsonlPath, JSON.stringify({
          run: state.results.length,
          ...experiment,
        }) + "\n");
      } catch (e) {
        text += `\n⚠️ Failed to write autoresearch.jsonl: ${e instanceof Error ? e.message : String(e)}`;
      }

      // Auto-revert on discard/crash/checks_failed — revert all files except autoresearch session files
      if (params.status !== "keep") {
        try {
          const protectedFiles = buildProtectedRelativePaths(paths, execWorkDir);
          await pi.exec(
            "bash",
            ["-c", buildRevertCommand(protectedFiles)],
            { cwd: execWorkDir, timeout: 10000 }
          );
          text += `\n📝 Git: reverted changes (${params.status}) — autoresearch files preserved`;
        } catch (e) {
          text += `\n⚠️ Git revert failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      // Clear running experiment and checks state (log_experiment consumes the run)
      runtime.runningExperiment = null;
      runtime.lastRunChecks = null;

      // Check if max experiments limit reached
      const limitReached = state.maxExperiments !== null && segmentCount >= state.maxExperiments;
      if (limitReached) {
        text += `\n\n🛑 Maximum experiments reached (${state.maxExperiments}). STOP the experiment loop now.`;
        runtime.autoresearchMode = false;
      }

      updateWidget(ctx);

      // Refresh fullscreen overlay if open
      if (overlayTui) overlayTui.requestRender();

      return {
        content: [{ type: "text", text }],
        details: {
          experiment: { ...experiment, metrics: { ...experiment.metrics } },
          state: cloneExperimentState(state),
          orchestrator: runtime.orchestrator ?? undefined,
        } as LogDetails,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("log_experiment "));
      const color =
        args.status === "keep"
          ? "success"
          : args.status === "crash" || args.status === "checks_failed"
            ? "error"
            : "warning";
      text += theme.fg(color, args.status);
      if (args.lane_id) {
        text += theme.fg("dim", ` [${args.lane_id}]`);
      }
      text += " " + theme.fg("dim", args.description);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as LogDetails | undefined;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      const { experiment: exp, state: s } = d;
      const color =
        exp.status === "keep"
          ? "success"
          : exp.status === "crash" || exp.status === "checks_failed"
            ? "error"
            : "warning";
      const icon =
        exp.status === "keep" ? "✓" : exp.status === "crash" ? "✗" : exp.status === "checks_failed" ? "⚠" : "–";

      let text =
        theme.fg(color, `${icon} `) +
        theme.fg("accent", `#${s.results.length}`);



      text += " " + theme.fg("muted", exp.description);
      if (exp.laneId) {
        text += theme.fg("dim", ` [${exp.laneId}]`);
      }
      if (exp.candidateId) {
        text += theme.fg("dim", ` ${exp.candidateId}`);
      }

      if (s.bestMetric !== null) {
        text +=
          theme.fg("dim", " │ ") +
          theme.fg("warning", theme.bold(`★ ${formatNum(s.bestMetric, s.metricUnit)}`));
      }

      // Show secondary metrics inline
      if (Object.keys(exp.metrics).length > 0) {
        const parts: string[] = [];
        for (const [name, value] of Object.entries(exp.metrics)) {
          const def = s.secondaryMetrics.find((m) => m.name === name);
          parts.push(`${name}=${formatNum(value, def?.unit ?? "")}`);
        }
        text += theme.fg("dim", `  ${parts.join(" ")}`);
      }

      return new Text(text, 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // Ctrl+X — toggle dashboard expand/collapse
  // -----------------------------------------------------------------------

  pi.registerShortcut("ctrl+x", {
    description: "Toggle autoresearch dashboard",
    handler: async (ctx) => {
      const runtime = getRuntime(ctx);
      const state = runtime.state;
      if (state.results.length === 0) {
        if (!runtime.autoresearchMode && !fs.existsSync(getSessionPaths(ctx.cwd).mdPath)) {
          ctx.ui.notify("No experiments yet — run /autoresearch to get started", "info");
        } else {
          ctx.ui.notify("No experiments yet", "info");
        }
        return;
      }
      runtime.dashboardExpanded = !runtime.dashboardExpanded;
      updateWidget(ctx);
    },
  });

  // -----------------------------------------------------------------------
  // Ctrl+Shift+X — fullscreen scrollable dashboard overlay
  // -----------------------------------------------------------------------

  pi.registerShortcut("ctrl+shift+x", {
    description: "Fullscreen autoresearch dashboard",
    handler: async (ctx) => {
      const runtime = getRuntime(ctx);
      const state = runtime.state;
      if (state.results.length === 0) {
        ctx.ui.notify("No experiments yet", "info");
        return;
      }

      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          let scrollOffset = 0;
          // Store tui ref so run_experiment can trigger re-renders
          overlayTui = tui;

          // Start spinner interval for elapsed time animation
          spinnerInterval = setInterval(() => {
            spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
            if (runtime.runningExperiment) tui.requestRender();
          }, 80);

          function formatElapsed(ms: number): string {
            const s = Math.floor(ms / 1000);
            const m = Math.floor(s / 60);
            const sec = s % 60;
            return m > 0 ? `${m}m${String(sec).padStart(2, "0")}s` : `${sec}s`;
          }

          return {
            render(width: number): string[] {
              const termH = process.stdout.rows || 40;
              // Content gets the full width — no box borders
              const content = renderDashboardLines(state, runtime.orchestrator, width, theme, 0);

              // Add running experiment as next row in the list
              if (runtime.runningExperiment) {
                const elapsed = formatElapsed(Date.now() - runtime.runningExperiment.startedAt);
                const frame = SPINNER[spinnerFrame % SPINNER.length];
                const laneText = runtime.runningExperiment.laneId
                  ? ` [${runtime.runningExperiment.laneId}]`
                  : "";
                const nextIdx = state.results.length + 1;
                content.push(
                  truncateToWidth(
                    `  ${theme.fg("dim", String(nextIdx).padEnd(3))}` +
                    theme.fg("warning", `${frame} running… ${elapsed}${laneText}`),
                    width
                  )
                );
              }

              const totalRows = content.length;
              const viewportRows = Math.max(4, termH - 4); // leave room for header/footer

              // Clamp scroll
              const maxScroll = Math.max(0, totalRows - viewportRows);
              if (scrollOffset > maxScroll) scrollOffset = maxScroll;
              if (scrollOffset < 0) scrollOffset = 0;

              const out: string[] = [];

              // Header line
              const titlePrefix = "🔬 autoresearch";
              const nameStr = state.name ? `: ${state.name}` : "";
              const maxTitleLen = width - 6;
              let title = titlePrefix + nameStr;
              if (title.length > maxTitleLen) {
                title = title.slice(0, maxTitleLen - 1) + "…";
              }
              const fillLen = Math.max(0, width - 3 - 1 - title.length - 1);
              out.push(
                truncateToWidth(
                  theme.fg("borderMuted", "───") +
                  theme.fg("accent", " " + title + " ") +
                  theme.fg("borderMuted", "─".repeat(fillLen)),
                  width
                )
              );

              // Content rows
              const visible = content.slice(scrollOffset, scrollOffset + viewportRows);
              for (const line of visible) {
                out.push(truncateToWidth(line, width));
              }
              // Fill remaining viewport
              for (let i = visible.length; i < viewportRows; i++) {
                out.push("");
              }

              // Footer line
              const scrollInfo = totalRows > viewportRows
                ? ` ${scrollOffset + 1}-${Math.min(scrollOffset + viewportRows, totalRows)}/${totalRows}`
                : "";
              const helpText = ` ↑↓/j/k scroll • esc close${scrollInfo} `;
              const footFill = Math.max(0, width - helpText.length);
              out.push(
                truncateToWidth(
                  theme.fg("borderMuted", "─".repeat(footFill)) +
                  theme.fg("dim", helpText),
                  width
                )
              );

              return out;
            },

            handleInput(data: string): void {
              const termH = process.stdout.rows || 40;
              const viewportRows = Math.max(4, termH - 4);
              const totalRows = state.results.length + (runtime.runningExperiment ? 1 : 0) + 15; // rough estimate
              const maxScroll = Math.max(0, totalRows - viewportRows);

              if (matchesKey(data, "escape") || data === "q") {
                done(undefined);
                return;
              }
              if (matchesKey(data, "up") || data === "k") {
                scrollOffset = Math.max(0, scrollOffset - 1);
              } else if (matchesKey(data, "down") || data === "j") {
                scrollOffset = Math.min(maxScroll, scrollOffset + 1);
              } else if (matchesKey(data, "pageUp") || data === "u") {
                scrollOffset = Math.max(0, scrollOffset - viewportRows);
              } else if (matchesKey(data, "pageDown") || data === "d") {
                scrollOffset = Math.min(maxScroll, scrollOffset + viewportRows);
              } else if (data === "g") {
                scrollOffset = 0;
              } else if (data === "G") {
                scrollOffset = maxScroll;
              }
              tui.requestRender();
            },

            invalidate(): void {},

            dispose(): void {
              clearOverlay();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            width: "95%",
            maxHeight: "90%",
            anchor: "center" as const,
          },
        }
      );
    },
  });

  // -----------------------------------------------------------------------
  // /autoresearch command — enter autoresearch mode
  // -----------------------------------------------------------------------

  pi.registerCommand("autoresearch", {
    description: "Start, stop, clear, or resume autoresearch mode",
    handler: async (args, ctx) => {
      const runtime = getRuntime(ctx);
      const trimmedArgs = (args ?? "").trim();
      const command = trimmedArgs.toLowerCase();

      if (!trimmedArgs) {
        ctx.ui.notify(autoresearchHelp(), "info");
        return;
      }

      if (command === "off") {
        runtime.autoresearchMode = false;
        runtime.lastAutoResumeTime = 0;
        runtime.autoResumeTurns = 0;
        runtime.experimentsThisSession = 0;
        runtime.lastRunChecks = null;
        runtime.runningExperiment = null;
        ctx.ui.notify("Autoresearch mode OFF", "info");
        return;
      }

      if (command === "clear") {
        const paths = getSessionPaths(ctx.cwd);
        runtime.autoresearchMode = false;
        runtime.dashboardExpanded = false;
        runtime.lastAutoResumeTime = 0;
        runtime.autoResumeTurns = 0;
        runtime.experimentsThisSession = 0;
        runtime.lastRunChecks = null;
        runtime.runningExperiment = null;
        runtime.state = createExperimentState();
        runtime.orchestrator = null;
        runtime.settings = null;
        updateWidget(ctx);

        try {
          if (fs.existsSync(paths.jsonlPath)) fs.unlinkSync(paths.jsonlPath);
          if (fs.existsSync(paths.orchestratorPath)) fs.unlinkSync(paths.orchestratorPath);
          ctx.ui.notify("Cleared autoresearch state files and turned autoresearch mode OFF", "info");
        } catch (error) {
          ctx.ui.notify(
            `Failed to clear autoresearch state: ${error instanceof Error ? error.message : String(error)}`,
            "error"
          );
        }
        return;
      }

      runtime.autoresearchMode = true;
      runtime.autoResumeTurns = 0;

      const { paths } = loadSessionState(ctx);
      const hasRules = fs.existsSync(paths.mdPath);

      if (hasRules) {
        ctx.ui.notify("Autoresearch mode ON — rules loaded from autoresearch.md", "info");
        pi.sendUserMessage(`Autoresearch mode active. ${trimmedArgs} ${EVALUATION_GUARDRAIL}`);
      } else {
        ctx.ui.notify("Autoresearch mode ON — no autoresearch.md found, setting up", "info");
        pi.sendUserMessage(
          `Start autoresearch: ${trimmedArgs} ${EVALUATION_GUARDRAIL}`
        );
      }
    },
  });
}
