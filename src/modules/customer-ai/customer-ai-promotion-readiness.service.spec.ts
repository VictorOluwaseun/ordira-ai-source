import type { ConfigType } from '@nestjs/config';
import { customerAiConfig } from '@config/customer-ai.config';
import type { CustomerAiEvaluationEvidenceRepository } from './customer-ai-evaluation-evidence.repository';
import { CustomerAiPromotionReadinessService } from './customer-ai-promotion-readiness.service';
import type { CustomerAiShadowPromotionGateResult } from './customer-ai-shadow-promotion-gate.service';
import type { CustomerAiEvaluationEvidence } from './schemas/customer-ai-evaluation-evidence.schema';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const DATASET_SHA256 = 'a'.repeat(64);
const RUNTIME_SHA256 = 'c'.repeat(64);
const SOURCE_REVISION = 'd'.repeat(40);

describe('CustomerAiPromotionReadinessService', () => {
  it('marks an exact, current, statistically passing variant ready for review', async () => {
    const repository = createRepository([evidence()]);
    const service = createService(repository);

    const [result] = (await service.evaluate(shadowPromotion(), NOW)).variants;

    expect(result).toMatchObject({
      status: 'ready_for_human_review',
      reasonCodes: [],
      shadow: { status: 'eligible', reasonCodes: [] },
    });
    expect(result.evaluation).toEqual(
      expect.objectContaining({
        comparisonId: 'comparison-1',
        datasetSha256: DATASET_SHA256,
        criticalFailures: 0,
        runtimeSafetyReportSha256: RUNTIME_SHA256,
      }),
    );
  });

  it('stays insufficient when evidence or explicit dataset approval is absent', async () => {
    const repository = createRepository([]);
    const service = createService(repository, {
      evaluationDatasetSha256: null,
    });

    const [result] = (await service.evaluate(shadowPromotion(), NOW)).variants;

    expect(result.status).toBe('insufficient_data');
    expect(result.reasonCodes).toEqual([
      'evaluation_dataset_not_approved',
      'evaluation_evidence_missing',
    ]);
    expect(result.evaluation).toBeNull();
  });

  it('rejects evidence for a different prompt or contract deployment', async () => {
    const repository = createRepository([
      evidence({ promptVersion: 'prompt-v0' }),
    ]);
    const service = createService(repository);

    const [result] = (await service.evaluate(shadowPromotion(), NOW)).variants;

    expect(result.status).toBe('blocked');
    expect(result.reasonCodes).toEqual([
      'evaluation_variant_contract_mismatch',
    ]);
    expect(result.evaluation?.promptVersion).toBe('prompt-v0');
  });

  it('rejects evidence produced with a different output-token budget', async () => {
    const repository = createRepository([evidence({ maxOutputTokens: 1024 })]);
    const service = createService(repository);

    const [result] = (await service.evaluate(shadowPromotion(), NOW)).variants;

    expect(result.status).toBe('blocked');
    expect(result.reasonCodes).toEqual([
      'evaluation_variant_contract_mismatch',
    ]);
    expect(result.evaluation?.maxOutputTokens).toBe(1024);
  });

  it('requires fresh evidence and reports inadequate repeated samples', async () => {
    const repository = createRepository([
      evidence({
        evaluatedAt: new Date('2026-07-01T00:00:00.000Z'),
        fixtureCount: 50,
        trialCountPerFixture: 1,
      }),
    ]);
    const service = createService(repository);

    const [result] = (await service.evaluate(shadowPromotion(), NOW)).variants;

    expect(result.status).toBe('insufficient_data');
    expect(result.reasonCodes).toEqual([
      'evaluation_evidence_stale',
      'evaluation_fixture_count_below_minimum',
      'evaluation_trial_count_below_minimum',
    ]);
  });

  it('blocks critical failures, confidence-bound failures, and ceiling regression', async () => {
    const repository = createRepository([
      evidence({
        criticalFailures: 1,
        oneSided95FailureRateUpperBound: 0.06,
        failureRateDeltaFromCeiling: 0.02,
        promotable: false,
        rejectionReasons: [
          'critical_failures',
          'failure_rate_upper_bound',
          'quality_ceiling_regression',
        ],
      }),
    ]);
    const service = createService(repository);

    const [result] = (await service.evaluate(shadowPromotion(), NOW)).variants;

    expect(result.status).toBe('blocked');
    expect(result.reasonCodes).toEqual([
      'evaluation_critical_failures_observed',
      'evaluation_failure_bound_exceeded',
      'evaluation_quality_ceiling_regression',
      'evaluation_report_rejected',
    ]);
  });

  it('does not accept model evidence without approved runtime safety evidence', async () => {
    const repository = createRepository([
      evidence({
        runtimeSafetyContractVersion: null,
        runtimeSafetyReportSha256: null,
        runtimeSafetyExecutedAt: null,
        runtimeSafetyChecks: [],
      }),
    ]);
    const service = createService(repository);

    const [result] = (await service.evaluate(shadowPromotion(), NOW)).variants;

    expect(result.status).toBe('insufficient_data');
    expect(result.reasonCodes).toContain('runtime_safety_evidence_missing');
  });

  it('stays insufficient until the deployed release revision is declared', async () => {
    const service = createService(createRepository([evidence()]), {
      releaseSourceRevision: null,
    });

    const [result] = (await service.evaluate(shadowPromotion(), NOW)).variants;

    expect(result.status).toBe('insufficient_data');
    expect(result.reasonCodes).toContain(
      'release_source_revision_not_configured',
    );
  });

  it('does not promote legacy evidence without exact source provenance', async () => {
    const service = createService(
      createRepository([evidence({ evaluationSourceRevision: null })]),
    );

    const [result] = (await service.evaluate(shadowPromotion(), NOW)).variants;

    expect(result.status).toBe('insufficient_data');
    expect(result.reasonCodes).toContain('source_revision_evidence_missing');
  });

  it('blocks evaluation and runtime evidence from different revisions', async () => {
    const service = createService(
      createRepository([
        evidence({ runtimeSafetySourceRevision: 'e'.repeat(40) }),
      ]),
    );

    const [result] = (await service.evaluate(shadowPromotion(), NOW)).variants;

    expect(result.status).toBe('blocked');
    expect(result.reasonCodes).toContain(
      'evaluation_runtime_source_revision_mismatch',
    );
  });

  it('blocks evidence that does not describe the deployed release revision', async () => {
    const service = createService(createRepository([evidence()]), {
      releaseSourceRevision: 'f'.repeat(40),
    });

    const [result] = (await service.evaluate(shadowPromotion(), NOW)).variants;

    expect(result.status).toBe('blocked');
    expect(result.reasonCodes).toContain('release_source_revision_mismatch');
  });
});

