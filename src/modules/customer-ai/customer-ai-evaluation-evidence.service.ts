import { Injectable } from '@nestjs/common';
import { sha256 } from '@common/utils/crypto.util';
import { createStableStringifier } from '@common/utils/json.util';
import type { CustomerAiModelComparisonReport } from './evals/customer-ai-model-comparison';
import {
  CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS,
  type CustomerAiRuntimeSafetyEvidence,
} from './customer-ai-runtime-safety-evidence';
import { customerAiEvalFailureRateUpperBound } from './evals/customer-ai-eval-runner';
import {
  CustomerAiEvaluationEvidenceRepository,
  type CustomerAiEvaluationEvidenceRecord,
} from './customer-ai-evaluation-evidence.repository';

const stableStringify = createStableStringifier({
  undefinedValue: 'null',
  omitUndefinedObjectProperties: true,
});
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40,64}$/i;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type RecordCustomerAiEvaluationComparisonInput = {
  comparisonId: string;
  sourceRevision: string;
  evaluationContractVersion: string;
  runtimeSafetyEvidence: CustomerAiRuntimeSafetyEvidence;
  report: CustomerAiModelComparisonReport;
  evaluatedAt?: Date;
};

/**
 * Validates and records one complete repeated-evaluation comparison.
 *
 * This service is intentionally not exposed by an HTTP controller. A trusted,
 * opt-in evaluator obtains it from the application context after provider
 * trials finish. Runtime traffic and workspace users therefore cannot attest
 * their own model evidence.
 */
@Injectable()
export class CustomerAiEvaluationEvidenceService {
  constructor(
    private readonly evidenceRepository: CustomerAiEvaluationEvidenceRepository,
  ) {}

  async recordComparison(
    input: RecordCustomerAiEvaluationComparisonInput,
  ): Promise<{
    comparisonId: string;
    evidenceCount: number;
    datasetVersion: string;
    datasetSha256: string;
    evaluatedAt: string;
  }> {
    validateInput(input);
    const evaluatedAt = input.evaluatedAt ?? new Date();
    const records = input.report.variants.map((result) => {
      const recordWithoutHash: Omit<
        CustomerAiEvaluationEvidenceRecord,
        'evidenceSha256'
      > = {
        comparisonId: input.comparisonId,
        variantId: result.variant.id,
        provider: result.variant.provider,
        model: result.variant.model,
        reasoningEffort: result.variant.reasoningEffort,
        maxOutputTokens: result.variant.maxOutputTokens,
        maxContextMessages: result.variant.maxContextMessages,
        inputCostPerMillionMinorUnit:
          result.variant.inputCostPerMillionMinorUnit,
        outputCostPerMillionMinorUnit:
          result.variant.outputCostPerMillionMinorUnit,
        promptVersion: result.variant.promptVersion,
        policyVersion: result.variant.policyVersion,
        toolContractVersion: result.variant.toolContractVersion,
        responseContractVersion: result.variant.responseContractVersion,
        evaluationContractVersion: input.evaluationContractVersion,
        datasetVersion: input.report.datasetVersion,
        datasetSha256: input.report.datasetSha256,
        fixtureCount: input.report.fixtureCount,
        trialCountPerFixture: input.report.trialCountPerFixture,
        totalTrials: result.evaluation.totalTrials,
        failures: result.evaluation.failures,
        failureRate: result.evaluation.failureRate,
        oneSided95FailureRateUpperBound:
          result.evaluation.oneSided95FailureRateUpperBound,
        criticalFailures: result.evaluation.criticalFailures,
        evaluationSourceRevision: input.sourceRevision.toLowerCase(),
        runtimeSafetyContractVersion:
          input.runtimeSafetyEvidence.contractVersion,
        runtimeSafetyReportSha256: input.runtimeSafetyEvidence.reportSha256,
        runtimeSafetySourceRevision:
          input.runtimeSafetyEvidence.sourceRevision.toLowerCase(),
        runtimeSafetyExecutedAt: input.runtimeSafetyEvidence.executedAt,
        runtimeSafetyChecks: [...input.runtimeSafetyEvidence.checks],
        averageLatencyMs: result.averageLatencyMs,
        totalEstimatedCostMinorUnit: result.totalEstimatedCostMinorUnit,
        failureRateDeltaFromCeiling: result.failureRateDeltaFromCeiling,
        qualityCeilingVariantId: input.report.qualityCeilingVariantId,
        promotable: result.promotable,
        rejectionReasons: [...result.rejectionReasons],
        cases: result.evaluation.cases.map((caseResult) => ({
          ...caseResult,
        })),
        evaluatedAt,
      };

      return {
        ...recordWithoutHash,
        evidenceSha256: sha256(stableStringify(recordWithoutHash)),
      };
    });

    await this.evidenceRepository.recordComparison(records);

    return {
      comparisonId: input.comparisonId,
      evidenceCount: records.length,
      datasetVersion: input.report.datasetVersion,
      datasetSha256: input.report.datasetSha256,
      evaluatedAt: evaluatedAt.toISOString(),
    };
  }
}

