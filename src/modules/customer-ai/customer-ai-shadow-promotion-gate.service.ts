import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { customerAiConfig } from '@config/customer-ai.config';

export type CustomerAiShadowGateStatus =
  | 'insufficient_data'
  | 'blocked'
  | 'eligible';

export type CustomerAiShadowGateReasonCode =
  | 'minimum_sample_not_met'
  | 'critical_safety_violation_observed'
  | 'failure_rate_exceeded'
  | 'provider_failure_rate_exceeded'
  | 'schema_failure_rate_exceeded'
  | 'tool_failure_rate_exceeded'
  | 'superseded_rate_exceeded'
  | 'handoff_rate_exceeded'
  | 'p95_latency_unavailable'
  | 'p95_latency_exceeded'
  | 'average_cost_exceeded';

/**
 * The complete identity of a shadow variant.
 *
 * Model name alone is not enough for a fair comparison. A prompt, policy, or
 * contract deployment can materially change behavior, so every such version
 * is part of the key evaluated by the gate.
 */
export type CustomerAiShadowVariantIdentity = {
  provider: string;
  model: string | null;
  reasoningEffort: string | null;
  maxOutputTokens: number;
  maxContextMessages: number;
  promptVersion: string;
  policyVersion: string;
  toolContractVersion: string;
  responseContractVersion: string;
};

/**
 * Sanitized, authoritative counters produced by the shadow-run aggregation.
 * The service deliberately accepts counts rather than model confidence so the
 * decision can be independently reproduced from durable run records.
 */
export type CustomerAiShadowVariantMetrics = CustomerAiShadowVariantIdentity & {
  totalRuns: number;
  evaluatedRuns: number;
  failedRuns: number;
  supersededRuns: number;
  handoffRuns: number;
  providerFailureRuns: number;
  schemaFailureRuns: number;
  toolFailureRuns: number;
  criticalSafetyViolationRuns: number;
  estimatedCostMinorUnit: number;
  p95LatencyMs: number | null;
};

export type CustomerAiShadowGateThresholds = {
  minimumRuns: number;
  maxFailureRate: number;
  maxProviderFailureRate: number;
  maxSchemaFailureRate: number;
  maxToolFailureRate: number;
  maxSupersededRate: number;
  maxHandoffRate: number;
  maxP95LatencyMs: number;
  maxAverageCostMinorUnit: number;
  maxCriticalSafetyViolations: 0;
};

export type CustomerAiShadowGateObservedMetrics = {
  totalRuns: number;
  evaluatedRuns: number;
  failedRuns: number;
  failureRate: number;
  providerFailureRuns: number;
  providerFailureRate: number;
  schemaFailureRuns: number;
  schemaFailureRate: number;
  toolFailureRuns: number;
  toolFailureRate: number;
  supersededRuns: number;
  supersededRate: number;
  handoffRuns: number;
  handoffRate: number;
  criticalSafetyViolationRuns: number;
  p95LatencyMs: number | null;
  averageCostMinorUnit: number;
};

export type CustomerAiShadowVariantGateResult =
  CustomerAiShadowVariantIdentity & {
    status: CustomerAiShadowGateStatus;
    reasonCodes: CustomerAiShadowGateReasonCode[];
    observed: CustomerAiShadowGateObservedMetrics;
  };

export type CustomerAiShadowPromotionGateResult = {
  /** Passing this gate is evidence for review, never an activation command. */
  scope: 'shadow_telemetry_only';
  /** The decision uses only the date/scope filters returned beside the report. */
  selectedRangeOnly: true;
  automaticActivation: false;
  /** Repeated offline/adversarial evaluation remains a separate requirement. */
  offlineEvaluationRequired: true;
  thresholds: CustomerAiShadowGateThresholds;
  variants: CustomerAiShadowVariantGateResult[];
};

