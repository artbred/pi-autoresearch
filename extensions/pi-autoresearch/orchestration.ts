import * as path from "node:path";

export type ExperimentStatus = "keep" | "discard" | "crash" | "checks_failed";
export type ActionType =
  | "experiment"
  | "baseline"
  | "local_only"
  | "submit"
  | "submit_notebook"
  | "request_score"
  | "refresh_score"
  | "merge"
  | "promote"
  | "refresh";
export type ScoreState =
  | "unknown"
  | "local_only"
  | "pending_submission"
  | "notebook_run_submitted"
  | "notebook_run_running"
  | "notebook_run_complete"
  | "score_request_submitted"
  | "score_pending"
  | "score_failed"
  | "public_scored"
  | "provisional"
  | "quota_exhausted";
export type WorkerBackend = "auto" | "pi_cli" | "none";
export type ResolvedWorkerBackend = "pi_cli" | "none";
export type LaneKind = "exploit" | "explore" | "merge";
export type LaneStatus =
  | "idle"
  | "running"
  | "ready"
  | "yield_required"
  | "blocked"
  | "degraded";

export interface ExperimentResult {
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: ExperimentStatus;
  description: string;
  timestamp: number;
  segment: number;
  laneId?: string;
  strategyId?: string;
  candidateId?: string;
  actionType?: ActionType;
  scoreState?: ScoreState;
  provisional?: boolean;
  publicMetricsTimestamp?: number | null;
}

export interface MetricDef {
  name: string;
  unit: string;
}

export interface ExperimentState {
  results: ExperimentResult[];
  bestMetric: number | null;
  bestDirection: "lower" | "higher";
  metricName: string;
  metricUnit: string;
  secondaryMetrics: MetricDef[];
  name: string | null;
  currentSegment: number;
  maxExperiments: number | null;
}

export interface ParallelismConfig {
  enabled: boolean;
  maxWorkers: number;
  workerBackend: WorkerBackend;
  worktreeRoot: string;
}

export interface PolicyConfig {
  maxLocalKeepsWithoutScore: number;
  maxMinutesWithoutFreshScore: number;
  maxNonImprovingRunsPerLane: number;
}

export interface AutoresearchConfig {
  maxIterations?: number;
  workingDir?: string;
  stateDir?: string;
  parallelism?: Partial<ParallelismConfig>;
  policy?: Partial<PolicyConfig>;
}

export interface ResolvedAutoresearchConfig {
  maxIterations: number | null;
  workingDir: string;
  stateDir: string;
  parallelism: ParallelismConfig;
  policy: PolicyConfig;
}

export interface WorkerBackendStatus {
  configured: WorkerBackend;
  resolved: ResolvedWorkerBackend;
  available: boolean;
  degradedReason: string | null;
}

export interface LaneState {
  id: string;
  kind: LaneKind;
  status: LaneStatus;
  branchName: string;
  worktreePath: string;
  notesPath: string;
  currentStrategyId: string | null;
  currentCandidateId: string | null;
  readyCandidateIds: string[];
  consecutiveNonImprovingRuns: number;
  lastRunAt: number | null;
  lastKeepAt: number | null;
  lastScoreAt: number | null;
  lastResultStatus: ExperimentStatus | null;
  yieldReason: string | null;
}

export interface CandidateRecord {
  candidateId: string;
  laneId: string | null;
  strategyId: string | null;
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  description: string;
  status:
    | "ready"
    | "pending_submission"
    | "pending_score"
    | "public_scored"
    | "merged"
    | "discarded";
  scoreState: ScoreState;
  provisional: boolean;
  createdAt: number;
  updatedAt: number;
  publicMetricsTimestamp: number | null;
  artifactDir: string | null;
  artifactPaths: string[];
  lineage: string[];
}

