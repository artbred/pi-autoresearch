import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";

import {
  applyExperimentToOrchestrator,
  createExperimentState,
  createOrchestratorState,
  getRunBlockReason,
  resolveAutoresearchConfig,
  resolveWorkerBackend,
  restoreExperimentStateFromJsonl,
} from "../extensions/pi-autoresearch/orchestration.ts";

test("restoreExperimentStateFromJsonl keeps lane and candidate metadata", () => {
  const state = restoreExperimentStateFromJsonl(
    [
      JSON.stringify({
        type: "config",
        name: "demo session",
        metricName: "public_rank",
        metricUnit: "",
        bestDirection: "lower",
      }),
      JSON.stringify({
        commit: "abc1234",
        metric: 10,
        metrics: { public_score: 0.12, cv_score: 0.34 },
        status: "keep",
        description: "baseline",
        timestamp: 100,
        laneId: "exploit",
        strategyId: "lexical-v1",
        candidateId: "cand-1",
        actionType: "local_only",
        scoreState: "local_only",
        provisional: false,
        publicMetricsTimestamp: 90,
      }),
    ].join("\n")
  );

  assert.equal(state.name, "demo session");
  assert.equal(state.metricName, "public_rank");
  assert.equal(state.bestDirection, "lower");
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].laneId, "exploit");
  assert.equal(state.results[0].strategyId, "lexical-v1");
  assert.equal(state.results[0].candidateId, "cand-1");
  assert.equal(state.results[0].actionType, "local_only");
  assert.equal(state.results[0].scoreState, "local_only");
  assert.equal(state.results[0].publicMetricsTimestamp, 90);
  assert.deepEqual(
    state.secondaryMetrics.map((metric) => metric.name),
    ["public_score", "cv_score"]
  );
});

test("orchestrator forces a scored submission after repeated local keeps", () => {
  const cwd = path.resolve("/tmp", "pi-autoresearch-test");
  const settings = resolveAutoresearchConfig(cwd, {});
  const orchestrator = createOrchestratorState({
    workDir: settings.workingDir,
    stateDir: settings.stateDir,
    worktreeRoot: settings.parallelism.worktreeRoot,
    branchPrefix: "demo",
    settings,
    backend: resolveWorkerBackend("none", false),
  });

  for (let index = 1; index <= 3; index += 1) {
    applyExperimentToOrchestrator(orchestrator, {
      laneId: "exploit",
      strategyId: "exploit-v1",
      candidateId: `cand-${index}`,
      metric: 100 - index,
      metrics: { cv_score: 0.4 + index / 10 },
      status: "keep",
      description: `candidate ${index}`,
      timestamp: index * 1000,
      actionType: "local_only",
      scoreState: "local_only",
    });
  }

  assert.equal(orchestrator.policy.localKeepsWithoutScore, 3);
  assert.equal(orchestrator.policy.forcedSubmitRequired, true);
  assert.match(
    orchestrator.policy.forcedSubmitReason ?? "",
    /scored submission/i
  );
  assert.equal(
    getRunBlockReason(
      orchestrator,
      "./autoresearch.sh --local-only",
      "exploit",
      "exploit-v1"
    ) !== null,
    true
  );
  assert.equal(
    getRunBlockReason(
      orchestrator,
      "./autoresearch.sh --submit-candidate cand-3",
      "exploit",
      "exploit-v1"
    ),
    null
  );

  applyExperimentToOrchestrator(orchestrator, {
    laneId: "exploit",
    strategyId: "exploit-v1",
    candidateId: "cand-3",
    metric: 88,
    metrics: { cv_score: 0.73 },
    status: "keep",
    description: "fresh public score",
    timestamp: 5000,
    actionType: "submit",
    scoreState: "public_scored",
    publicMetricsTimestamp: 5000,
  });

  assert.equal(orchestrator.policy.forcedSubmitRequired, false);
  assert.equal(orchestrator.policy.localKeepsWithoutScore, 0);
});

