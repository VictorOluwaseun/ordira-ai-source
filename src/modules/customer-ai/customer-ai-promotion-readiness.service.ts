import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { customerAiConfig } from '@config/customer-ai.config';
import { CustomerAiEvaluationEvidenceRepository } from './customer-ai-evaluation-evidence.repository';
import { CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS } from './customer-ai-runtime-safety-evidence';
import type {
  CustomerAiShadowGateReasonCode,
  CustomerAiShadowGateStatus,
  CustomerAiShadowPromotionGateResult,
  CustomerAiShadowVariantGateResult,
  CustomerAiShadowVariantIdentity,
} from './customer-ai-shadow-promotion-gate.service';
import type { CustomerAiEvaluationEvidence } from './schemas/customer-ai-evaluation-evidence.schema';

export type CustomerAiPromotionReadinessStatus =
  | 'insufficient_data'
  | 'blocked'
  | 'ready_for_human_review';

export type CustomerAiPromotionReadinessReasonCode =
  | 'shadow_telemetry_insufficient'
  | 'shadow_telemetry_blocked'
  | 'evaluation_dataset_not_approved'
  | 'evaluation_evidence_missing'
  | 'evaluation_evidence_stale'
  | 'evaluation_variant_contract_mismatch'
  | 'evaluation_contract_version_mismatch'
  | 'evaluation_dataset_version_mismatch'
  | 'evaluation_dataset_hash_mismatch'
  | 'evaluation_fixture_count_below_minimum'
  | 'evaluation_trial_count_below_minimum'
  | 'evaluation_critical_failures_observed'
  | 'evaluation_failure_bound_exceeded'
  | 'evaluation_quality_ceiling_regression'
  | 'evaluation_report_rejected'
  | 'release_source_revision_not_configured'
  | 'source_revision_evidence_missing'
  | 'evaluation_runtime_source_revision_mismatch'
  | 'release_source_revision_mismatch'
  | 'runtime_safety_report_not_approved'
  | 'runtime_safety_evidence_missing'
  | 'runtime_safety_evidence_stale'
  | 'runtime_safety_contract_version_mismatch'
  | 'runtime_safety_report_hash_mismatch'
  | 'runtime_safety_checks_incomplete';

export type CustomerAiPromotionEvaluationSummary = {
  comparisonId: string;
  variantId: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  maxOutputTokens: number;
  maxContextMessages: number;
  promptVersion: string;
  policyVersion: string;
  toolContractVersion: string;
  responseContractVersion: string;
  evaluationContractVersion: string;
  datasetVersion: string;
  datasetSha256: string;
  evaluatedAt: string;
  fixtureCount: number;
  trialCountPerFixture: number;
  totalTrials: number;
  failures: number;
  failureRate: number;
  oneSided95FailureRateUpperBound: number;
  criticalFailures: number;
  evaluationSourceRevision: string | null;
  runtimeSafetyContractVersion: string | null;
  runtimeSafetyReportSha256: string | null;
  runtimeSafetySourceRevision: string | null;
  runtimeSafetyExecutedAt: string | null;
  runtimeSafetyChecks: string[];
  averageLatencyMs: number | null;
  totalEstimatedCostMinorUnit: number;
  failureRateDeltaFromCeiling: number;
  qualityCeilingVariantId: string;
  promotable: boolean;
  rejectionReasons: string[];
};

export type CustomerAiPromotionReadinessResult = {
  scope: 'shadow_model_and_runtime_evaluation';
  selectedRangeOnly: true;
  automaticActivation: false;
  humanApprovalRequired: true;
  expectedEvaluation: {
    evaluationContractVersion: string;
    datasetVersion: string;
    datasetSha256: string | null;
    evidenceMaxAgeDays: number;
    minimumFixtures: number;
    minimumTrialsPerFixture: number;
    maxFailureRateUpperBound: number;
    maxFailureRateDeltaFromCeiling: number;
    maxCriticalFailures: 0;
    runtimeSafetyContractVersion: string;
    runtimeSafetyReportSha256: string | null;
    releaseSourceRevision: string | null;
  };
  variants: Array<
    CustomerAiShadowVariantIdentity & {
      status: CustomerAiPromotionReadinessStatus;
      reasonCodes: CustomerAiPromotionReadinessReasonCode[];
      shadow: {
        status: CustomerAiShadowGateStatus;
        reasonCodes: CustomerAiShadowGateReasonCode[];
      };
      evaluation: CustomerAiPromotionEvaluationSummary | null;
    }
  >;
};