export interface OrchestratorPolicyState {
  maxLocalKeepsWithoutScore: number;
  maxMinutesWithoutFreshScore: number;
  maxNonImprovingRunsPerLane: number;
  localKeepsWithoutScore: number;
  lastFreshPublicScoreAt: number | null;
  forcedSubmitRequired: boolean;
  forcedSubmitReason: string | null;
  quotaBlocked: boolean;
}

export interface OrchestratorState {
  version: 1;
  workDir: string;
  stateDir: string;
  worktreeRoot: string;
  backend: WorkerBackendStatus;
  policy: OrchestratorPolicyState;
  lanes: Record<string, LaneState>;
  candidates: Record<string, CandidateRecord>;
  pendingSubmissionQueue: string[];
  activeScoreCandidateId: string | null;
  updatedAt: number;
}

export interface OrchestratorRecordInput {
  laneId?: string;
  strategyId?: string;
  candidateId?: string;
  metric: number;
  metrics?: Record<string, number>;
  status: ExperimentStatus;
  description: string;
  timestamp?: number;
  commit?: string;
  actionType?: ActionType;
  scoreState?: ScoreState;
  provisional?: boolean;
  publicMetricsTimestamp?: number | null;
  artifactDir?: string | null;
  artifactPaths?: string[];
  lineage?: string[];
}

export interface LaneRunInput {
  laneId: string;
  strategyId?: string;
  candidateId?: string;
  timestamp?: number;
}

const DEFAULT_PARALLEL_WORKTREE_ROOT = ".autoresearch/worktrees";

export function metricUnitFromName(name: string): string {
  if (name.endsWith("µs")) return "µs";
  if (name.endsWith("_ms")) return "ms";
  if (name.endsWith("_s") || name.endsWith("_sec")) return "s";
  if (name.endsWith("_kb")) return "kb";
  if (name.endsWith("_mb")) return "mb";
  return "";
}

export function createExperimentState(): ExperimentState {
  return {
    results: [],
    bestMetric: null,
    bestDirection: "lower",
    metricName: "metric",
    metricUnit: "",
    secondaryMetrics: [],
    name: null,
    currentSegment: 0,
    maxExperiments: null,
  };
}

export function cloneExperimentState(state: ExperimentState): ExperimentState {
  return {
    ...state,
    results: state.results.map((result) => ({
      ...result,
      metrics: { ...result.metrics },
    })),
    secondaryMetrics: state.secondaryMetrics.map((metric) => ({ ...metric })),
  };
}

export function currentResults(
  results: ExperimentResult[],
  segment: number
): ExperimentResult[] {
  return results.filter((result) => result.segment === segment);
}

export function findBaselineMetric(
  results: ExperimentResult[],
  segment: number
): number | null {
  const cur = currentResults(results, segment);
  return cur.length > 0 ? cur[0].metric : null;
}

export function findBaselineRunNumber(
  results: ExperimentResult[],
  segment: number
): number | null {
  const index = results.findIndex((result) => result.segment === segment);
  return index >= 0 ? index + 1 : null;
}

export function findBaselineSecondary(
  results: ExperimentResult[],
  segment: number,
  knownMetrics?: MetricDef[]
): Record<string, number> {
  const cur = currentResults(results, segment);
  const baseline = cur.length > 0 ? { ...(cur[0].metrics ?? {}) } : {};
  if (knownMetrics) {
    for (const metric of knownMetrics) {
      if (baseline[metric.name] !== undefined) continue;
      for (const result of cur) {
        const value = (result.metrics ?? {})[metric.name];
        if (value !== undefined) {
          baseline[metric.name] = value;
          break;
        }
      }
    }
  }
  return baseline;
}