test("pending Kaggle score work suppresses duplicate forced-submit pressure", () => {
  const cwd = path.resolve("/tmp", "pi-autoresearch-pending");
  const settings = resolveAutoresearchConfig(cwd, {});
  const orchestrator = createOrchestratorState({
    workDir: settings.workingDir,
    stateDir: settings.stateDir,
    worktreeRoot: settings.parallelism.worktreeRoot,
    branchPrefix: "demo",
    settings,
    backend: resolveWorkerBackend("none", false),
  });

  for (let index = 1; index <= 3; index += 1) {
    applyExperimentToOrchestrator(orchestrator, {
      laneId: "exploit",
      strategyId: "exploit-v1",
      candidateId: `cand-${index}`,
      metric: 100 - index,
      metrics: { cv_score: 0.4 + index / 10 },
      status: "keep",
      description: `candidate ${index}`,
      timestamp: index * 1000,
      actionType: "local_only",
      scoreState: "local_only",
    });
  }

  assert.equal(orchestrator.policy.forcedSubmitRequired, true);

  applyExperimentToOrchestrator(orchestrator, {
    laneId: "exploit",
    strategyId: "exploit-v1",
    candidateId: "cand-3",
    metric: 97,
    metrics: { cv_score: 0.73 },
    status: "keep",
    description: "submitted and pending",
    timestamp: 5000,
    actionType: "submit_notebook",
    scoreState: "notebook_run_running",
  });

  assert.equal(orchestrator.activeScoreCandidateId, "cand-3");
  assert.equal(orchestrator.policy.forcedSubmitRequired, false);
  assert.equal(
    getRunBlockReason(
      orchestrator,
      "./autoresearch.sh --local-only",
      "explore",
      "alt-hypothesis"
    ),
    null
  );

  applyExperimentToOrchestrator(orchestrator, {
    laneId: "exploit",
    strategyId: "exploit-v1",
    candidateId: "cand-3",
    metric: 96,
    metrics: { cv_score: 0.73 },
    status: "keep",
    description: "still pending after refresh",
    timestamp: 6000,
    actionType: "refresh_score",
    scoreState: "score_pending",
  });

  assert.equal(orchestrator.policy.lastFreshPublicScoreAt, null);
  assert.equal(orchestrator.activeScoreCandidateId, "cand-3");

  applyExperimentToOrchestrator(orchestrator, {
    laneId: "exploit",
    strategyId: "exploit-v1",
    candidateId: "cand-3",
    metric: 95,
    metrics: { cv_score: 0.73, public_score: 0.55 },
    status: "keep",
    description: "public score landed",
    timestamp: 7000,
    actionType: "refresh_score",
    scoreState: "public_scored",
    publicMetricsTimestamp: 7000,
  });

  assert.equal(orchestrator.activeScoreCandidateId, null);
  assert.equal(orchestrator.policy.forcedSubmitRequired, false);
  assert.equal(orchestrator.policy.lastFreshPublicScoreAt, 7000);
});

test("orchestrator forces lane rotation after repeated non-improving runs", () => {
  const state = createExperimentState();
  const settings = resolveAutoresearchConfig(path.resolve("/tmp", "lanes"), {});
  const orchestrator = createOrchestratorState({
    workDir: settings.workingDir,
    stateDir: settings.stateDir,
    worktreeRoot: settings.parallelism.worktreeRoot,
    branchPrefix: "demo",
    settings,
    backend: resolveWorkerBackend("none", false),
  });

  applyExperimentToOrchestrator(orchestrator, {
    laneId: "explore",
    strategyId: "alt-hypothesis",
    metric: 10,
    metrics: {},
    status: "discard",
    description: "miss 1",
    timestamp: 1000,
  });
  applyExperimentToOrchestrator(orchestrator, {
    laneId: "explore",
    strategyId: "alt-hypothesis",
    metric: 11,
    metrics: {},
    status: "discard",
    description: "miss 2",
    timestamp: 2000,
  });

  assert.equal(state.results.length, 0);
  assert.equal(orchestrator.lanes.explore.status, "yield_required");
  assert.match(
    getRunBlockReason(
      orchestrator,
      "./autoresearch.sh --local-only",
      "explore",
      "alt-hypothesis"
    ) ?? "",
    /rotate/i
  );
  assert.equal(
    getRunBlockReason(
      orchestrator,
      "./autoresearch.sh --local-only",
      "explore",
      "fresh-hypothesis"
    ),
    null
  );
});
