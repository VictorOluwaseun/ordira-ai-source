import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256 } from '@common/utils/crypto.util';
import { createStableStringifier } from '@common/utils/json.util';

const stableStringify = createStableStringifier({
  undefinedValue: 'null',
  omitUndefinedObjectProperties: true,
});
const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40,64}$/i;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Guarantees that must come from the real Mongo/Redis/queue/dispatcher suite.
 * Model fixtures may describe these cases, but they cannot attest these IDs.
 */
export const CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS = [
  'causal_outbound_dispatch_guard',
  'causal_outbound_dispatch_race',
  'causal_shadow_post_state',
  'provider_breaker_generation_concurrency',
  'queue_recovery_after_startup_redis_outage',
  'run_fencing_after_lease_takeover',
  'spend_guard_atomic_idempotency',
  'tool_audit_fencing_after_takeover',
] as const;

export type CustomerAiRuntimeSafetyCheckId =
  (typeof CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS)[number];

export type CustomerAiRuntimeSafetyEvidence = {
  contractVersion: string;
  reportSha256: string;
  sourceRevision: string;
  executedAt: Date;
  checks: CustomerAiRuntimeSafetyCheckId[];
};

type RuntimeSafetyReport = {
  contractVersion: string;
  sourceRevision: string;
  executedAt: string;
  environment: 'integration';
  checks: Array<{
    id: string;
    passed: boolean;
    attempts: number;
  }>;
};

/**
 * Loads a CI-produced runtime report before any evaluation provider call.
 * The complete canonical report is hashed and must match the operator-approved
 * digest, preventing a model-eval command from inventing runtime evidence.
 */
export function loadCustomerAiRuntimeSafetyEvidence(input: {
  reportPath: string;
  expectedContractVersion: string;
  approvedReportSha256: string | null;
  expectedSourceRevision: string;
  now?: Date;
}): CustomerAiRuntimeSafetyEvidence {
  if (!input.approvedReportSha256 || !SHA256.test(input.approvedReportSha256)) {
    throw new Error(
      'CUSTOMER_AI_RUNTIME_SAFETY_REPORT_SHA256 approval is required to record evaluation evidence',
    );
  }
  const evidence = inspectCustomerAiRuntimeSafetyReport({
    reportPath: input.reportPath,
    expectedContractVersion: input.expectedContractVersion,
    now: input.now,
  });
  if (evidence.reportSha256 !== input.approvedReportSha256) {
    throw new Error('Customer AI runtime safety report hash is not approved');
  }
  if (
    !REVISION.test(input.expectedSourceRevision) ||
    evidence.sourceRevision !== input.expectedSourceRevision.toLowerCase()
  ) {
    throw new Error(
      'Customer AI runtime safety report source revision does not match the evaluator',
    );
  }

  return evidence;
}

/**
 * Validates a report and calculates the canonical digest an operator reviews.
 * Inspection grants no approval; recording still requires the same digest in
 * CUSTOMER_AI_RUNTIME_SAFETY_REPORT_SHA256.
 */
export function inspectCustomerAiRuntimeSafetyReport(input: {
  reportPath: string;
  expectedContractVersion: string;
  now?: Date;
}): CustomerAiRuntimeSafetyEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(input.reportPath), 'utf8'));
  } catch {
    throw new Error('Customer AI runtime safety report is unreadable');
  }
  const report = validateReport(
    parsed,
    input.expectedContractVersion,
    input.now ?? new Date(),
  );
  const reportSha256 = sha256(stableStringify(report));

  return {
    contractVersion: report.contractVersion,
    reportSha256,
    sourceRevision: report.sourceRevision.toLowerCase(),
    executedAt: new Date(report.executedAt),
    checks: [...CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS],
  };
}

function validateReport(
  value: unknown,
  expectedContractVersion: string,
  now: Date,
): RuntimeSafetyReport {
  if (!isRecord(value)) {
    throw new Error('Customer AI runtime safety report is invalid');
  }
  const report = value as Partial<RuntimeSafetyReport>;
  const executedAt = new Date(String(report.executedAt ?? ''));
  if (
    report.contractVersion !== expectedContractVersion ||
    report.environment !== 'integration' ||
    typeof report.sourceRevision !== 'string' ||
    !REVISION.test(report.sourceRevision) ||
    !Number.isFinite(executedAt.getTime()) ||
    executedAt.getTime() > now.getTime() + MAX_FUTURE_CLOCK_SKEW_MS ||
    !Array.isArray(report.checks)
  ) {
    throw new Error('Customer AI runtime safety report is invalid');
  }
  const checks = new Map<string, RuntimeSafetyReport['checks'][number]>();
  for (const check of report.checks) {
    if (
      !isRecord(check) ||
      typeof check.id !== 'string' ||
      !check.passed ||
      typeof check.attempts !== 'number' ||
      !Number.isSafeInteger(check.attempts) ||
      check.attempts < 1 ||
      checks.has(check.id)
    ) {
      throw new Error('Customer AI runtime safety report checks are invalid');
    }
    checks.set(check.id, {
      id: check.id,
      passed: true,
      attempts: check.attempts,
    });
  }
  if (
    checks.size !== CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS.length ||
    CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS.some((id) => !checks.has(id))
  ) {
    throw new Error('Customer AI runtime safety report checks are incomplete');
  }

  return report as RuntimeSafetyReport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