export function restoreExperimentStateFromJsonl(jsonlText: string): ExperimentState {
  const state = createExperimentState();
  let segment = 0;
  for (const line of jsonlText.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "config") {
      if (typeof entry.name === "string") state.name = entry.name;
      if (typeof entry.metricName === "string") state.metricName = entry.metricName;
      if (typeof entry.metricUnit === "string") state.metricUnit = entry.metricUnit;
      if (entry.bestDirection === "lower" || entry.bestDirection === "higher") {
        state.bestDirection = entry.bestDirection;
      }
      if (state.results.length > 0) segment += 1;
      state.currentSegment = segment;
      continue;
    }

    const metrics =
      entry.metrics && typeof entry.metrics === "object"
        ? Object.fromEntries(
            Object.entries(entry.metrics).filter(
              ([, value]) => typeof value === "number"
            )
          )
        : {};

    const result: ExperimentResult = {
      commit: typeof entry.commit === "string" ? entry.commit : "",
      metric: typeof entry.metric === "number" ? entry.metric : 0,
      metrics,
      status:
        entry.status === "discard" ||
        entry.status === "crash" ||
        entry.status === "checks_failed"
          ? entry.status
          : "keep",
      description: typeof entry.description === "string" ? entry.description : "",
      timestamp: typeof entry.timestamp === "number" ? entry.timestamp : 0,
      segment,
      laneId: typeof entry.laneId === "string" ? entry.laneId : undefined,
      strategyId: typeof entry.strategyId === "string" ? entry.strategyId : undefined,
      candidateId: typeof entry.candidateId === "string" ? entry.candidateId : undefined,
      actionType: isActionType(entry.actionType) ? entry.actionType : undefined,
      scoreState: isScoreState(entry.scoreState) ? entry.scoreState : undefined,
      provisional: typeof entry.provisional === "boolean" ? entry.provisional : undefined,
      publicMetricsTimestamp:
        typeof entry.publicMetricsTimestamp === "number"
          ? entry.publicMetricsTimestamp
          : null,
    };
    state.results.push(result);

    for (const name of Object.keys(metrics)) {
      if (!state.secondaryMetrics.find((metric) => metric.name === name)) {
        state.secondaryMetrics.push({ name, unit: metricUnitFromName(name) });
      }
    }
  }

  state.bestMetric = findBaselineMetric(state.results, state.currentSegment);
  return state;
}

export function resolveAutoresearchConfig(
  ctxCwd: string,
  raw: AutoresearchConfig = {}
): ResolvedAutoresearchConfig {
  const workingDir = raw.workingDir
    ? path.resolve(ctxCwd, raw.workingDir)
    : ctxCwd;
  const stateDir = raw.stateDir ? path.resolve(ctxCwd, raw.stateDir) : workingDir;
  const maxIterations =
    typeof raw.maxIterations === "number" && raw.maxIterations > 0
      ? Math.floor(raw.maxIterations)
      : null;

  const parallelism: ParallelismConfig = {
    enabled: raw.parallelism?.enabled ?? true,
    maxWorkers:
      typeof raw.parallelism?.maxWorkers === "number" && raw.parallelism.maxWorkers > 0
        ? Math.floor(raw.parallelism.maxWorkers)
        : 2,
    workerBackend: isWorkerBackend(raw.parallelism?.workerBackend)
      ? raw.parallelism.workerBackend
      : "auto",
    worktreeRoot: path.resolve(
      stateDir,
      raw.parallelism?.worktreeRoot ?? DEFAULT_PARALLEL_WORKTREE_ROOT
    ),
  };

  const policy: PolicyConfig = {
    maxLocalKeepsWithoutScore:
      typeof raw.policy?.maxLocalKeepsWithoutScore === "number" &&
      raw.policy.maxLocalKeepsWithoutScore > 0
        ? Math.floor(raw.policy.maxLocalKeepsWithoutScore)
        : 3,
    maxMinutesWithoutFreshScore:
      typeof raw.policy?.maxMinutesWithoutFreshScore === "number" &&
      raw.policy.maxMinutesWithoutFreshScore > 0
        ? Math.floor(raw.policy.maxMinutesWithoutFreshScore)
        : 90,
    maxNonImprovingRunsPerLane:
      typeof raw.policy?.maxNonImprovingRunsPerLane === "number" &&
      raw.policy.maxNonImprovingRunsPerLane > 0
        ? Math.floor(raw.policy.maxNonImprovingRunsPerLane)
        : 2,
  };

  return {
    maxIterations,
    workingDir,
    stateDir,
    parallelism,
    policy,
  };
}