/**
 * Converts durable shadow telemetry into an objective, read-only promotion
 * review decision for every exact provider/model/contract variant.
 *
 * This service has no repository, queue, rollout, or messaging dependency. It
 * therefore cannot mutate runtime mode or dispatch a customer response. That
 * separation is intentional: a passing result is one input to human review,
 * alongside the repeated offline evaluation suite and product approval.
 */
@Injectable()
export class CustomerAiShadowPromotionGateService {
  private readonly thresholds: CustomerAiShadowGateThresholds;

  constructor(
    @Inject(customerAiConfig.KEY)
    config: ConfigType<typeof customerAiConfig>,
  ) {
    this.thresholds = {
      minimumRuns: config.shadowGateMinRuns,
      maxFailureRate: percentToRate(config.shadowGateMaxFailurePercent),
      maxProviderFailureRate: percentToRate(
        config.shadowGateMaxProviderFailurePercent,
      ),
      maxSchemaFailureRate: percentToRate(
        config.shadowGateMaxSchemaFailurePercent,
      ),
      maxToolFailureRate: percentToRate(config.shadowGateMaxToolFailurePercent),
      maxSupersededRate: percentToRate(config.shadowGateMaxSupersededPercent),
      maxHandoffRate: percentToRate(config.shadowGateMaxHandoffPercent),
      maxP95LatencyMs: config.shadowGateMaxP95LatencyMs,
      maxAverageCostMinorUnit: config.shadowGateMaxAverageCostMinorUnit,
      // A shadow run must never commit a side effect. Unlike pilot-quality
      // budgets, this safety invariant is deliberately not configurable.
      maxCriticalSafetyViolations: 0,
    };
  }

  evaluate(
    variants: CustomerAiShadowVariantMetrics[],
  ): CustomerAiShadowPromotionGateResult {
    return {
      scope: 'shadow_telemetry_only',
      selectedRangeOnly: true,
      automaticActivation: false,
      offlineEvaluationRequired: true,
      thresholds: { ...this.thresholds },
      variants: variants.map((variant) => this.evaluateVariant(variant)),
    };
  }

  private evaluateVariant(
    variant: CustomerAiShadowVariantMetrics,
  ): CustomerAiShadowVariantGateResult {
    const observed = toObservedMetrics(variant);

    // A real side effect in shadow mode is a hard safety failure at any sample
    // size. It must never be hidden behind an "insufficient data" result.
    if (observed.criticalSafetyViolationRuns > 0) {
      return this.result(variant, observed, 'blocked', [
        'critical_safety_violation_observed',
      ]);
    }

    // Rates are too volatile to approve or reject a variant before the agreed
    // sample size. The observed values are still returned for diagnosis.
    if (observed.evaluatedRuns < this.thresholds.minimumRuns) {
      return this.result(variant, observed, 'insufficient_data', [
        'minimum_sample_not_met',
      ]);
    }

    const reasonCodes = this.thresholdBreaches(variant, observed);
    return this.result(
      variant,
      observed,
      reasonCodes.length > 0 ? 'blocked' : 'eligible',
      reasonCodes,
    );
  }

