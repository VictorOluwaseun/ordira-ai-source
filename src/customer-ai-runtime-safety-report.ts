import { inspectCustomerAiRuntimeSafetyReport } from '@modules/customer-ai/customer-ai-runtime-safety-evidence';

const DEFAULT_CONTRACT_VERSION = 'customer-ai-runtime-safety-v2';

/**
 * Prints only the validated report identity. It does not approve the report or
 * modify configuration, which keeps review separate from evidence generation.
 */
function main(): void {
  const reportPath = process.argv[2];
  if (!reportPath || reportPath === '--help') {
    process.stdout.write(
      'Usage: npm run inspect:customer-ai-runtime-safety -- <report.json>\n',
    );
    process.exitCode = reportPath ? 0 : 1;
    return;
  }
  const evidence = inspectCustomerAiRuntimeSafetyReport({
    reportPath,
    expectedContractVersion:
      process.env.CUSTOMER_AI_RUNTIME_SAFETY_CONTRACT_VERSION ??
      DEFAULT_CONTRACT_VERSION,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        contractVersion: evidence.contractVersion,
        reportSha256: evidence.reportSha256,
        sourceRevision: evidence.sourceRevision,
        executedAt: evidence.executedAt.toISOString(),
        checks: evidence.checks,
      },
      null,
      2,
    )}\n`,
  );
}

try {
  main();
} catch (error) {
  const message =
    error instanceof Error ? error.message : 'Unknown report inspection error';
  process.stderr.write(`Customer AI runtime report is invalid: ${message}\n`);
  process.exitCode = 1;
}