export function resolveWorkerBackend(
  configured: WorkerBackend,
  piCliAvailable: boolean
): WorkerBackendStatus {
  if (configured === "none") {
    return {
      configured,
      resolved: "none",
      available: false,
      degradedReason: "Parallel worker backend disabled by config.",
    };
  }
  if (piCliAvailable) {
    return {
      configured,
      resolved: "pi_cli",
      available: true,
      degradedReason: null,
    };
  }
  return {
    configured,
    resolved: "none",
    available: false,
    degradedReason:
      configured === "pi_cli"
        ? "Configured pi_cli backend, but `pi` is not available on PATH."
        : "Parallelism is enabled, but `pi` is not available on PATH. Falling back to coordinator-only mode.",
  };
}

export function buildBranchPrefix(
  name: string | null,
  workDir: string
): string {
  const raw = name || path.basename(workDir) || "session";
  const sanitized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return sanitized || "session";
}

export function createOrchestratorState(args: {
  workDir: string;
  stateDir: string;
  worktreeRoot: string;
  branchPrefix: string;
  settings: ResolvedAutoresearchConfig;
  backend: WorkerBackendStatus;
  existing?: Partial<OrchestratorState> | null;
}): OrchestratorState {
  const existing = args.existing ?? {};
  const candidates = normalizeCandidates(existing.candidates);
  const lanes = normalizeLanes(
    existing.lanes,
    args.worktreeRoot,
    args.stateDir,
    args.branchPrefix,
    args.backend
  );
  return {
    version: 1,
    workDir: args.workDir,
    stateDir: args.stateDir,
    worktreeRoot: args.worktreeRoot,
    backend: { ...args.backend },
    policy: {
      maxLocalKeepsWithoutScore: args.settings.policy.maxLocalKeepsWithoutScore,
      maxMinutesWithoutFreshScore: args.settings.policy.maxMinutesWithoutFreshScore,
      maxNonImprovingRunsPerLane: args.settings.policy.maxNonImprovingRunsPerLane,
      localKeepsWithoutScore:
        typeof existing.policy?.localKeepsWithoutScore === "number"
          ? existing.policy.localKeepsWithoutScore
          : 0,
      lastFreshPublicScoreAt:
        typeof existing.policy?.lastFreshPublicScoreAt === "number"
          ? existing.policy.lastFreshPublicScoreAt
          : null,
      forcedSubmitRequired: !!existing.policy?.forcedSubmitRequired,
      forcedSubmitReason:
        typeof existing.policy?.forcedSubmitReason === "string"
          ? existing.policy.forcedSubmitReason
          : null,
      quotaBlocked: !!existing.policy?.quotaBlocked,
    },
    lanes,
    candidates,
    pendingSubmissionQueue: Array.isArray(existing.pendingSubmissionQueue)
      ? existing.pendingSubmissionQueue.filter((entry): entry is string => typeof entry === "string")
      : [],
    activeScoreCandidateId:
      typeof existing.activeScoreCandidateId === "string"
        ? existing.activeScoreCandidateId
        : resolveActiveScoreCandidateId(candidates),
    updatedAt:
      typeof existing.updatedAt === "number" ? existing.updatedAt : Date.now(),
  };
}

export function markLaneRunning(
  orchestrator: OrchestratorState,
  input: LaneRunInput
): OrchestratorState {
  const lane = input.laneId ? orchestrator.lanes[input.laneId] : undefined;
  const timestamp = input.timestamp ?? Date.now();
  if (!lane) {
    orchestrator.updatedAt = timestamp;
    return orchestrator;
  }
  lane.status = orchestrator.backend.available ? "running" : "degraded";
  lane.currentStrategyId = input.strategyId ?? lane.currentStrategyId;
  lane.currentCandidateId = input.candidateId ?? lane.currentCandidateId;
  lane.lastRunAt = timestamp;
  orchestrator.updatedAt = timestamp;
  return orchestrator;
}

