import type {
  CustomerAiProviderName,
  CustomerAiReasoningEffort,
} from '@config/types/env.types';
import {
  customerAiEvalDatasetSha256,
  type CustomerAiEvalFixture,
  type CustomerAiRepeatedEvalReport,
  runRepeatedCustomerAiEvaluation,
} from './customer-ai-eval-runner';

export type CustomerAiModelVariant = {
  id: string;
  provider: CustomerAiProviderName;
  model: string;
  reasoningEffort: CustomerAiReasoningEffort;
  // The Responses API counts both reasoning and visible JSON against this
  // ceiling. It is therefore part of the behavioral identity, not merely an
  // execution detail, and must match the shadow deployment being approved.
  maxOutputTokens: number;
  // Stateless requests receive this many recent customer messages. Context
  // size can change both quality and cost, so it belongs to variant identity.
  maxContextMessages: number;
  // Pricing belongs to the evaluated variant, not the deployment-wide provider
  // config. Keeping it in the report makes cost comparisons reproducible when
  // models have different rates.
  inputCostPerMillionMinorUnit: number;
  outputCostPerMillionMinorUnit: number;
  promptVersion: string;
  policyVersion: string;
  toolContractVersion: string;
  responseContractVersion: string;
};

export type CustomerAiModelTrialResult = {
  passed: boolean;
  latencyMs?: number;
  estimatedCostMinorUnit?: number;
};

export type CustomerAiModelComparisonReport = {
  datasetVersion: string;
  datasetSha256: string;
  fixtureCount: number;
  trialCountPerFixture: number;
  qualityCeilingVariantId: string;
  thresholds: {
    maxFailureRateUpperBound: number;
    maxFailureRateDeltaFromCeiling: number;
  };
  variants: Array<{
    variant: CustomerAiModelVariant;
    evaluation: CustomerAiRepeatedEvalReport;
    averageLatencyMs: number | null;
    totalEstimatedCostMinorUnit: number;
    failureRateDeltaFromCeiling: number;
    promotable: boolean;
    rejectionReasons: string[];
  }>;
};

/**
 * Runs identical repeated fixtures against a quality-ceiling model followed by
 * candidate variants. The first variant is the explicit ceiling; candidates
 * are promoted only when they have no critical failures, satisfy the absolute
 * confidence bound, and remain close enough to ceiling quality.
 */
export async function runCustomerAiModelComparison(input: {
  fixtures: CustomerAiEvalFixture[];
  datasetVersion: string;
  trialCountPerFixture: number;
  concurrency?: number;
  variants: CustomerAiModelVariant[];
  maxFailureRateUpperBound: number;
  maxFailureRateDeltaFromCeiling: number;
  evaluate: (
    variant: CustomerAiModelVariant,
    fixture: CustomerAiEvalFixture,
    trial: number,
  ) => CustomerAiModelTrialResult | Promise<CustomerAiModelTrialResult>;
}): Promise<CustomerAiModelComparisonReport> {
  assertComparisonInput(input);
  const evaluated: Array<{
    variant: CustomerAiModelVariant;
    evaluation: CustomerAiRepeatedEvalReport;
    averageLatencyMs: number | null;
    totalEstimatedCostMinorUnit: number;
  }> = [];

  for (const variant of input.variants) {
    // Quality is always recorded. Latency/cost are optional because offline or
    // mocked graders may not have meaningful production telemetry.
    let latencyTotal = 0;
    let latencyCount = 0;
    let totalEstimatedCostMinorUnit = 0;
    const evaluation = await runRepeatedCustomerAiEvaluation(
      input.fixtures,
      input.trialCountPerFixture,
      async (fixture, trial) => {
        const result = await input.evaluate(variant, fixture, trial);
        if (
          result.latencyMs !== undefined &&
          Number.isFinite(result.latencyMs) &&
          result.latencyMs >= 0
        ) {
          latencyTotal += result.latencyMs;
          latencyCount += 1;
        }
        if (
          result.estimatedCostMinorUnit !== undefined &&
          Number.isSafeInteger(result.estimatedCostMinorUnit) &&
          result.estimatedCostMinorUnit >= 0
        ) {
          totalEstimatedCostMinorUnit += result.estimatedCostMinorUnit;
        }

        return result.passed;
      },
      { concurrency: input.concurrency },
    );
    evaluated.push({
      variant,
      evaluation,
      averageLatencyMs: latencyCount === 0 ? null : latencyTotal / latencyCount,
      totalEstimatedCostMinorUnit,
    });
  }

  // Ordering is a contract: callers put the most capable model first.
  const ceiling = evaluated[0];
  return {
    datasetVersion: input.datasetVersion,
    datasetSha256: customerAiEvalDatasetSha256(input.fixtures),
    fixtureCount: input.fixtures.length,
    trialCountPerFixture: input.trialCountPerFixture,
    qualityCeilingVariantId: ceiling.variant.id,
    thresholds: {
      maxFailureRateUpperBound: input.maxFailureRateUpperBound,
      maxFailureRateDeltaFromCeiling: input.maxFailureRateDeltaFromCeiling,
    },
    variants: evaluated.map((result) => {
      const failureRateDeltaFromCeiling =
        result.evaluation.failureRate - ceiling.evaluation.failureRate;
      const rejectionReasons: string[] = [];
      // Any critical failure is an absolute veto regardless of average quality.
      if (result.evaluation.criticalFailures > 0) {
        rejectionReasons.push('critical_failures');
      }
      if (
        result.evaluation.oneSided95FailureRateUpperBound >
        input.maxFailureRateUpperBound
      ) {
        rejectionReasons.push('failure_rate_upper_bound');
      }
      if (failureRateDeltaFromCeiling > input.maxFailureRateDeltaFromCeiling) {
        rejectionReasons.push('quality_ceiling_regression');
      }

      return {
        ...result,
        failureRateDeltaFromCeiling,
        promotable: rejectionReasons.length === 0,
        rejectionReasons,
      };
    }),
  };
}

function assertComparisonInput(input: {
  datasetVersion: string;
  variants: CustomerAiModelVariant[];
  maxFailureRateUpperBound: number;
  maxFailureRateDeltaFromCeiling: number;
}): void {
  if (!input.datasetVersion.trim()) {
    throw new Error('Customer AI evaluation dataset version is required');
  }
  if (input.variants.length === 0) {
    throw new Error('At least one customer AI model variant is required');
  }
  if (
    new Set(input.variants.map((variant) => variant.id)).size !==
    input.variants.length
  ) {
    throw new Error('Customer AI model variant IDs must be unique');
  }
  for (const variant of input.variants) {
    if (
      !variant.id.trim() ||
      !variant.model.trim() ||
      !positiveInteger(variant.maxOutputTokens) ||
      !positiveInteger(variant.maxContextMessages) ||
      !positiveInteger(variant.inputCostPerMillionMinorUnit) ||
      !positiveInteger(variant.outputCostPerMillionMinorUnit) ||
      !variant.promptVersion.trim() ||
      !variant.policyVersion.trim() ||
      !variant.toolContractVersion.trim() ||
      !variant.responseContractVersion.trim()
    ) {
      throw new Error(
        'Customer AI model variants require model and contract identities',
      );
    }
  }
  for (const threshold of [
    input.maxFailureRateUpperBound,
    input.maxFailureRateDeltaFromCeiling,
  ]) {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new Error(
        'Customer AI model comparison thresholds must be between 0 and 1',
      );
    }
  }
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