function validateInput(input: RecordCustomerAiEvaluationComparisonInput): void {
  if (!SAFE_ID.test(input.comparisonId)) {
    throw new Error('Customer AI evaluation comparisonId is invalid');
  }
  if (
    !input.evaluationContractVersion.trim() ||
    input.evaluationContractVersion.length > 120
  ) {
    throw new Error('Customer AI evaluation contract version is invalid');
  }
  const runtime = input.runtimeSafetyEvidence;
  if (
    !runtime.contractVersion.trim() ||
    runtime.contractVersion.length > 120 ||
    !SHA256.test(runtime.reportSha256) ||
    !REVISION.test(runtime.sourceRevision) ||
    !Number.isFinite(runtime.executedAt.getTime()) ||
    runtime.executedAt.getTime() > Date.now() + MAX_FUTURE_CLOCK_SKEW_MS ||
    runtime.checks.length !==
      CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS.length ||
    CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS.some(
      (check) => !runtime.checks.includes(check),
    )
  ) {
    throw new Error('Customer AI runtime safety evidence is invalid');
  }
  if (
    !REVISION.test(input.sourceRevision) ||
    input.sourceRevision.toLowerCase() !== runtime.sourceRevision.toLowerCase()
  ) {
    throw new Error(
      'Customer AI evaluation and runtime safety revisions must match',
    );
  }
  const evaluatedAt = input.evaluatedAt ?? new Date();
  if (
    !Number.isFinite(evaluatedAt.getTime()) ||
    evaluatedAt.getTime() > Date.now() + MAX_FUTURE_CLOCK_SKEW_MS
  ) {
    throw new Error('Customer AI evaluation timestamp is invalid');
  }

  const { report } = input;
  if (!report.datasetVersion.trim() || !SHA256.test(report.datasetSha256)) {
    throw new Error('Customer AI evaluation dataset identity is invalid');
  }
  if (
    !positiveInteger(report.fixtureCount) ||
    !positiveInteger(report.trialCountPerFixture) ||
    report.variants.length === 0 ||
    !report.variants.some(
      ({ variant }) => variant.id === report.qualityCeilingVariantId,
    )
  ) {
    throw new Error('Customer AI evaluation report shape is invalid');
  }
  if (
    !rate(report.thresholds.maxFailureRateUpperBound) ||
    !rate(report.thresholds.maxFailureRateDeltaFromCeiling)
  ) {
    throw new Error('Customer AI evaluation report thresholds are invalid');
  }

  const variantIds = new Set<string>();
  const ceiling = report.variants.find(
    ({ variant }) => variant.id === report.qualityCeilingVariantId,
  );
  if (!ceiling) {
    throw new Error('Customer AI evaluation report shape is invalid');
  }
  for (const result of report.variants) {
    if (!SAFE_ID.test(result.variant.id) || variantIds.has(result.variant.id)) {
      throw new Error('Customer AI evaluation variant identity is invalid');
    }
    variantIds.add(result.variant.id);
    validateVariantResult(report, result, ceiling.evaluation.failureRate);
  }
}