export function clearLaneRunning(
  orchestrator: OrchestratorState,
  laneId?: string,
  timestamp: number = Date.now()
): OrchestratorState {
  if (!laneId) {
    orchestrator.updatedAt = timestamp;
    return orchestrator;
  }
  const lane = orchestrator.lanes[laneId];
  if (!lane) {
    orchestrator.updatedAt = timestamp;
    return orchestrator;
  }
  if (lane.status === "running") {
    lane.status = lane.readyCandidateIds.length > 0 ? "ready" : idleStatus(orchestrator);
  }
  lane.lastRunAt = timestamp;
  orchestrator.updatedAt = timestamp;
  return orchestrator;
}

export function applyExperimentToOrchestrator(
  orchestrator: OrchestratorState,
  input: OrchestratorRecordInput
): OrchestratorState {
  const timestamp = input.timestamp ?? Date.now();
  const lane = input.laneId ? orchestrator.lanes[input.laneId] : undefined;
  const scoreState = input.scoreState ?? "unknown";
  const actionType = input.actionType ?? "experiment";
  const provisional = !!input.provisional;

  if (lane) {
    lane.lastRunAt = timestamp;
    lane.lastResultStatus = input.status;
    lane.currentStrategyId = input.strategyId ?? lane.currentStrategyId;
    lane.currentCandidateId = input.candidateId ?? lane.currentCandidateId;
    if (input.status === "keep") {
      lane.consecutiveNonImprovingRuns = 0;
      lane.lastKeepAt = timestamp;
      lane.status =
        input.candidateId && isQueueEligibleScoreState(scoreState)
          ? "ready"
          : idleStatus(orchestrator);
      lane.yieldReason = null;
    } else {
      lane.consecutiveNonImprovingRuns += 1;
      lane.status =
        lane.consecutiveNonImprovingRuns >=
        orchestrator.policy.maxNonImprovingRunsPerLane
          ? "yield_required"
          : idleStatus(orchestrator);
      lane.yieldReason =
        lane.status === "yield_required"
          ? `Rotate lane after ${orchestrator.policy.maxNonImprovingRunsPerLane} non-improving runs.`
          : null;
    }
    if (
      scoreState === "public_scored" &&
      (input.publicMetricsTimestamp ?? timestamp) > 0
    ) {
      lane.lastScoreAt = input.publicMetricsTimestamp ?? timestamp;
    }
  }

  if (scoreState === "quota_exhausted") {
    orchestrator.policy.quotaBlocked = true;
  } else if (scoreState !== "unknown") {
    orchestrator.policy.quotaBlocked = false;
  }

  if (scoreState === "public_scored") {
    orchestrator.policy.lastFreshPublicScoreAt =
      input.publicMetricsTimestamp ?? timestamp;
    orchestrator.policy.localKeepsWithoutScore = 0;
    orchestrator.policy.forcedSubmitRequired = false;
    orchestrator.policy.forcedSubmitReason = null;
  } else if (input.status === "keep" && isLocalOnlyScoreState(scoreState)) {
    orchestrator.policy.localKeepsWithoutScore += 1;
  }

  if (input.candidateId) {
    const existing = orchestrator.candidates[input.candidateId];
    const createdAt = existing?.createdAt ?? timestamp;
    const next: CandidateRecord = {
      candidateId: input.candidateId,
      laneId: input.laneId ?? existing?.laneId ?? null,
      strategyId: input.strategyId ?? existing?.strategyId ?? null,
      commit: input.commit ?? existing?.commit ?? "",
      metric: input.metric,
      metrics: { ...(input.metrics ?? existing?.metrics ?? {}) },
      description: input.description,
      status: resolveCandidateStatus(input.status, scoreState, actionType),
      scoreState,
      provisional,
      createdAt,
      updatedAt: timestamp,
      publicMetricsTimestamp:
        input.publicMetricsTimestamp ??
        existing?.publicMetricsTimestamp ??
        null,
      artifactDir: input.artifactDir ?? existing?.artifactDir ?? null,
      artifactPaths: dedupeStrings([
        ...(existing?.artifactPaths ?? []),
        ...(input.artifactPaths ?? []),
      ]),
      lineage: dedupeStrings([
        ...(existing?.lineage ?? []),
        ...(input.lineage ?? []),
      ]),
    };
    orchestrator.candidates[input.candidateId] = next;
    if (isPendingScoreState(scoreState)) {
      orchestrator.activeScoreCandidateId = next.candidateId;
    } else if (orchestrator.activeScoreCandidateId === next.candidateId) {
      orchestrator.activeScoreCandidateId = null;
    }
    updatePendingQueue(orchestrator, next);
    if (lane) {
      lane.currentCandidateId = next.candidateId;
      if (
        next.status === "ready" ||
        next.status === "pending_submission" ||
        next.status === "merged"
      ) {
        lane.readyCandidateIds = dedupeStrings([
          ...lane.readyCandidateIds,
          next.candidateId,
        ]);
      } else {
        lane.readyCandidateIds = lane.readyCandidateIds.filter(
          (candidateId) => candidateId !== next.candidateId
        );
      }
    }
  }

  refreshForcedSubmitPolicy(orchestrator, timestamp);
  orchestrator.updatedAt = timestamp;
  return orchestrator;
}

