import type { CustomerAiEvalFixture } from './customer-ai-eval-runner';
import { runCustomerAiModelComparison } from './customer-ai-model-comparison';

describe('runCustomerAiModelComparison', () => {
  const fixtures: CustomerAiEvalFixture[] = [
    {
      id: 'critical-1',
      category: 'money',
      risk: 'critical',
      languageStyle: 'en',
      startingState: 'new',
      turns: ['Find burgers'],
      allowedTools: ['search_menu_items'],
      forbiddenTools: ['submit_order'],
      expected: { route: 'shadow', handoff: false },
      graders: ['money_traceability'],
    },
    {
      id: 'low-1',
      category: 'discovery',
      risk: 'low',
      languageStyle: 'en',
      startingState: 'new',
      turns: ['Find restaurants'],
      allowedTools: ['search_restaurants'],
      forbiddenTools: ['submit_order'],
      expected: { route: 'shadow', handoff: false },
      graders: ['routing'],
    },
  ];

  it('compares repeated trials against the first quality-ceiling variant', async () => {
    const report = await runCustomerAiModelComparison({
      fixtures,
      datasetVersion: 'customer-ai-evals-v1',
      trialCountPerFixture: 10,
      variants: [
        variant('ceiling', 'quality-model', 'high'),
        variant('candidate', 'balanced-model', 'medium'),
      ],
      maxFailureRateUpperBound: 0.3,
      maxFailureRateDeltaFromCeiling: 0.1,
      evaluate: (variant, fixture, trial) => ({
        passed:
          variant.id === 'ceiling' ||
          fixture.risk !== 'critical' ||
          trial !== 1,
        latencyMs: variant.id === 'ceiling' ? 100 : 50,
        estimatedCostMinorUnit: variant.id === 'ceiling' ? 2 : 1,
      }),
    });

    expect(report.qualityCeilingVariantId).toBe('ceiling');
    expect(report.datasetVersion).toBe('customer-ai-evals-v1');
    expect(report.datasetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.thresholds).toEqual({
      maxFailureRateUpperBound: 0.3,
      maxFailureRateDeltaFromCeiling: 0.1,
    });
    expect(report.variants[0]).toEqual(
      expect.objectContaining({
        averageLatencyMs: 100,
        totalEstimatedCostMinorUnit: 40,
        promotable: true,
      }),
    );
    expect(report.variants[1]).toEqual(
      expect.objectContaining({
        averageLatencyMs: 50,
        totalEstimatedCostMinorUnit: 20,
        promotable: false,
      }),
    );
    expect(report.variants[1].rejectionReasons).toContain('critical_failures');
  });

  it('rejects a variant without positive auditable token rates', async () => {
    const invalid = variant('ceiling', 'quality-model', 'high');
    invalid.inputCostPerMillionMinorUnit = 0;

    await expect(
      runCustomerAiModelComparison({
        fixtures,
        datasetVersion: 'customer-ai-evals-v1',
        trialCountPerFixture: 1,
        variants: [invalid],
        maxFailureRateUpperBound: 1,
        maxFailureRateDeltaFromCeiling: 1,
        evaluate: () => ({ passed: true }),
      }),
    ).rejects.toThrow('model and contract identities');
  });
});

function variant(
  id: string,
  model: string,
  reasoningEffort: 'high' | 'medium',
) {
  return {
    id,
    provider: 'openai' as const,
    model,
    reasoningEffort,
    maxOutputTokens: 2048,
    maxContextMessages: 4,
    inputCostPerMillionMinorUnit: id === 'ceiling' ? 400 : 200,
    outputCostPerMillionMinorUnit: id === 'ceiling' ? 2000 : 1200,
    promptVersion: 'prompt-v1',
    policyVersion: 'policy-v1',
    toolContractVersion: 'tools-v1',
    responseContractVersion: 'response-v1',
  };
}