function validateVariantResult(
  report: CustomerAiModelComparisonReport,
  result: CustomerAiModelComparisonReport['variants'][number],
  ceilingFailureRate: number,
): void {
  const { variant, evaluation } = result;
  if (
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
    throw new Error('Customer AI evaluation variant contracts are invalid');
  }
  if (
    evaluation.fixtureCount !== report.fixtureCount ||
    evaluation.trialCountPerFixture !== report.trialCountPerFixture ||
    evaluation.totalTrials !==
      report.fixtureCount * report.trialCountPerFixture ||
    evaluation.cases.length !== report.fixtureCount ||
    !nonNegativeInteger(evaluation.failures) ||
    evaluation.failures > evaluation.totalTrials ||
    !rate(evaluation.failureRate) ||
    !approximatelyEqual(
      evaluation.failureRate,
      evaluation.failures / evaluation.totalTrials,
    ) ||
    !rate(evaluation.oneSided95FailureRateUpperBound) ||
    !approximatelyEqual(
      evaluation.oneSided95FailureRateUpperBound,
      customerAiEvalFailureRateUpperBound(
        evaluation.failures,
        evaluation.totalTrials,
      ),
    ) ||
    !nonNegativeInteger(evaluation.criticalFailures) ||
    evaluation.criticalFailures > evaluation.failures
  ) {
    throw new Error('Customer AI repeated evaluation totals are invalid');
  }

  const caseFailures = evaluation.cases.reduce(
    (total, caseResult) => total + caseResult.failures,
    0,
  );
  const criticalFailures = evaluation.cases.reduce(
    (total, caseResult) =>
      total + (caseResult.risk === 'critical' ? caseResult.failures : 0),
    0,
  );
  if (
    caseFailures !== evaluation.failures ||
    criticalFailures !== evaluation.criticalFailures ||
    evaluation.cases.some(
      (caseResult) =>
        !caseResult.fixtureId ||
        caseResult.trials !== report.trialCountPerFixture ||
        !nonNegativeInteger(caseResult.failures) ||
        caseResult.failures > caseResult.trials ||
        !rate(caseResult.failureRate) ||
        !approximatelyEqual(
          caseResult.failureRate,
          caseResult.failures / caseResult.trials,
        ) ||
        !rate(caseResult.oneSided95FailureRateUpperBound) ||
        !approximatelyEqual(
          caseResult.oneSided95FailureRateUpperBound,
          customerAiEvalFailureRateUpperBound(
            caseResult.failures,
            caseResult.trials,
          ),
        ),
    )
  ) {
    throw new Error('Customer AI repeated evaluation cases are invalid');
  }
  if (
    (result.averageLatencyMs !== null &&
      (!Number.isFinite(result.averageLatencyMs) ||
        result.averageLatencyMs < 0)) ||
    !nonNegativeInteger(result.totalEstimatedCostMinorUnit) ||
    !Number.isFinite(result.failureRateDeltaFromCeiling) ||
    result.failureRateDeltaFromCeiling < -1 ||
    result.failureRateDeltaFromCeiling > 1 ||
    !approximatelyEqual(
      result.failureRateDeltaFromCeiling,
      evaluation.failureRate - ceilingFailureRate,
    ) ||
    !sameStrings(
      result.rejectionReasons,
      expectedRejectionReasons(report, result),
    ) ||
    result.promotable !== (result.rejectionReasons.length === 0)
  ) {
    throw new Error('Customer AI evaluation variant metrics are invalid');
  }
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function rate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function expectedRejectionReasons(
  report: CustomerAiModelComparisonReport,
  result: CustomerAiModelComparisonReport['variants'][number],
): string[] {
  const reasons: string[] = [];
  if (result.evaluation.criticalFailures > 0) {
    reasons.push('critical_failures');
  }
  if (
    result.evaluation.oneSided95FailureRateUpperBound >
    report.thresholds.maxFailureRateUpperBound
  ) {
    reasons.push('failure_rate_upper_bound');
  }
  if (
    result.failureRateDeltaFromCeiling >
    report.thresholds.maxFailureRateDeltaFromCeiling
  ) {
    reasons.push('quality_ceiling_regression');
  }

  return reasons;
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-12;
}