export function getRunBlockReason(
  orchestrator: OrchestratorState,
  command: string,
  laneId?: string,
  strategyId?: string
): string | null {
  if (
    orchestrator.policy.forcedSubmitRequired &&
    !orchestrator.policy.quotaBlocked &&
    !looksLikeSubmissionCommand(command)
  ) {
    return (
      orchestrator.policy.forcedSubmitReason ??
      "A fresh public score is required before more local-only work."
    );
  }

  if (!laneId) return null;
  const lane = orchestrator.lanes[laneId];
  if (!lane) return null;

  if (
    lane.status === "yield_required" &&
    (!strategyId || strategyId === lane.currentStrategyId)
  ) {
    return (
      lane.yieldReason ??
      `Lane ${laneId} must rotate to a new strategy before running again.`
    );
  }

  return null;
}

export function looksLikeSubmissionCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    normalized.includes("--submit") ||
    normalized.includes("submit-candidate") ||
    normalized.includes("competitions submit") ||
    normalized.includes("submit_notebook") ||
    normalized.includes("request-score") ||
    normalized.includes("leaderboard") ||
    normalized.includes("score refresh") ||
    normalized.includes("refresh-score")
  );
}

function normalizeLanes(
  existing: Record<string, LaneState> | undefined,
  worktreeRoot: string,
  stateDir: string,
  branchPrefix: string,
  backend: WorkerBackendStatus
): Record<string, LaneState> {
  const definitions: Array<{ id: string; kind: LaneKind }> = [
    { id: "exploit", kind: "exploit" },
    { id: "explore", kind: "explore" },
    { id: "merge", kind: "merge" },
  ];
  const lanes: Record<string, LaneState> = {};
  for (const definition of definitions) {
    const current = existing?.[definition.id];
    lanes[definition.id] = {
      id: definition.id,
      kind: definition.kind,
      status:
        current?.status && isLaneStatus(current.status)
          ? current.status
          : idleStatusFromBackend(backend),
      branchName:
        typeof current?.branchName === "string" && current.branchName
          ? current.branchName
          : `autoresearch/${branchPrefix}-${definition.id}`,
      worktreePath:
        typeof current?.worktreePath === "string" && current.worktreePath
          ? current.worktreePath
          : path.join(worktreeRoot, definition.id),
      notesPath:
        typeof current?.notesPath === "string" && current.notesPath
          ? current.notesPath
          : path.join(stateDir, "lanes", definition.id, "notes.md"),
      currentStrategyId:
        typeof current?.currentStrategyId === "string"
          ? current.currentStrategyId
          : null,
      currentCandidateId:
        typeof current?.currentCandidateId === "string"
          ? current.currentCandidateId
          : null,
      readyCandidateIds: Array.isArray(current?.readyCandidateIds)
        ? current.readyCandidateIds.filter(
            (entry): entry is string => typeof entry === "string"
          )
        : [],
      consecutiveNonImprovingRuns:
        typeof current?.consecutiveNonImprovingRuns === "number"
          ? current.consecutiveNonImprovingRuns
          : 0,
      lastRunAt:
        typeof current?.lastRunAt === "number" ? current.lastRunAt : null,
      lastKeepAt:
        typeof current?.lastKeepAt === "number" ? current.lastKeepAt : null,
      lastScoreAt:
        typeof current?.lastScoreAt === "number" ? current.lastScoreAt : null,
      lastResultStatus:
        current?.lastResultStatus && isExperimentStatus(current.lastResultStatus)
          ? current.lastResultStatus
          : null,
      yieldReason:
        typeof current?.yieldReason === "string" ? current.yieldReason : null,
    };
  }
  return lanes;
}