/**
 * Joins production shadow telemetry to the global repeated-evaluation ledger.
 *
 * Matching is deliberately exact across model, reasoning, output/context
 * budgets, prompt, policy, and both tool/response contracts. The service is
 * read-only and returns review evidence; it cannot change rollout config.
 */
@Injectable()
export class CustomerAiPromotionReadinessService {
  private readonly expected: CustomerAiPromotionReadinessResult['expectedEvaluation'];

  constructor(
    @Inject(customerAiConfig.KEY)
    config: ConfigType<typeof customerAiConfig>,
    private readonly evidenceRepository: CustomerAiEvaluationEvidenceRepository,
  ) {
    this.expected = {
      evaluationContractVersion: config.evaluationContractVersion,
      datasetVersion: config.evaluationDatasetVersion,
      datasetSha256: config.evaluationDatasetSha256,
      evidenceMaxAgeDays: config.evaluationEvidenceMaxAgeDays,
      minimumFixtures: config.evaluationGateMinFixtures,
      minimumTrialsPerFixture: config.evaluationGateMinTrialsPerFixture,
      maxFailureRateUpperBound: percentToRate(
        config.evaluationGateMaxFailureRateUpperBoundPercent,
      ),
      maxFailureRateDeltaFromCeiling: percentToRate(
        config.evaluationGateMaxFailureRateDeltaPercent,
      ),
      maxCriticalFailures: 0,
      runtimeSafetyContractVersion: config.runtimeSafetyContractVersion,
      runtimeSafetyReportSha256: config.runtimeSafetyReportSha256,
      releaseSourceRevision: config.releaseSourceRevision,
    };
  }

  async evaluate(
    shadowPromotion: CustomerAiShadowPromotionGateResult,
    now = new Date(),
  ): Promise<CustomerAiPromotionReadinessResult> {
    const evidence = await this.evidenceRepository.findLatestBehavioralVariants(
      shadowPromotion.variants,
    );

    return {
      scope: 'shadow_model_and_runtime_evaluation',
      selectedRangeOnly: true,
      automaticActivation: false,
      humanApprovalRequired: true,
      expectedEvaluation: { ...this.expected },
      variants: shadowPromotion.variants.map((shadow) =>
        this.evaluateVariant(shadow, evidence, now),
      ),
    };
  }

