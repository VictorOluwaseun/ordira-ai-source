import { registerAs } from '@nestjs/config';
import { getEnvConfig } from './env.schema';

export const customerAiConfig = registerAs('customerAi', () => {
  const env = getEnvConfig();

  return {
    // Discovery orchestration supports off/shadow. The bounded live classifier
    // has its own flag; enabling it does not promote or enable shadow execution.
    mode: env.CUSTOMER_AI_MODE,
    interpreterEnabled: env.CUSTOMER_AI_INTERPRETER_ENABLED,
    rolloutPercent: env.CUSTOMER_AI_ROLLOUT_PERCENT,
    // Provider identity is snapshotted onto every run for reproducibility.
    provider: env.CUSTOMER_AI_PROVIDER,
    model: env.CUSTOMER_AI_MODEL,
    reasoningEffort: env.CUSTOMER_AI_REASONING_EFFORT,
    // Execution budgets for orchestration. The live classifier makes one call
    // capped by the smaller timeout/deadline; that cap excludes Redis/DB time.
    apiTimeoutMs: env.CUSTOMER_AI_API_TIMEOUT_MS,
    turnDeadlineMs: env.CUSTOMER_AI_TURN_DEADLINE_MS,
    maxProviderCalls: env.CUSTOMER_AI_MAX_PROVIDER_CALLS_PER_TURN,
    maxToolCalls: env.CUSTOMER_AI_MAX_TOOL_CALLS_PER_TURN,
    maxOutputTokens: env.CUSTOMER_AI_MAX_OUTPUT_TOKENS,
    maxContextMessages: env.CUSTOMER_AI_MAX_CONTEXT_MESSAGES,
    // Dedicated queue and stale-run recovery controls.
    queueEnabled: env.CUSTOMER_AI_QUEUE_ENABLED,
    queueConcurrency: env.CUSTOMER_AI_QUEUE_CONCURRENCY,
    sweepIntervalMs: env.CUSTOMER_AI_SWEEP_INTERVAL_MS,
    sweepBatchSize: env.CUSTOMER_AI_SWEEP_BATCH_SIZE,
    recoveryStaleAfterMs: env.CUSTOMER_AI_RECOVERY_STALE_AFTER_MS,
    removeOnCompleteCount: env.CUSTOMER_AI_REMOVE_ON_COMPLETE_COUNT,
    removeOnFailCount: env.CUSTOMER_AI_REMOVE_ON_FAIL_COUNT,
    // Redis-backed rolling provider circuit-breaker thresholds.
    breakerMinRequests: env.CUSTOMER_AI_PROVIDER_BREAKER_MIN_REQUESTS,
    breakerFailurePercent: env.CUSTOMER_AI_PROVIDER_BREAKER_FAILURE_PERCENT,
    breakerOpenMs: env.CUSTOMER_AI_PROVIDER_BREAKER_OPEN_MS,
    breakerWindowMs: env.CUSTOMER_AI_PROVIDER_BREAKER_WINDOW_MS,
    breakerHalfOpenProbes: env.CUSTOMER_AI_PROVIDER_HALF_OPEN_PROBES,
    // Shadow promotion-review thresholds are intentionally separate from the
    // runtime breaker. They evaluate historical variants and cannot alter mode.
    shadowGateMinRuns: env.CUSTOMER_AI_SHADOW_GATE_MIN_RUNS,
    shadowGateMaxFailurePercent:
      env.CUSTOMER_AI_SHADOW_GATE_MAX_FAILURE_PERCENT,
    shadowGateMaxProviderFailurePercent:
      env.CUSTOMER_AI_SHADOW_GATE_MAX_PROVIDER_FAILURE_PERCENT,
    shadowGateMaxSchemaFailurePercent:
      env.CUSTOMER_AI_SHADOW_GATE_MAX_SCHEMA_FAILURE_PERCENT,
    shadowGateMaxToolFailurePercent:
      env.CUSTOMER_AI_SHADOW_GATE_MAX_TOOL_FAILURE_PERCENT,
    shadowGateMaxSupersededPercent:
      env.CUSTOMER_AI_SHADOW_GATE_MAX_SUPERSEDED_PERCENT,
    shadowGateMaxHandoffPercent:
      env.CUSTOMER_AI_SHADOW_GATE_MAX_HANDOFF_PERCENT,
    shadowGateMaxP95LatencyMs: env.CUSTOMER_AI_SHADOW_GATE_MAX_P95_LATENCY_MS,
    shadowGateMaxAverageCostMinorUnit:
      env.CUSTOMER_AI_SHADOW_GATE_MAX_AVERAGE_COST_MINOR_UNIT,
    // Durable repeated-evaluation evidence must match all of these approved
    // criteria before shadow telemetry can become ready for human review.
    evaluationContractVersion: env.CUSTOMER_AI_EVAL_CONTRACT_VERSION,
    evaluationDatasetVersion: env.CUSTOMER_AI_EVAL_DATASET_VERSION,
    evaluationDatasetSha256: env.CUSTOMER_AI_EVAL_DATASET_SHA256,
    runtimeSafetyContractVersion:
      env.CUSTOMER_AI_RUNTIME_SAFETY_CONTRACT_VERSION,
    runtimeSafetyReportSha256: env.CUSTOMER_AI_RUNTIME_SAFETY_REPORT_SHA256,
    releaseSourceRevision: env.CUSTOMER_AI_RELEASE_SOURCE_REVISION,
    evaluationEvidenceMaxAgeDays: env.CUSTOMER_AI_EVAL_EVIDENCE_MAX_AGE_DAYS,
    evaluationGateMinFixtures: env.CUSTOMER_AI_EVAL_GATE_MIN_FIXTURES,
    evaluationGateMinTrialsPerFixture:
      env.CUSTOMER_AI_EVAL_GATE_MIN_TRIALS_PER_FIXTURE,
    evaluationGateMaxFailureRateUpperBoundPercent:
      env.CUSTOMER_AI_EVAL_GATE_MAX_FAILURE_RATE_UPPER_BOUND_PERCENT,
    evaluationGateMaxFailureRateDeltaPercent:
      env.CUSTOMER_AI_EVAL_GATE_MAX_FAILURE_RATE_DELTA_PERCENT,
    // Shared Redis budgets for shadow and live interpretation, in USD cents.
    // Positive limits/rates are required at startup for either paid path;
    // reservations enforce concurrent spend admission before provider calls.
    dailySpendLimitMinorUnit: env.CUSTOMER_AI_DAILY_SPEND_LIMIT_MINOR_UNIT,
    monthlySpendLimitMinorUnit: env.CUSTOMER_AI_MONTHLY_SPEND_LIMIT_MINOR_UNIT,
    openAiInputCostPerMillionMinorUnit:
      env.CUSTOMER_AI_OPENAI_INPUT_COST_PER_MILLION_MINOR_UNIT,
    openAiOutputCostPerMillionMinorUnit:
      env.CUSTOMER_AI_OPENAI_OUTPUT_COST_PER_MILLION_MINOR_UNIT,
    spendReservationTtlSeconds: env.CUSTOMER_AI_SPEND_RESERVATION_TTL_SECONDS,
    spendKeyNamespace: env.CUSTOMER_AI_SPEND_KEY_NAMESPACE,
    // Version labels make historical runs and eval failures reproducible.
    promptVersion: env.CUSTOMER_AI_PROMPT_VERSION,
    policyVersion: env.CUSTOMER_AI_POLICY_VERSION,
    toolContractVersion: env.CUSTOMER_AI_TOOL_CONTRACT_VERSION,
    responseContractVersion: env.CUSTOMER_AI_RESPONSE_CONTRACT_VERSION,
    // Never fall back to the production credential in the standalone live
    // evaluator. A missing evaluation key must fail closed at command startup.
    evalOpenAiApiKey: env.CUSTOMER_AI_EVAL_OPENAI_API_KEY,
    openAiApiKey: env.OPENAI_API_KEY,
    // Internal constants are kept here so queue construction has one source.
    queuePrefix: 'ordira',
    queueReadyTimeoutMs: 1000,
    queueUnavailableRetryDelayMs: 30 * 1000,
  };
});