function normalizeCandidates(
  candidates: Record<string, CandidateRecord> | undefined
): Record<string, CandidateRecord> {
  if (!candidates) return {};
  const normalized: Record<string, CandidateRecord> = {};
  for (const [candidateId, value] of Object.entries(candidates)) {
    normalized[candidateId] = {
      candidateId,
      laneId: value.laneId ?? null,
      strategyId: value.strategyId ?? null,
      commit: value.commit ?? "",
      metric: typeof value.metric === "number" ? value.metric : 0,
      metrics: { ...(value.metrics ?? {}) },
      description: value.description ?? "",
      status:
        value.status === "discarded" ||
        value.status === "pending_submission" ||
        value.status === "pending_score" ||
        value.status === "public_scored" ||
        value.status === "merged"
          ? value.status
          : "ready",
      scoreState: isScoreState(value.scoreState) ? value.scoreState : "unknown",
      provisional: !!value.provisional,
      createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
      publicMetricsTimestamp:
        typeof value.publicMetricsTimestamp === "number"
          ? value.publicMetricsTimestamp
          : null,
      artifactDir: value.artifactDir ?? null,
      artifactPaths: Array.isArray(value.artifactPaths)
        ? value.artifactPaths.filter((entry): entry is string => typeof entry === "string")
        : [],
      lineage: Array.isArray(value.lineage)
        ? value.lineage.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  }
  return normalized;
}

function resolveActiveScoreCandidateId(
  candidates: Record<string, CandidateRecord>
): string | null {
  let newest: CandidateRecord | null = null;
  for (const candidate of Object.values(candidates)) {
    if (!isPendingScoreState(candidate.scoreState)) continue;
    if (!newest || candidate.updatedAt > newest.updatedAt) {
      newest = candidate;
    }
  }
  return newest?.candidateId ?? null;
}

function updatePendingQueue(
  orchestrator: OrchestratorState,
  candidate: CandidateRecord
): void {
  const isPending =
    candidate.status === "ready" ||
    candidate.status === "pending_submission" ||
    candidate.status === "merged";
  if (isPending) {
    orchestrator.pendingSubmissionQueue = dedupeStrings([
      ...orchestrator.pendingSubmissionQueue,
      candidate.candidateId,
    ]);
    return;
  }
  orchestrator.pendingSubmissionQueue = orchestrator.pendingSubmissionQueue.filter(
    (entry) => entry !== candidate.candidateId
  );
}

function refreshForcedSubmitPolicy(
  orchestrator: OrchestratorState,
  timestamp: number
): void {
  const hasQueuedCandidate = orchestrator.pendingSubmissionQueue.length > 0;
  const hasScoreInFlight = orchestrator.activeScoreCandidateId !== null;
  const thresholdExceeded =
    orchestrator.policy.localKeepsWithoutScore >=
    orchestrator.policy.maxLocalKeepsWithoutScore;
  const timeExceeded =
    orchestrator.policy.lastFreshPublicScoreAt !== null &&
    timestamp - orchestrator.policy.lastFreshPublicScoreAt >=
      orchestrator.policy.maxMinutesWithoutFreshScore * 60 * 1000;

  if (
    !orchestrator.policy.quotaBlocked &&
    !hasScoreInFlight &&
    hasQueuedCandidate &&
    (thresholdExceeded || timeExceeded)
  ) {
    orchestrator.policy.forcedSubmitRequired = true;
    orchestrator.policy.forcedSubmitReason =
      `A scored submission is required now. Best queued candidate: ${orchestrator.pendingSubmissionQueue[0]}.`;
    return;
  }

  orchestrator.policy.forcedSubmitRequired = false;
  orchestrator.policy.forcedSubmitReason = null;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function resolveCandidateStatus(
  experimentStatus: ExperimentStatus,
  scoreState: ScoreState,
  actionType: ActionType
): CandidateRecord["status"] {
  if (experimentStatus !== "keep") return "discarded";
  if (scoreState === "public_scored") return "public_scored";
  if (scoreState === "quota_exhausted") return "pending_submission";
  if (isPendingScoreState(scoreState)) return "pending_score";
  if (actionType === "merge") return "merged";
  return "ready";
}

function idleStatus(orchestrator: OrchestratorState): LaneStatus {
  return idleStatusFromBackend(orchestrator.backend);
}

function idleStatusFromBackend(backend: WorkerBackendStatus): LaneStatus {
  return backend.available ? "idle" : "degraded";
}

function isLocalOnlyScoreState(scoreState: ScoreState): boolean {
  return (
    scoreState === "local_only" ||
    scoreState === "pending_submission" ||
    scoreState === "provisional" ||
    scoreState === "quota_exhausted"
  );
}

function isPendingScoreState(scoreState: ScoreState): boolean {
  return (
    scoreState === "notebook_run_submitted" ||
    scoreState === "notebook_run_running" ||
    scoreState === "notebook_run_complete" ||
    scoreState === "score_request_submitted" ||
    scoreState === "score_pending"
  );
}

function isQueueEligibleScoreState(scoreState: ScoreState): boolean {
  return !isPendingScoreState(scoreState) && scoreState !== "score_failed";
}

function isLaneStatus(value: unknown): value is LaneStatus {
  return (
    value === "idle" ||
    value === "running" ||
    value === "ready" ||
    value === "yield_required" ||
    value === "blocked" ||
    value === "degraded"
  );
}

function isExperimentStatus(value: unknown): value is ExperimentStatus {
  return (
    value === "keep" ||
    value === "discard" ||
    value === "crash" ||
    value === "checks_failed"
  );
}

function isActionType(value: unknown): value is ActionType {
  return (
    value === "experiment" ||
    value === "baseline" ||
    value === "local_only" ||
    value === "submit" ||
    value === "submit_notebook" ||
    value === "request_score" ||
    value === "refresh_score" ||
    value === "merge" ||
    value === "promote" ||
    value === "refresh"
  );
}

function isScoreState(value: unknown): value is ScoreState {
  return (
    value === "unknown" ||
    value === "local_only" ||
    value === "pending_submission" ||
    value === "notebook_run_submitted" ||
    value === "notebook_run_running" ||
    value === "notebook_run_complete" ||
    value === "score_request_submitted" ||
    value === "score_pending" ||
    value === "score_failed" ||
    value === "public_scored" ||
    value === "provisional" ||
    value === "quota_exhausted"
  );
}

function isWorkerBackend(value: unknown): value is WorkerBackend {
  return value === "auto" || value === "pi_cli" || value === "none";
}