function createService(
  repository: jest.Mocked<
    Pick<CustomerAiEvaluationEvidenceRepository, 'findLatestBehavioralVariants'>
  >,
  overrides: Record<string, unknown> = {},
): CustomerAiPromotionReadinessService {
  const config = {
    evaluationContractVersion: 'customer-ai-eval-v1',
    evaluationDatasetVersion: 'customer-ai-evals-v1',
    evaluationDatasetSha256: DATASET_SHA256,
    runtimeSafetyContractVersion: 'customer-ai-runtime-safety-v1',
    runtimeSafetyReportSha256: RUNTIME_SHA256,
    releaseSourceRevision: SOURCE_REVISION,
    evaluationEvidenceMaxAgeDays: 30,
    evaluationGateMinFixtures: 100,
    evaluationGateMinTrialsPerFixture: 3,
    evaluationGateMaxFailureRateUpperBoundPercent: 5,
    evaluationGateMaxFailureRateDeltaPercent: 1,
    ...overrides,
  } as ConfigType<typeof customerAiConfig>;

  return new CustomerAiPromotionReadinessService(
    config,
    repository as CustomerAiEvaluationEvidenceRepository,
  );
}

function createRepository(
  records: CustomerAiEvaluationEvidence[],
): jest.Mocked<
  Pick<CustomerAiEvaluationEvidenceRepository, 'findLatestBehavioralVariants'>
> {
  return {
    findLatestBehavioralVariants: jest.fn().mockResolvedValue(records),
  };
}

