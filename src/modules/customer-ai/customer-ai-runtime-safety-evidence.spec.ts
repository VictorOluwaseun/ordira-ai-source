import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@common/utils/crypto.util';
import { createStableStringifier } from '@common/utils/json.util';
import {
  CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS,
  inspectCustomerAiRuntimeSafetyReport,
  loadCustomerAiRuntimeSafetyEvidence,
} from './customer-ai-runtime-safety-evidence';

const stableStringify = createStableStringifier({
  undefinedValue: 'null',
  omitUndefinedObjectProperties: true,
});
const SOURCE_REVISION = '371761c6533118b360e6a5816e6c8e079367344d';

describe('customer AI runtime safety evidence', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts only a complete approved integration report', () => {
    const report = runtimeReport();
    const reportPath = writeReport(report);
    const approvedReportSha256 = sha256(stableStringify(report));

    expect(
      loadCustomerAiRuntimeSafetyEvidence({
        reportPath,
        expectedContractVersion: 'customer-ai-runtime-safety-v1',
        approvedReportSha256,
        expectedSourceRevision: SOURCE_REVISION,
        now: new Date('2026-09-01T12:00:00.000Z'),
      }),
    ).toEqual({
      contractVersion: 'customer-ai-runtime-safety-v1',
      reportSha256: approvedReportSha256,
      sourceRevision: '371761c6533118b360e6a5816e6c8e079367344d',
      executedAt: new Date('2026-09-01T11:00:00.000Z'),
      checks: CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS,
    });
  });

  it('exposes a validated digest for separate human approval', () => {
    const report = runtimeReport();
    const reportPath = writeReport(report);

    expect(
      inspectCustomerAiRuntimeSafetyReport({
        reportPath,
        expectedContractVersion: 'customer-ai-runtime-safety-v1',
        now: new Date('2026-09-01T12:00:00.000Z'),
      }),
    ).toMatchObject({
      reportSha256: sha256(stableStringify(report)),
      sourceRevision: report.sourceRevision,
      checks: CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS,
    });
  });

  it('rejects missing checks and an unapproved digest', () => {
    const incomplete = runtimeReport();
    incomplete.checks.pop();
    const incompletePath = writeReport(incomplete);

    expect(() =>
      loadCustomerAiRuntimeSafetyEvidence({
        reportPath: incompletePath,
        expectedContractVersion: 'customer-ai-runtime-safety-v1',
        approvedReportSha256: sha256(stableStringify(incomplete)),
        expectedSourceRevision: SOURCE_REVISION,
      }),
    ).toThrow('checks are incomplete');

    const complete = runtimeReport();
    const completePath = writeReport(complete);
    expect(() =>
      loadCustomerAiRuntimeSafetyEvidence({
        reportPath: completePath,
        expectedContractVersion: 'customer-ai-runtime-safety-v1',
        approvedReportSha256: 'f'.repeat(64),
        expectedSourceRevision: SOURCE_REVISION,
      }),
    ).toThrow('hash is not approved');
  });

  it('rejects an approved report produced from another source revision', () => {
    const report = runtimeReport();
    const reportPath = writeReport(report);

    expect(() =>
      loadCustomerAiRuntimeSafetyEvidence({
        reportPath,
        expectedContractVersion: 'customer-ai-runtime-safety-v1',
        approvedReportSha256: sha256(stableStringify(report)),
        expectedSourceRevision: 'f'.repeat(40),
      }),
    ).toThrow('source revision does not match the evaluator');
  });

  function writeReport(report: ReturnType<typeof runtimeReport>): string {
    const directory = mkdtempSync(join(tmpdir(), 'ordira-ai-runtime-'));
    directories.push(directory);
    const path = join(directory, 'report.json');
    writeFileSync(path, JSON.stringify(report));
    return path;
  }
});

function runtimeReport() {
  return {
    contractVersion: 'customer-ai-runtime-safety-v1',
    sourceRevision: SOURCE_REVISION,
    executedAt: '2026-09-01T11:00:00.000Z',
    environment: 'integration' as const,
    checks: CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS.map((id) => ({
      id,
      passed: true,
      attempts: 3,
    })),
  };
}