  private evaluateVariant(
    shadow: CustomerAiShadowVariantGateResult,
    evidence: CustomerAiEvaluationEvidence[],
    now: Date,
  ): CustomerAiPromotionReadinessResult['variants'][number] {
    const exactEvidence = newestEvidence(
      evidence.filter((candidate) => exactIdentity(candidate, shadow)),
    );
    const baseEvidence = newestEvidence(
      evidence.filter((candidate) => baseIdentity(candidate, shadow)),
    );
    const selectedEvidence = exactEvidence ?? baseEvidence;
    const reasons: CustomerAiPromotionReadinessReasonCode[] = [];
    let blocked = false;
    let insufficient = false;

    if (shadow.status === 'blocked') {
      reasons.push('shadow_telemetry_blocked');
      blocked = true;
    } else if (shadow.status === 'insufficient_data') {
      reasons.push('shadow_telemetry_insufficient');
      insufficient = true;
    }

    if (!this.expected.datasetSha256) {
      reasons.push('evaluation_dataset_not_approved');
      insufficient = true;
    }
    if (!this.expected.runtimeSafetyReportSha256) {
      reasons.push('runtime_safety_report_not_approved');
      insufficient = true;
    }
    if (!this.expected.releaseSourceRevision) {
      reasons.push('release_source_revision_not_configured');
      insufficient = true;
    }
    if (!selectedEvidence) {
      reasons.push('evaluation_evidence_missing');
      insufficient = true;
    } else if (!exactEvidence) {
      reasons.push('evaluation_variant_contract_mismatch');
      blocked = true;
    } else {
      const evaluation = exactEvidence;
      if (isStale(evaluation, now, this.expected.evidenceMaxAgeDays)) {
        reasons.push('evaluation_evidence_stale');
        insufficient = true;
      }
      if (
        evaluation.evaluationContractVersion !==
        this.expected.evaluationContractVersion
      ) {
        reasons.push('evaluation_contract_version_mismatch');
        blocked = true;
      }
      if (evaluation.datasetVersion !== this.expected.datasetVersion) {
        reasons.push('evaluation_dataset_version_mismatch');
        blocked = true;
      }
      if (
        this.expected.datasetSha256 &&
        evaluation.datasetSha256 !== this.expected.datasetSha256
      ) {
        reasons.push('evaluation_dataset_hash_mismatch');
        blocked = true;
      }
      if (evaluation.fixtureCount < this.expected.minimumFixtures) {
        reasons.push('evaluation_fixture_count_below_minimum');
        insufficient = true;
      }
      if (
        evaluation.trialCountPerFixture < this.expected.minimumTrialsPerFixture
      ) {
        reasons.push('evaluation_trial_count_below_minimum');
        insufficient = true;
      }
      if (evaluation.criticalFailures > 0) {
        reasons.push('evaluation_critical_failures_observed');
        blocked = true;
      }
      if (
        evaluation.oneSided95FailureRateUpperBound >
        this.expected.maxFailureRateUpperBound
      ) {
        reasons.push('evaluation_failure_bound_exceeded');
        blocked = true;
      }
      if (
        evaluation.failureRateDeltaFromCeiling >
        this.expected.maxFailureRateDeltaFromCeiling
      ) {
        reasons.push('evaluation_quality_ceiling_regression');
        blocked = true;
      }
      if (!evaluation.promotable || evaluation.rejectionReasons.length > 0) {
        reasons.push('evaluation_report_rejected');
        blocked = true;
      }
      const evaluationSourceRevision =
        evaluation.evaluationSourceRevision?.toLowerCase() ?? null;
      const runtimeSafetySourceRevision =
        evaluation.runtimeSafetySourceRevision?.toLowerCase() ?? null;
      if (!evaluationSourceRevision || !runtimeSafetySourceRevision) {
        reasons.push('source_revision_evidence_missing');
        insufficient = true;
      } else {
        if (evaluationSourceRevision !== runtimeSafetySourceRevision) {
          reasons.push('evaluation_runtime_source_revision_mismatch');
          blocked = true;
        }
        if (
          this.expected.releaseSourceRevision &&
          (evaluationSourceRevision !== this.expected.releaseSourceRevision ||
            runtimeSafetySourceRevision !== this.expected.releaseSourceRevision)
        ) {
          reasons.push('release_source_revision_mismatch');
          blocked = true;
        }
      }
      if (
        !evaluation.runtimeSafetyContractVersion ||
        !evaluation.runtimeSafetyReportSha256 ||
        !evaluation.runtimeSafetyExecutedAt
      ) {
        reasons.push('runtime_safety_evidence_missing');
        insufficient = true;
      } else {
        if (
          evaluation.runtimeSafetyContractVersion !==
          this.expected.runtimeSafetyContractVersion
        ) {
          reasons.push('runtime_safety_contract_version_mismatch');
          blocked = true;
        }
        if (
          this.expected.runtimeSafetyReportSha256 &&
          evaluation.runtimeSafetyReportSha256 !==
            this.expected.runtimeSafetyReportSha256
        ) {
          reasons.push('runtime_safety_report_hash_mismatch');
          blocked = true;
        }
        if (
          isStaleDate(
            evaluation.runtimeSafetyExecutedAt,
            now,
            this.expected.evidenceMaxAgeDays,
          )
        ) {
          reasons.push('runtime_safety_evidence_stale');
          insufficient = true;
        }
        if (!hasEveryRuntimeSafetyCheck(evaluation.runtimeSafetyChecks ?? [])) {
          reasons.push('runtime_safety_checks_incomplete');
          blocked = true;
        }
      }
    }

    return {
      provider: shadow.provider,
      model: shadow.model,
      reasoningEffort: shadow.reasoningEffort,
      maxOutputTokens: shadow.maxOutputTokens,
      maxContextMessages: shadow.maxContextMessages,
      promptVersion: shadow.promptVersion,
      policyVersion: shadow.policyVersion,
      toolContractVersion: shadow.toolContractVersion,
      responseContractVersion: shadow.responseContractVersion,
      status: readinessStatus(blocked, insufficient),
      reasonCodes: reasons,
      shadow: {
        status: shadow.status,
        reasonCodes: [...shadow.reasonCodes],
      },
      evaluation: selectedEvidence ? summarize(selectedEvidence) : null,
    };
  }
}

