import type { CustomerAiModelComparisonReport } from './evals/customer-ai-model-comparison';
import { CustomerAiEvaluationEvidenceService } from './customer-ai-evaluation-evidence.service';
import type { CustomerAiEvaluationEvidenceRepository } from './customer-ai-evaluation-evidence.repository';
import type { CustomerAiRuntimeSafetyEvidence } from './customer-ai-runtime-safety-evidence';

const SOURCE_REVISION = '371761c6533118b360e6a5816e6c8e079367344d';

describe('CustomerAiEvaluationEvidenceService', () => {
  it('persists immutable sanitized evidence for every exact variant', async () => {
    const repository = createRepository();
    const service = new CustomerAiEvaluationEvidenceService(
      repository as CustomerAiEvaluationEvidenceRepository,
    );
    const evaluatedAt = new Date('2026-09-01T12:00:00.000Z');

    await expect(
      service.recordComparison({
        comparisonId: 'comparison-2026-09-01',
        sourceRevision: SOURCE_REVISION,
        evaluationContractVersion: 'customer-ai-eval-v1',
        runtimeSafetyEvidence: runtimeSafetyEvidence(),
        report: report(),
        evaluatedAt,
      }),
    ).resolves.toEqual({
      comparisonId: 'comparison-2026-09-01',
      evidenceCount: 1,
      datasetVersion: 'customer-ai-evals-v1',
      datasetSha256: 'a'.repeat(64),
      evaluatedAt: evaluatedAt.toISOString(),
    });

    const [records] = repository.recordComparison.mock.calls[0] ?? [];
    expect(records).toHaveLength(1);
    expect(records?.[0]).toEqual(
      expect.objectContaining({
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
        fixtureCount: 1,
        trialCountPerFixture: 3,
        criticalFailures: 0,
        evaluatedAt,
      }),
    );
    expect(records?.[0].evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(records)).not.toContain('Find me a burger');
    expect(JSON.stringify(records)).not.toContain('providerOutput');
  });

  it('produces the same evidence hash for an idempotent retry', async () => {
    const repository = createRepository();
    const service = new CustomerAiEvaluationEvidenceService(
      repository as CustomerAiEvaluationEvidenceRepository,
    );
    const input = {
      comparisonId: 'comparison-retry',
      sourceRevision: SOURCE_REVISION,
      evaluationContractVersion: 'customer-ai-eval-v1',
      runtimeSafetyEvidence: runtimeSafetyEvidence(),
      report: report(),
      evaluatedAt: new Date('2026-09-01T12:00:00.000Z'),
    };

    await service.recordComparison(input);
    await service.recordComparison(input);

    expect(
      repository.recordComparison.mock.calls[0]?.[0][0]?.evidenceSha256,
    ).toBe(repository.recordComparison.mock.calls[1]?.[0][0]?.evidenceSha256);
  });

  it('rejects internally inconsistent repeated-evaluation totals', async () => {
    const repository = createRepository();
    const service = new CustomerAiEvaluationEvidenceService(
      repository as CustomerAiEvaluationEvidenceRepository,
    );
    const invalidReport = report();
    invalidReport.variants[0].evaluation.totalTrials = 2;

    await expect(
      service.recordComparison({
        comparisonId: 'comparison-invalid',
        sourceRevision: SOURCE_REVISION,
        evaluationContractVersion: 'customer-ai-eval-v1',
        runtimeSafetyEvidence: runtimeSafetyEvidence(),
        report: invalidReport,
      }),
    ).rejects.toThrow('Customer AI repeated evaluation totals are invalid');
    expect(repository.recordComparison).not.toHaveBeenCalled();
  });

  it('rejects model and runtime evidence from different revisions', async () => {
    const repository = createRepository();
    const service = new CustomerAiEvaluationEvidenceService(
      repository as CustomerAiEvaluationEvidenceRepository,
    );

    await expect(
      service.recordComparison({
        comparisonId: 'comparison-revision-mismatch',
        sourceRevision: 'f'.repeat(40),
        evaluationContractVersion: 'customer-ai-eval-v1',
        runtimeSafetyEvidence: runtimeSafetyEvidence(),
        report: report(),
      }),
    ).rejects.toThrow(
      'Customer AI evaluation and runtime safety revisions must match',
    );
    expect(repository.recordComparison).not.toHaveBeenCalled();
  });

  it('rejects forged rates, ceiling deltas, and promotion reasons', async () => {
    const repository = createRepository();
    const service = new CustomerAiEvaluationEvidenceService(
      repository as CustomerAiEvaluationEvidenceRepository,
    );
    const forgedRate = report();
    forgedRate.variants[0].evaluation.failureRate = 0.25;
    await expect(
      service.recordComparison({
        comparisonId: 'comparison-forged-rate',
        sourceRevision: SOURCE_REVISION,
        evaluationContractVersion: 'customer-ai-eval-v1',
        runtimeSafetyEvidence: runtimeSafetyEvidence(),
        report: forgedRate,
      }),
    ).rejects.toThrow('Customer AI repeated evaluation totals are invalid');

    const forgedPricing = report();
    forgedPricing.variants[0].variant.inputCostPerMillionMinorUnit = 0;
    await expect(
      service.recordComparison({
        comparisonId: 'comparison-forged-pricing',
        sourceRevision: SOURCE_REVISION,
        evaluationContractVersion: 'customer-ai-eval-v2',
        runtimeSafetyEvidence: runtimeSafetyEvidence(),
        report: forgedPricing,
      }),
    ).rejects.toThrow('Customer AI evaluation variant contracts are invalid');

    const forgedDelta = report();
    forgedDelta.variants[0].failureRateDeltaFromCeiling = 0.1;
    await expect(
      service.recordComparison({
        comparisonId: 'comparison-forged-delta',
        sourceRevision: SOURCE_REVISION,
        evaluationContractVersion: 'customer-ai-eval-v1',
        runtimeSafetyEvidence: runtimeSafetyEvidence(),
        report: forgedDelta,
      }),
    ).rejects.toThrow('Customer AI evaluation variant metrics are invalid');

    const forgedPromotion = report();
    forgedPromotion.variants[0].promotable = false;
    forgedPromotion.variants[0].rejectionReasons = ['critical_failures'];
    await expect(
      service.recordComparison({
        comparisonId: 'comparison-forged-promotion',
        sourceRevision: SOURCE_REVISION,
        evaluationContractVersion: 'customer-ai-eval-v1',
        runtimeSafetyEvidence: runtimeSafetyEvidence(),
        report: forgedPromotion,
      }),
    ).rejects.toThrow('Customer AI evaluation variant metrics are invalid');

    expect(repository.recordComparison).not.toHaveBeenCalled();
  });
});