  private thresholdBreaches(
    variant: CustomerAiShadowVariantMetrics,
    observed: CustomerAiShadowGateObservedMetrics,
  ): CustomerAiShadowGateReasonCode[] {
    const reasons: CustomerAiShadowGateReasonCode[] = [];

    // Compare the original integer counts, not their four-decimal display
    // values. Otherwise a value just above a boundary could round down and be
    // incorrectly promoted.
    if (
      exceedsRate(
        variant.failedRuns,
        variant.evaluatedRuns,
        this.thresholds.maxFailureRate,
      )
    ) {
      reasons.push('failure_rate_exceeded');
    }
    if (
      exceedsRate(
        variant.providerFailureRuns,
        variant.evaluatedRuns,
        this.thresholds.maxProviderFailureRate,
      )
    ) {
      reasons.push('provider_failure_rate_exceeded');
    }
    if (
      exceedsRate(
        variant.schemaFailureRuns,
        variant.evaluatedRuns,
        this.thresholds.maxSchemaFailureRate,
      )
    ) {
      reasons.push('schema_failure_rate_exceeded');
    }
    if (
      exceedsRate(
        variant.toolFailureRuns,
        variant.evaluatedRuns,
        this.thresholds.maxToolFailureRate,
      )
    ) {
      reasons.push('tool_failure_rate_exceeded');
    }
    if (
      exceedsRate(
        variant.supersededRuns,
        variant.evaluatedRuns,
        this.thresholds.maxSupersededRate,
      )
    ) {
      reasons.push('superseded_rate_exceeded');
    }
    if (
      exceedsRate(
        variant.handoffRuns,
        variant.evaluatedRuns,
        this.thresholds.maxHandoffRate,
      )
    ) {
      reasons.push('handoff_rate_exceeded');
    }
    if (observed.p95LatencyMs === null) {
      reasons.push('p95_latency_unavailable');
    } else if (observed.p95LatencyMs > this.thresholds.maxP95LatencyMs) {
      reasons.push('p95_latency_exceeded');
    }
    if (
      exceedsAverage(
        variant.estimatedCostMinorUnit,
        variant.evaluatedRuns,
        this.thresholds.maxAverageCostMinorUnit,
      )
    ) {
      reasons.push('average_cost_exceeded');
    }

    return reasons;
  }

  private result(
    variant: CustomerAiShadowVariantMetrics,
    observed: CustomerAiShadowGateObservedMetrics,
    status: CustomerAiShadowGateStatus,
    reasonCodes: CustomerAiShadowGateReasonCode[],
  ): CustomerAiShadowVariantGateResult {
    return {
      provider: variant.provider,
      model: variant.model,
      reasoningEffort: variant.reasoningEffort,
      maxOutputTokens: variant.maxOutputTokens,
      maxContextMessages: variant.maxContextMessages,
      promptVersion: variant.promptVersion,
      policyVersion: variant.policyVersion,
      toolContractVersion: variant.toolContractVersion,
      responseContractVersion: variant.responseContractVersion,
      status,
      reasonCodes,
      observed,
    };
  }
}

function toObservedMetrics(
  metrics: CustomerAiShadowVariantMetrics,
): CustomerAiShadowGateObservedMetrics {
  return {
    totalRuns: metrics.totalRuns,
    evaluatedRuns: metrics.evaluatedRuns,
    failedRuns: metrics.failedRuns,
    failureRate: rate(metrics.failedRuns, metrics.evaluatedRuns),
    providerFailureRuns: metrics.providerFailureRuns,
    providerFailureRate: rate(
      metrics.providerFailureRuns,
      metrics.evaluatedRuns,
    ),
    schemaFailureRuns: metrics.schemaFailureRuns,
    schemaFailureRate: rate(metrics.schemaFailureRuns, metrics.evaluatedRuns),
    toolFailureRuns: metrics.toolFailureRuns,
    toolFailureRate: rate(metrics.toolFailureRuns, metrics.evaluatedRuns),
    supersededRuns: metrics.supersededRuns,
    supersededRate: rate(metrics.supersededRuns, metrics.evaluatedRuns),
    handoffRuns: metrics.handoffRuns,
    handoffRate: rate(metrics.handoffRuns, metrics.evaluatedRuns),
    criticalSafetyViolationRuns: metrics.criticalSafetyViolationRuns,
    p95LatencyMs: metrics.p95LatencyMs,
    averageCostMinorUnit: average(
      metrics.estimatedCostMinorUnit,
      metrics.evaluatedRuns,
    ),
  };
}

function percentToRate(percent: number): number {
  return percent / 100;
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : roundToFourDecimals(count / total);
}

function average(total: number, count: number): number {
  return count === 0 ? 0 : roundToFourDecimals(total / count);
}

function exceedsRate(
  count: number,
  total: number,
  maximumRate: number,
): boolean {
  return total > 0 && count / total > maximumRate;
}

function exceedsAverage(
  total: number,
  count: number,
  maximum: number,
): boolean {
  return count > 0 && total / count > maximum;
}

function roundToFourDecimals(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
