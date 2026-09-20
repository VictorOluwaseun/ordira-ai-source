import {
  addCustomerAiEvalVariantUsage,
  customerAiEvalCommandHelp,
  estimateCustomerAiEvalVariantCost,
  parseCustomerAiEvalCommandArgs,
  requireCustomerAiEvalOpenAiApiKey,
} from './customer-ai-eval-command';

describe('customer AI evaluation command', () => {
  it('parses explicit live, variant, repetition, concurrency, and spend limits', () => {
    expect(
      parseCustomerAiEvalCommandArgs([
        '--live',
        '--comparison-id',
        'comparison-2026-09-01',
        '--variant',
        'ceiling:gpt-quality:high:2048:400:2000',
        '--variant',
        'candidate:gpt-balanced:medium:2048:200:1200',
        '--trials',
        '3',
        '--concurrency',
        '2',
        '--max-cost-minor-unit',
        '5000',
        '--output',
        'artifacts/eval.json',
        '--record',
        '--runtime-safety-report',
        'artifacts/runtime-safety.json',
      ]),
    ).toEqual({
      live: true,
      help: false,
      comparisonId: 'comparison-2026-09-01',
      variants: [
        {
          id: 'ceiling',
          model: 'gpt-quality',
          reasoningEffort: 'high',
          maxOutputTokens: 2048,
          inputCostPerMillionMinorUnit: 400,
          outputCostPerMillionMinorUnit: 2000,
        },
        {
          id: 'candidate',
          model: 'gpt-balanced',
          reasoningEffort: 'medium',
          maxOutputTokens: 2048,
          inputCostPerMillionMinorUnit: 200,
          outputCostPerMillionMinorUnit: 1200,
        },
      ],
      trials: 3,
      concurrency: 2,
      maxCostMinorUnit: 5000,
      outputPath: 'artifacts/eval.json',
      runtimeSafetyReportPath: 'artifacts/runtime-safety.json',
      record: true,
    });
  });

  it('requires explicit live mode and all cost-bearing limits', () => {
    expect(() =>
      parseCustomerAiEvalCommandArgs([
        '--comparison-id',
        'comparison-1',
        '--variant',
        'ceiling:model:high:2048:400:2000',
        '--trials',
        '3',
        '--concurrency',
        '1',
        '--max-cost-minor-unit',
        '100',
      ]),
    ).toThrow('requires explicit --live');
  });

  it('rejects malformed variants, unknown flags, and duplicate singleton flags', () => {
    const base = [
      '--live',
      '--comparison-id',
      'comparison-1',
      '--trials',
      '3',
      '--concurrency',
      '1',
      '--max-cost-minor-unit',
      '100',
    ];
    expect(() =>
      parseCustomerAiEvalCommandArgs([...base, '--variant', 'bad-variant']),
    ).toThrow('--variant must use');
    expect(() =>
      parseCustomerAiEvalCommandArgs([
        ...base,
        '--variant',
        'ceiling:model:high:2048:0:2000',
      ]),
    ).toThrow('--variant must use');
    expect(() =>
      parseCustomerAiEvalCommandArgs([
        ...base,
        '--variant',
        'ceiling:model:high:2048:400:2000',
        '--surprise',
      ]),
    ).toThrow('Unknown customer AI evaluation option');
    expect(() =>
      parseCustomerAiEvalCommandArgs([
        ...base,
        '--variant',
        'ceiling:model:high:2048:400:2000',
        '--trials',
        '4',
      ]),
    ).toThrow('Duplicate customer AI evaluation option');
  });

  it('shows help without requiring live credentials or options', () => {
    expect(parseCustomerAiEvalCommandArgs(['--help']).help).toBe(true);
    expect(customerAiEvalCommandHelp()).toContain('first --variant');
  });

  it('prices usage with each variant rate and keeps local-only trials free', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };

    expect(
      estimateCustomerAiEvalVariantCost(usage, {
        inputCostPerMillionMinorUnit: 400,
        outputCostPerMillionMinorUnit: 2000,
      }),
    ).toBe(2400);
    expect(
      estimateCustomerAiEvalVariantCost(usage, {
        inputCostPerMillionMinorUnit: 200,
        outputCostPerMillionMinorUnit: 1200,
      }),
    ).toBe(1400);
    expect(
      estimateCustomerAiEvalVariantCost(
        { inputTokens: 0, outputTokens: 0 },
        {
          inputCostPerMillionMinorUnit: 400,
          outputCostPerMillionMinorUnit: 2000,
        },
      ),
    ).toBe(0);
  });

  it('aggregates only privacy-safe token counters for each variant', () => {
    const aggregate = {
      variantId: 'gpt-5.4-ceiling',
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    addCustomerAiEvalVariantUsage(aggregate, {
      inputTokens: 120,
      cachedInputTokens: 40,
      outputTokens: 30,
      totalTokens: 150,
      estimatedCostMinorUnit: 1,
    });
    addCustomerAiEvalVariantUsage(aggregate, {
      inputTokens: 80,
      cachedInputTokens: 0,
      outputTokens: 20,
      totalTokens: 999,
      estimatedCostMinorUnit: 1,
    });

    expect(aggregate).toEqual({
      variantId: 'gpt-5.4-ceiling',
      inputTokens: 200,
      cachedInputTokens: 40,
      outputTokens: 50,
      totalTokens: 250,
    });
  });

  it('requires a dedicated evaluation-project credential', () => {
    expect(
      requireCustomerAiEvalOpenAiApiKey({
        provider: 'openai',
        evalOpenAiApiKey: 'eval-project-key',
        openAiApiKey: 'production-project-key',
      }),
    ).toBe('eval-project-key');
    expect(() =>
      requireCustomerAiEvalOpenAiApiKey({
        provider: 'openai',
        evalOpenAiApiKey: null,
        openAiApiKey: 'production-project-key',
      }),
    ).toThrow('CUSTOMER_AI_EVAL_OPENAI_API_KEY are required');
    expect(() =>
      requireCustomerAiEvalOpenAiApiKey({
        provider: 'openai',
        evalOpenAiApiKey: 'shared-key',
        openAiApiKey: 'shared-key',
      }),
    ).toThrow('must be different from OPENAI_API_KEY');
  });
});
