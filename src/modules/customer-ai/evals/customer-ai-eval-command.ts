import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AppLogger } from '@common/logger/app.logger';
import { customerAiConfig } from '@config/customer-ai.config';
import { databaseConfig } from '@config/database.config';
import { validateCustomerAiEvalEnv } from '@config/env.schema';
import { redisConfig } from '@config/redis.config';
import type { CustomerAiReasoningEffort } from '@config/types/env.types';
import { RedisService } from '@database/redis.service';
import { createConnection } from 'mongoose';
import OpenAI from 'openai';
import { CustomerAiEvaluationEvidenceRepository } from '../customer-ai-evaluation-evidence.repository';
import { CustomerAiEvaluationEvidenceService } from '../customer-ai-evaluation-evidence.service';
import { CustomerAiPolicyEvidenceService } from '../customer-ai-policy-evidence.service';
import { CustomerAiPolicyService } from '../customer-ai-policy.service';
import { CustomerAiResponseCompilerService } from '../customer-ai-response-compiler.service';
import { resolveCustomerAiSourceRevision } from '../customer-ai-source-revision';
import {
  loadCustomerAiRuntimeSafetyEvidence,
  type CustomerAiRuntimeSafetyEvidence,
} from '../customer-ai-runtime-safety-evidence';
import { CustomerAiSpendGuardService } from '../customer-ai-spend-guard.service';
import type { CustomerAiProviderUsage } from '../customer-ai.types';
import {
  estimateTokenCostMinorUnit,
  OpenAiCustomerAiProvider,
} from '../providers/openai-customer-ai.provider';
import {
  CustomerAiEvaluationEvidence,
  CustomerAiEvaluationEvidenceSchema,
} from '../schemas/customer-ai-evaluation-evidence.schema';
import { CustomerAiEvalBudget } from './customer-ai-eval-budget';
import { gradeCustomerAiEvalObservation } from './customer-ai-eval-graders';
import { loadCustomerAiEvalFixtures } from './customer-ai-eval-runner';
import { CustomerAiEvalScenarioRunner } from './customer-ai-eval-scenario-runner';
import {
  runCustomerAiModelComparison,
  type CustomerAiModelVariant,
} from './customer-ai-model-comparison';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const REASONING_EFFORTS = new Set<CustomerAiReasoningEffort>([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export type CustomerAiEvalCommandOptions = {
  live: boolean;
  help: boolean;
  comparisonId: string | null;
  variants: Array<{
    id: string;
    model: string;
    reasoningEffort: CustomerAiReasoningEffort;
    maxOutputTokens: number;
    inputCostPerMillionMinorUnit: number;
    outputCostPerMillionMinorUnit: number;
  }>;
  trials: number | null;
  concurrency: number | null;
  maxCostMinorUnit: number | null;
  outputPath: string | null;
  runtimeSafetyReportPath: string | null;
  record: boolean;
};

export type CustomerAiEvalCommandResult = {
  exitCode: 0 | 1 | 2;
  summary: {
    comparisonId: string;
    sourceRevision: string;
    datasetVersion: string;
    datasetSha256: string;
    fixtureCount: number;
    trialCountPerFixture: number;
    criticalFailures: number;
    rejectedVariants: string[];
    evidenceRecorded: boolean;
    outputPath: string | null;
    budget: { maximumMinorUnit: number; admittedMinorUnit: number };
    usage: CustomerAiEvalVariantUsage[];
  };
};

export type CustomerAiEvalVariantUsage = {
  variantId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

/** Parse a deliberately small, strict CLI surface; unknown flags fail closed. */
export function parseCustomerAiEvalCommandArgs(
  argv: readonly string[],
): CustomerAiEvalCommandOptions {
  const options: CustomerAiEvalCommandOptions = {
    live: false,
    help: false,
    comparisonId: null,
    variants: [],
    trials: null,
    concurrency: null,
    maxCostMinorUnit: null,
    outputPath: null,
    runtimeSafetyReportPath: null,
    record: false,
  };
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--live') {
      options.live = true;
      continue;
    }
    if (argument === '--record') {
      options.record = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--variant') {
      options.variants.push(parseVariant(readValue(argv, ++index, argument)));
      continue;
    }
    if (
      argument === '--comparison-id' ||
      argument === '--trials' ||
      argument === '--concurrency' ||
      argument === '--max-cost-minor-unit' ||
      argument === '--output' ||
      argument === '--runtime-safety-report'
    ) {
      if (seen.has(argument)) {
        throw new Error(`Duplicate customer AI evaluation option: ${argument}`);
      }
      seen.add(argument);
      const value = readValue(argv, ++index, argument);
      assignOption(options, argument, value);
      continue;
    }

    throw new Error(`Unknown customer AI evaluation option: ${argument}`);
  }

  if (!options.help) validateCommandOptions(options);

  return options;
}

/**
 * Runs the complete live comparison while keeping infrastructure ownership
 * explicit. Normal Jest execution never calls this function.
 */
export async function executeCustomerAiEvalCommand(
  options: CustomerAiEvalCommandOptions,
): Promise<CustomerAiEvalCommandResult> {
  validateCommandOptions(options);
  validateCustomerAiEvalEnv(process.env);
  const config = customerAiConfig();
  const redis = redisConfig();
  const database = databaseConfig();
  // Validate the complete corpus and construct all pure in-memory inputs before
  // opening infrastructure resources or admitting any paid provider work.
  const fixtures = loadCustomerAiEvalFixtures();
  const evalOpenAiApiKey = validateLiveEnvironment(
    config,
    options,
    fixtures.length,
  );
  // Resolve provenance before any paid request. Recorded evidence refuses a
  // dirty tree, while a smoke artifact discloses that HEAD was not exact.
  const source = resolveCustomerAiSourceRevision({
    requireClean: options.record,
  });
  const runtimeSafetyEvidence = options.record
    ? loadCustomerAiRuntimeSafetyEvidence({
        reportPath: options.runtimeSafetyReportPath!,
        expectedContractVersion: config.runtimeSafetyContractVersion,
        approvedReportSha256: config.runtimeSafetyReportSha256,
        expectedSourceRevision: source.revision,
      })
    : null;
  if (options.outputPath) {
    await assertOutputPathAvailable(options.outputPath);
  }

  const variants = toModelVariants(options, config);
  // The provider and Redis ledger use the highest declared variant rates. This
  // deliberately over-reserves cheaper variants, ensuring the command and
  // global budgets remain hard upper bounds even in a mixed-model comparison.
  const reservationRates = highestVariantRates(variants);
  const budget = new CustomerAiEvalBudget(
    options.maxCostMinorUnit!,
    reservationRates.input,
    reservationRates.output,
  );
  const logger = new AppLogger();
  const redisService = new RedisService(redis, logger);

  try {
    const spendGuard = new CustomerAiSpendGuardService(redisService, config);
    const client = new OpenAI({
      apiKey: evalOpenAiApiKey,
      timeout: config.apiTimeoutMs,
      maxRetries: 0,
    });
    const provider = new OpenAiCustomerAiProvider(client, spendGuard, {
      ...config,
      openAiInputCostPerMillionMinorUnit: reservationRates.input,
      openAiOutputCostPerMillionMinorUnit: reservationRates.output,
    });
    const runner = new CustomerAiEvalScenarioRunner(
      provider,
      new CustomerAiResponseCompilerService(),
      new CustomerAiPolicyEvidenceService(),
      new CustomerAiPolicyService(),
      {
        maxProviderCalls: config.maxProviderCalls,
        maxToolCalls: config.maxToolCalls,
        providerTimeoutMs: config.apiTimeoutMs,
        turnDeadlineMs: config.turnDeadlineMs,
      },
      (request) => budget.admit(request),
    );
    // Token totals are aggregate billing diagnostics only. They contain no
    // prompt, response, fixture, tool payload, customer text, or opaque ref.
    // Keeping the standard-price budget beside these totals lets operators
    // verify account incentives without ever treating a free quota as an
    // unlimited or guaranteed entitlement.
    const usageByVariant = new Map(
      variants.map((variant) => [variant.id, emptyVariantUsage(variant.id)]),
    );
    const failures: Array<{
      variantId: string;
      fixtureId: string;
      trial: number;
      failedGraders: string[];
      failureCodes: string[];
      route: 'shadow' | 'deterministic' | 'handoff';
      responseType: string | null;
      errorCategory: string | null;
      policyReasonCode: string | null;
      providerCallCount: number;
      toolCalls: Array<{
        toolName: string;
        status: 'succeeded' | 'failed';
        errorCode: string | null;
      }>;
      simulatedGuardEvents: string[];
    }> = [];
    const evaluatedAt = new Date();
    const executionId = randomUUID();
    const report = await runCustomerAiModelComparison({
      fixtures,
      datasetVersion: config.evaluationDatasetVersion,
      trialCountPerFixture: options.trials!,
      concurrency: options.concurrency!,
      variants,
      maxFailureRateUpperBound:
        config.evaluationGateMaxFailureRateUpperBoundPercent / 100,
      maxFailureRateDeltaFromCeiling:
        config.evaluationGateMaxFailureRateDeltaPercent / 100,
      evaluate: async (variant, fixture, trial) => {
        const trialObservation = await runner.run({
          executionId,
          fixture,
          variant,
          trial,
        });
        addCustomerAiEvalVariantUsage(
          usageByVariant.get(variant.id),
          trialObservation.usage,
        );
        const grade = gradeCustomerAiEvalObservation(fixture, trialObservation);
        if (!grade.passed) {
          failures.push({
            variantId: variant.id,
            fixtureId: fixture.id,
            trial,
            failedGraders: grade.failedGraders,
            failureCodes: grade.failureCodes,
            // Diagnostics are deliberately structural. They expose no fixture
            // turn, provider body, tool arguments/results, refs, or compiled
            // customer text, but are enough to distinguish model behavior from
            // provider, policy, and harness failures.
            route: trialObservation.route,
            responseType: trialObservation.responsePlan?.responseType ?? null,
            errorCategory: trialObservation.errorCategory,
            policyReasonCode: trialObservation.policyReasonCode,
            providerCallCount: trialObservation.providerCallCount,
            toolCalls: trialObservation.toolCalls.map((call) => ({
              toolName: call.toolName,
              status: call.status,
              errorCode: call.errorCode,
            })),
            simulatedGuardEvents: [...trialObservation.simulatedGuardEvents],
          });
        }

        return {
          passed: grade.passed,
          latencyMs: trialObservation.latencyMs,
          // The provider's usage cost is intentionally reserved at the highest
          // comparison rate. Recompute report cost with this exact variant's
          // declared rates so the efficiency comparison remains meaningful.
          estimatedCostMinorUnit: estimateCustomerAiEvalVariantCost(
            trialObservation.usage,
            variant,
          ),
        };
      },
    });
    failures.sort((left, right) =>
      `${left.variantId}:${left.fixtureId}:${left.trial}`.localeCompare(
        `${right.variantId}:${right.fixtureId}:${right.trial}`,
      ),
    );
    const usage = variants.map((variant) => {
      const aggregate = usageByVariant.get(variant.id);
      if (!aggregate) {
        throw new Error(`Missing evaluation usage for variant ${variant.id}`);
      }

      return { ...aggregate };
    });

    if (options.record) {
      await recordEvidence(database, {
        comparisonId: options.comparisonId!,
        sourceRevision: source.revision,
        evaluationContractVersion: config.evaluationContractVersion,
        runtimeSafetyEvidence: requireRuntimeSafetyEvidence(
          runtimeSafetyEvidence,
        ),
        report,
        evaluatedAt,
      });
    }

    const artifact = {
      comparisonId: options.comparisonId,
      source: {
        revision: source.revision,
        dirty: source.dirty,
      },
      evaluationContractVersion: config.evaluationContractVersion,
      evaluatedAt: evaluatedAt.toISOString(),
      execution: {
        live: true,
        concurrency: options.concurrency,
        maximumCostMinorUnit: options.maxCostMinorUnit,
        admittedCostMinorUnit: budget.snapshot().admittedMinorUnit,
        evidenceRecorded: options.record,
        usage,
      },
      runtimeSafety: summarizeRuntimeSafetyEvidence(runtimeSafetyEvidence),
      report,
      failures,
    };
    const outputPath = options.outputPath
      ? await writeEvaluationArtifact(options.outputPath, artifact)
      : null;
    const criticalFailures = report.variants.reduce(
      (total, variant) => total + variant.evaluation.criticalFailures,
      0,
    );
    const rejectedVariants = report.variants
      .filter((variant) => !variant.promotable)
      .map((variant) => variant.variant.id);
    const exitCode = evaluationExitCode(
      criticalFailures,
      rejectedVariants.length,
    );

    return {
      exitCode,
      summary: {
        comparisonId: options.comparisonId!,
        sourceRevision: source.revision,
        datasetVersion: report.datasetVersion,
        datasetSha256: report.datasetSha256,
        fixtureCount: report.fixtureCount,
        trialCountPerFixture: report.trialCountPerFixture,
        criticalFailures,
        rejectedVariants,
        evidenceRecorded: options.record,
        outputPath,
        budget: budget.snapshot(),
        usage,
      },
    };
  } finally {
    await redisService.onModuleDestroy();
  }
}

function evaluationExitCode(
  criticalFailures: number,
  rejectedVariantCount: number,
): 0 | 1 | 2 {
  if (criticalFailures > 0) return 2;
  if (rejectedVariantCount > 0) return 1;

  return 0;
}

export function customerAiEvalCommandHelp(): string {
  return [
    'Run the opt-in Ordira customer-AI model comparison.',
    '',
    'Usage:',
    '  npm run eval:customer-ai -- --live --comparison-id <id> \\',
    '    --variant <id:model:reasoning:max-output:input-rate:output-rate> [--variant ...] \\',
    '    --trials <count> --concurrency <1-8> --max-cost-minor-unit <amount> \\',
    '    [--output <new-json-file>] [--record --runtime-safety-report <json-file>]',
    '',
    'Variant max-output includes reasoning and visible tokens; rates are billing-currency minor units per 1M tokens.',
    'CUSTOMER_AI_EVAL_OPENAI_API_KEY is required and must differ from OPENAI_API_KEY.',
    'Recorded model evidence also requires an approved runtime-safety report hash.',
    'The first --variant is the quality ceiling. --record writes only sanitized,',
    'immutable aggregate evidence to MongoDB. Artifacts include content-free token totals.',
    'Existing output files are not overwritten.',
  ].join('\n');
}

function validateCommandOptions(options: CustomerAiEvalCommandOptions): void {
  if (!options.live) {
    throw new Error('Customer AI provider evaluation requires explicit --live');
  }
  if (!options.comparisonId || !SAFE_ID.test(options.comparisonId)) {
    throw new Error('Customer AI evaluation --comparison-id is invalid');
  }
  if (options.variants.length === 0) {
    throw new Error('Customer AI evaluation requires at least one --variant');
  }
  if (
    new Set(options.variants.map((variant) => variant.id)).size !==
    options.variants.length
  ) {
    throw new Error('Customer AI evaluation variant IDs must be unique');
  }
  assertIntegerOption(options.trials, '--trials', 1, 100);
  assertIntegerOption(options.concurrency, '--concurrency', 1, 8);
  assertIntegerOption(
    options.maxCostMinorUnit,
    '--max-cost-minor-unit',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (options.record && !options.runtimeSafetyReportPath?.trim()) {
    throw new Error(
      'Customer AI --record requires --runtime-safety-report from the infrastructure suite',
    );
  }
}

function validateLiveEnvironment(
  config: ReturnType<typeof customerAiConfig>,
  options: CustomerAiEvalCommandOptions,
  fixtureCount: number,
): string {
  const evalOpenAiApiKey = requireCustomerAiEvalOpenAiApiKey(config);
  if (
    config.dailySpendLimitMinorUnit < 1 ||
    config.monthlySpendLimitMinorUnit < 1
  ) {
    throw new Error('Positive global customer AI spend limits are required');
  }
  if (
    options.maxCostMinorUnit! > config.dailySpendLimitMinorUnit ||
    options.maxCostMinorUnit! > config.monthlySpendLimitMinorUnit
  ) {
    throw new Error(
      'Evaluation maximum cost must not exceed the configured daily or monthly spend limit',
    );
  }
  if (
    options.record &&
    (options.trials! < config.evaluationGateMinTrialsPerFixture ||
      fixtureCount < config.evaluationGateMinFixtures)
  ) {
    throw new Error(
      'Recorded evaluation evidence must satisfy the configured minimum fixture and trial counts',
    );
  }

  return evalOpenAiApiKey;
}

export function requireCustomerAiEvalOpenAiApiKey(config: {
  provider: string;
  evalOpenAiApiKey: string | null;
  openAiApiKey: string | null;
}): string {
  if (config.provider !== 'openai' || !config.evalOpenAiApiKey) {
    throw new Error(
      'CUSTOMER_AI_PROVIDER=openai and CUSTOMER_AI_EVAL_OPENAI_API_KEY are required for live evaluation',
    );
  }
  if (config.openAiApiKey && config.evalOpenAiApiKey === config.openAiApiKey) {
    throw new Error(
      'CUSTOMER_AI_EVAL_OPENAI_API_KEY must be different from OPENAI_API_KEY',
    );
  }

  return config.evalOpenAiApiKey;
}

function toModelVariants(
  options: CustomerAiEvalCommandOptions,
  config: ReturnType<typeof customerAiConfig>,
): CustomerAiModelVariant[] {
  return options.variants.map((variant) => ({
    ...variant,
    provider: 'openai',
    maxContextMessages: config.maxContextMessages,
    promptVersion: config.promptVersion,
    policyVersion: config.policyVersion,
    toolContractVersion: config.toolContractVersion,
    responseContractVersion: config.responseContractVersion,
  }));
}

async function recordEvidence(
  database: ReturnType<typeof databaseConfig>,
  input: Parameters<CustomerAiEvaluationEvidenceService['recordComparison']>[0],
): Promise<void> {
  const connection = await createConnection(database.uri, {
    serverSelectionTimeoutMS: database.serverSelectionTimeoutMs,
  }).asPromise();
  try {
    const model = connection.model<CustomerAiEvaluationEvidence>(
      CustomerAiEvaluationEvidence.name,
      CustomerAiEvaluationEvidenceSchema,
    );
    const repository = new CustomerAiEvaluationEvidenceRepository(model);
    const service = new CustomerAiEvaluationEvidenceService(repository);
    await service.recordComparison(input);
  } finally {
    await connection.close();
  }
}

async function writeEvaluationArtifact(
  outputPath: string,
  artifact: unknown,
): Promise<string> {
  const absolutePath = resolve(outputPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  // 'wx' preserves prior evaluation artifacts and catches accidental comparison
  // ID reuse instead of silently replacing audit material.
  await writeFile(absolutePath, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });

  return absolutePath;
}

async function assertOutputPathAvailable(outputPath: string): Promise<void> {
  const absolutePath = resolve(outputPath);
  try {
    await access(absolutePath);
  } catch {
    return;
  }

  throw new Error(
    `Customer AI evaluation output already exists: ${absolutePath}`,
  );
}

function assignOption(
  options: CustomerAiEvalCommandOptions,
  name: string,
  value: string,
): void {
  if (name === '--comparison-id') options.comparisonId = value;
  else if (name === '--trials') options.trials = parseInteger(value, name);
  else if (name === '--concurrency') {
    options.concurrency = parseInteger(value, name);
  } else if (name === '--max-cost-minor-unit') {
    options.maxCostMinorUnit = parseInteger(value, name);
  } else if (name === '--output') options.outputPath = value;
  else if (name === '--runtime-safety-report') {
    options.runtimeSafetyReportPath = value;
  }
}

function requireRuntimeSafetyEvidence(
  evidence: CustomerAiRuntimeSafetyEvidence | null,
): CustomerAiRuntimeSafetyEvidence {
  if (!evidence) {
    throw new Error('Customer AI runtime safety evidence is required');
  }

  return evidence;
}

function summarizeRuntimeSafetyEvidence(
  evidence: CustomerAiRuntimeSafetyEvidence | null,
): Record<string, unknown> | null {
  if (!evidence) {
    return null;
  }

  return {
    contractVersion: evidence.contractVersion,
    reportSha256: evidence.reportSha256,
    sourceRevision: evidence.sourceRevision,
    executedAt: evidence.executedAt.toISOString(),
    checks: [...evidence.checks],
  };
}

function parseVariant(
  value: string,
): CustomerAiEvalCommandOptions['variants'][number] {
  const [
    id,
    model,
    reasoningEffort,
    maxOutput,
    inputCost,
    outputCost,
    ...extra
  ] = value.split(':');
  const maxOutputTokens = parseVariantRate(maxOutput);
  const inputCostPerMillionMinorUnit = parseVariantRate(inputCost);
  const outputCostPerMillionMinorUnit = parseVariantRate(outputCost);
  if (
    extra.length > 0 ||
    !id ||
    !SAFE_ID.test(id) ||
    !model?.trim() ||
    !reasoningEffort ||
    !REASONING_EFFORTS.has(reasoningEffort as CustomerAiReasoningEffort) ||
    maxOutputTokens === null ||
    inputCostPerMillionMinorUnit === null ||
    outputCostPerMillionMinorUnit === null
  ) {
    throw new Error(
      'Customer AI --variant must use <safe-id>:<model>:<reasoning-effort>:<positive-max-output>:<positive-input-rate>:<positive-output-rate>',
    );
  }

  return {
    id,
    model,
    reasoningEffort: reasoningEffort as CustomerAiReasoningEffort,
    maxOutputTokens,
    inputCostPerMillionMinorUnit,
    outputCostPerMillionMinorUnit,
  };
}

function parseVariantRate(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function highestVariantRates(variants: CustomerAiModelVariant[]): {
  input: number;
  output: number;
} {
  return {
    input: Math.max(
      ...variants.map((variant) => variant.inputCostPerMillionMinorUnit),
    ),
    output: Math.max(
      ...variants.map((variant) => variant.outputCostPerMillionMinorUnit),
    ),
  };
}

function emptyVariantUsage(variantId: string): CustomerAiEvalVariantUsage {
  return {
    variantId,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

export function addCustomerAiEvalVariantUsage(
  aggregate: CustomerAiEvalVariantUsage | undefined,
  usage: Required<CustomerAiProviderUsage>,
): void {
  if (!aggregate) {
    throw new Error('Evaluation usage variant is not registered');
  }

  aggregate.inputTokens += usage.inputTokens;
  aggregate.cachedInputTokens += usage.cachedInputTokens;
  aggregate.outputTokens += usage.outputTokens;
  // Calculate this from the two billable directions instead of trusting an
  // optional provider total that may use a different accounting convention.
  aggregate.totalTokens = aggregate.inputTokens + aggregate.outputTokens;
}

/**
 * Prices a completed trial using the exact model variant's reviewed rates.
 * A deterministic fixture with no provider tokens remains free; the shared
 * provider estimator otherwise rounds a positive fractional minor unit up.
 */
export function estimateCustomerAiEvalVariantCost(
  usage: Pick<
    Required<CustomerAiProviderUsage>,
    'inputTokens' | 'outputTokens'
  >,
  variant: Pick<
    CustomerAiModelVariant,
    'inputCostPerMillionMinorUnit' | 'outputCostPerMillionMinorUnit'
  >,
): number {
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return 0;

  return estimateTokenCostMinorUnit(
    usage.inputTokens,
    usage.outputTokens,
    variant.inputCostPerMillionMinorUnit,
    variant.outputCostPerMillionMinorUnit,
  );
}

function readValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(
      `Missing value for customer AI evaluation option ${option}`,
    );
  }

  return value;
}

function parseInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }

  return Number(value);
}

function assertIntegerOption(
  value: number | null,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (
    value === null ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
}