function shadowPromotion(): CustomerAiShadowPromotionGateResult {
  return {
    scope: 'shadow_telemetry_only',
    selectedRangeOnly: true,
    automaticActivation: false,
    offlineEvaluationRequired: true,
    thresholds: {
      minimumRuns: 100,
      maxFailureRate: 0.05,
      maxProviderFailureRate: 0.03,
      maxSchemaFailureRate: 0,
      maxToolFailureRate: 0.05,
      maxSupersededRate: 0.1,
      maxHandoffRate: 0.5,
      maxP95LatencyMs: 8000,
      maxAverageCostMinorUnit: 5,
      maxCriticalSafetyViolations: 0,
    },
    variants: [
      {
        provider: 'openai',
        model: 'quality-model',
        reasoningEffort: 'high',
        maxOutputTokens: 2048,
        maxContextMessages: 4,
        promptVersion: 'prompt-v1',
        policyVersion: 'policy-v1',
        toolContractVersion: 'tools-v1',
        responseContractVersion: 'response-v1',
        status: 'eligible',
        reasonCodes: [],
        observed: {
          totalRuns: 100,
          evaluatedRuns: 100,
          failedRuns: 0,
          failureRate: 0,
          providerFailureRuns: 0,
          providerFailureRate: 0,
          schemaFailureRuns: 0,
          schemaFailureRate: 0,
          toolFailureRuns: 0,
          toolFailureRate: 0,
          supersededRuns: 0,
          supersededRate: 0,
          handoffRuns: 0,
          handoffRate: 0,
          criticalSafetyViolationRuns: 0,
          p95LatencyMs: 1000,
          averageCostMinorUnit: 1,
        },
      },
    ],
  };
}

function evidence(
  overrides: Partial<CustomerAiEvaluationEvidence> = {},
): CustomerAiEvaluationEvidence {
  return {
    comparisonId: 'comparison-1',
    variantId: 'ceiling',
    provider: 'openai',
    model: 'quality-model',
    reasoningEffort: 'high',
    maxOutputTokens: 2048,
    maxContextMessages: 4,
    inputCostPerMillionMinorUnit: 400,
    outputCostPerMillionMinorUnit: 2000,
    promptVersion: 'prompt-v1',
    policyVersion: 'policy-v1',
    toolContractVersion: 'tools-v1',
    responseContractVersion: 'response-v1',
    evaluationContractVersion: 'customer-ai-eval-v1',
    datasetVersion: 'customer-ai-evals-v1',
    datasetSha256: DATASET_SHA256,
    fixtureCount: 100,
    trialCountPerFixture: 3,
    totalTrials: 300,
    failures: 0,
    failureRate: 0,
    oneSided95FailureRateUpperBound: 0.009,
    criticalFailures: 0,
    evaluationSourceRevision: SOURCE_REVISION,
    runtimeSafetyContractVersion: 'customer-ai-runtime-safety-v1',
    runtimeSafetyReportSha256: RUNTIME_SHA256,
    runtimeSafetySourceRevision: SOURCE_REVISION,
    runtimeSafetyExecutedAt: new Date('2026-08-25T12:00:00.000Z'),
    runtimeSafetyChecks: [
      'causal_outbound_dispatch_guard',
      'causal_outbound_dispatch_race',
      'causal_shadow_post_state',
      'provider_breaker_generation_concurrency',
      'queue_recovery_after_startup_redis_outage',
      'run_fencing_after_lease_takeover',
      'spend_guard_atomic_idempotency',
      'tool_audit_fencing_after_takeover',
    ],
    averageLatencyMs: 1200,
    totalEstimatedCostMinorUnit: 300,
    failureRateDeltaFromCeiling: 0,
    qualityCeilingVariantId: 'ceiling',
    promotable: true,
    rejectionReasons: [],
    cases: [],
    evidenceSha256: 'b'.repeat(64),
    evaluatedAt: new Date('2026-08-25T12:00:00.000Z'),
    createdAt: new Date('2026-08-25T12:00:00.000Z'),
    updatedAt: new Date('2026-08-25T12:00:00.000Z'),
    ...overrides,
  };
}