function exactIdentity(
  evidence: CustomerAiEvaluationEvidence,
  shadow: CustomerAiShadowVariantIdentity,
): boolean {
  return (
    baseIdentity(evidence, shadow) &&
    evidence.maxOutputTokens === shadow.maxOutputTokens &&
    evidence.maxContextMessages === shadow.maxContextMessages &&
    evidence.promptVersion === shadow.promptVersion &&
    evidence.policyVersion === shadow.policyVersion &&
    evidence.toolContractVersion === shadow.toolContractVersion &&
    evidence.responseContractVersion === shadow.responseContractVersion
  );
}

function baseIdentity(
  evidence: CustomerAiEvaluationEvidence,
  shadow: CustomerAiShadowVariantIdentity,
): boolean {
  return (
    evidence.provider === shadow.provider &&
    evidence.model === shadow.model &&
    evidence.reasoningEffort === shadow.reasoningEffort
  );
}

function newestEvidence(
  evidence: CustomerAiEvaluationEvidence[],
): CustomerAiEvaluationEvidence | null {
  return (
    [...evidence].sort(
      (left, right) => right.evaluatedAt.getTime() - left.evaluatedAt.getTime(),
    )[0] ?? null
  );
}

function isStale(
  evidence: CustomerAiEvaluationEvidence,
  now: Date,
  maximumAgeDays: number,
): boolean {
  const maximumAgeMs = maximumAgeDays * 24 * 60 * 60 * 1000;
  return evidence.evaluatedAt.getTime() < now.getTime() - maximumAgeMs;
}

function isStaleDate(
  evidenceDate: Date,
  now: Date,
  maximumAgeDays: number,
): boolean {
  const maximumAgeMs = maximumAgeDays * 24 * 60 * 60 * 1000;
  return evidenceDate.getTime() < now.getTime() - maximumAgeMs;
}

function hasEveryRuntimeSafetyCheck(checks: string[]): boolean {
  return (
    checks.length === CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS.length &&
    CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS.every((check) =>
      checks.includes(check),
    )
  );
}

function summarize(
  evidence: CustomerAiEvaluationEvidence,
): CustomerAiPromotionEvaluationSummary {
  return {
    comparisonId: evidence.comparisonId,
    variantId: evidence.variantId,
    provider: evidence.provider,
    model: evidence.model,
    reasoningEffort: evidence.reasoningEffort,
    maxOutputTokens: evidence.maxOutputTokens,
    maxContextMessages: evidence.maxContextMessages,
    promptVersion: evidence.promptVersion,
    policyVersion: evidence.policyVersion,
    toolContractVersion: evidence.toolContractVersion,
    responseContractVersion: evidence.responseContractVersion,
    evaluationContractVersion: evidence.evaluationContractVersion,
    datasetVersion: evidence.datasetVersion,
    datasetSha256: evidence.datasetSha256,
    evaluatedAt: evidence.evaluatedAt.toISOString(),
    fixtureCount: evidence.fixtureCount,
    trialCountPerFixture: evidence.trialCountPerFixture,
    totalTrials: evidence.totalTrials,
    failures: evidence.failures,
    failureRate: evidence.failureRate,
    oneSided95FailureRateUpperBound: evidence.oneSided95FailureRateUpperBound,
    criticalFailures: evidence.criticalFailures,
    evaluationSourceRevision: evidence.evaluationSourceRevision ?? null,
    runtimeSafetyContractVersion: evidence.runtimeSafetyContractVersion ?? null,
    runtimeSafetyReportSha256: evidence.runtimeSafetyReportSha256 ?? null,
    runtimeSafetySourceRevision: evidence.runtimeSafetySourceRevision ?? null,
    runtimeSafetyExecutedAt:
      evidence.runtimeSafetyExecutedAt?.toISOString() ?? null,
    runtimeSafetyChecks: [...(evidence.runtimeSafetyChecks ?? [])],
    averageLatencyMs: evidence.averageLatencyMs ?? null,
    totalEstimatedCostMinorUnit: evidence.totalEstimatedCostMinorUnit,
    failureRateDeltaFromCeiling: evidence.failureRateDeltaFromCeiling,
    qualityCeilingVariantId: evidence.qualityCeilingVariantId,
    promotable: evidence.promotable,
    rejectionReasons: [...evidence.rejectionReasons],
  };
}

function percentToRate(percent: number): number {
  return percent / 100;
}

function readinessStatus(
  blocked: boolean,
  insufficient: boolean,
): CustomerAiPromotionReadinessStatus {
  if (blocked) {
    return 'blocked';
  }
  if (insufficient) {
    return 'insufficient_data';
  }

  return 'ready_for_human_review';
}