function createRepository(): jest.Mocked<
  Pick<CustomerAiEvaluationEvidenceRepository, 'recordComparison'>
> {
  return {
    recordComparison: jest.fn().mockResolvedValue(undefined),
  };
}

function runtimeSafetyEvidence(): CustomerAiRuntimeSafetyEvidence {
  return {
    contractVersion: 'customer-ai-runtime-safety-v1',
    reportSha256: 'c'.repeat(64),
    sourceRevision: SOURCE_REVISION,
    executedAt: new Date('2026-09-01T11:00:00.000Z'),
    checks: [
      'causal_outbound_dispatch_guard',
      'causal_outbound_dispatch_race',
      'causal_shadow_post_state',
      'provider_breaker_generation_concurrency',
      'queue_recovery_after_startup_redis_outage',
      'run_fencing_after_lease_takeover',
      'spend_guard_atomic_idempotency',
      'tool_audit_fencing_after_takeover',
    ],
  };
}

function report(): CustomerAiModelComparisonReport {
  return {
    datasetVersion: 'customer-ai-evals-v1',
    datasetSha256: 'a'.repeat(64),
    fixtureCount: 1,
    trialCountPerFixture: 3,
    qualityCeilingVariantId: 'ceiling',
    thresholds: {
      maxFailureRateUpperBound: 0.8,
      maxFailureRateDeltaFromCeiling: 0.1,
    },
    variants: [
      {
        variant: {
          id: 'ceiling',
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
        },
        evaluation: {
          fixtureCount: 1,
          trialCountPerFixture: 3,
          totalTrials: 3,
          failures: 0,
          failureRate: 0,
          oneSided95FailureRateUpperBound: 0.4741955741575129,
          criticalFailures: 0,
          cases: [
            {
              fixtureId: 'critical-money-1',
              risk: 'critical',
              trials: 3,
              failures: 0,
              failureRate: 0,
              oneSided95FailureRateUpperBound: 0.4741955741575129,
            },
          ],
        },
        averageLatencyMs: 1200,
        totalEstimatedCostMinorUnit: 9,
        failureRateDeltaFromCeiling: 0,
        promotable: true,
        rejectionReasons: [],
      },
    ],
  };
}
