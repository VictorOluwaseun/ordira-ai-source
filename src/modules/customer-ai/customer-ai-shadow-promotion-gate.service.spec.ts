import type { ConfigType } from '@nestjs/config';
import { customerAiConfig } from '@config/customer-ai.config';
import {
  CustomerAiShadowPromotionGateService,
  type CustomerAiShadowVariantMetrics,
} from './customer-ai-shadow-promotion-gate.service';

describe('CustomerAiShadowPromotionGateService', () => {
  it('returns an explicitly read-only gate contract and configured thresholds', () => {
    const gate = createGate();

    expect(gate.evaluate([])).toEqual({
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
        maxAverageCostMinorUnit: 0,
        maxCriticalSafetyViolations: 0,
      },
      variants: [],
    });
  });

  it('keeps an otherwise healthy variant insufficient until minimum sample', () => {
    const [result] = createGate().evaluate([
      variant({ totalRuns: 120, evaluatedRuns: 99 }),
    ]).variants;

    expect(result).toEqual(
      expect.objectContaining({
        status: 'insufficient_data',
        reasonCodes: ['minimum_sample_not_met'],
      }),
    );
  });

  it('blocks a real shadow side effect immediately at any sample size', () => {
    const [result] = createGate().evaluate([
      variant({
        totalRuns: 1,
        evaluatedRuns: 1,
        criticalSafetyViolationRuns: 1,
      }),
    ]).variants;

    expect(result).toEqual(
      expect.objectContaining({
        status: 'blocked',
        reasonCodes: ['critical_safety_violation_observed'],
      }),
    );
  });

  it('allows values exactly on every configured maximum', () => {
    const [result] = createGate().evaluate([
      variant({
        totalRuns: 100,
        evaluatedRuns: 100,
        failedRuns: 5,
        providerFailureRuns: 3,
        toolFailureRuns: 5,
        supersededRuns: 10,
        handoffRuns: 50,
        p95LatencyMs: 8000,
      }),
    ]).variants;

    expect(result.status).toBe('eligible');
    expect(result.reasonCodes).toEqual([]);
  });

  it('reports every objective threshold breach in stable order', () => {
    const [result] = createGate().evaluate([
      variant({
        totalRuns: 100,
        evaluatedRuns: 100,
        failedRuns: 6,
        providerFailureRuns: 4,
        schemaFailureRuns: 1,
        toolFailureRuns: 6,
        supersededRuns: 11,
        handoffRuns: 51,
        p95LatencyMs: 8001,
        estimatedCostMinorUnit: 1,
      }),
    ]).variants;

    expect(result.status).toBe('blocked');
    expect(result.reasonCodes).toEqual([
      'failure_rate_exceeded',
      'provider_failure_rate_exceeded',
      'schema_failure_rate_exceeded',
      'tool_failure_rate_exceeded',
      'superseded_rate_exceeded',
      'handoff_rate_exceeded',
      'p95_latency_exceeded',
      'average_cost_exceeded',
    ]);
  });

  it('blocks an adequate sample when latency evidence is unavailable', () => {
    const [result] = createGate().evaluate([
      variant({ totalRuns: 100, evaluatedRuns: 100, p95LatencyMs: null }),
    ]).variants;

    expect(result).toEqual(
      expect.objectContaining({
        status: 'blocked',
        reasonCodes: ['p95_latency_unavailable'],
      }),
    );
  });

  it('compares exact counts instead of rounded display rates', () => {
    const [result] = createGate().evaluate([
      variant({
        totalRuns: 1_000_000,
        evaluatedRuns: 1_000_000,
        failedRuns: 50_001,
      }),
    ]).variants;

    expect(result.observed.failureRate).toBe(0.05);
    expect(result.status).toBe('blocked');
    expect(result.reasonCodes).toContain('failure_rate_exceeded');
  });
});

function createGate(): CustomerAiShadowPromotionGateService {
  return new CustomerAiShadowPromotionGateService({
    shadowGateMinRuns: 100,
    shadowGateMaxFailurePercent: 5,
    shadowGateMaxProviderFailurePercent: 3,
    shadowGateMaxSchemaFailurePercent: 0,
    shadowGateMaxToolFailurePercent: 5,
    shadowGateMaxSupersededPercent: 10,
    shadowGateMaxHandoffPercent: 50,
    shadowGateMaxP95LatencyMs: 8000,
    shadowGateMaxAverageCostMinorUnit: 0,
  } as ConfigType<typeof customerAiConfig>);
}

function variant(
  overrides: Partial<CustomerAiShadowVariantMetrics> = {},
): CustomerAiShadowVariantMetrics {
  return {
    provider: 'openai',
    model: 'gpt-example',
    reasoningEffort: 'medium',
    maxOutputTokens: 2048,
    maxContextMessages: 4,
    promptVersion: 'prompt-v1',
    policyVersion: 'policy-v1',
    toolContractVersion: 'tools-v1',
    responseContractVersion: 'response-v1',
    totalRuns: 100,
    evaluatedRuns: 100,
    failedRuns: 0,
    supersededRuns: 0,
    handoffRuns: 0,
    providerFailureRuns: 0,
    schemaFailureRuns: 0,
    toolFailureRuns: 0,
    criticalSafetyViolationRuns: 0,
    estimatedCostMinorUnit: 0,
    p95LatencyMs: 1000,
    ...overrides,
  };
}
