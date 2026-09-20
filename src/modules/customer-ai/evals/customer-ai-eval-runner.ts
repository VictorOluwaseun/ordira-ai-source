import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@common/utils/crypto.util';
import { createStableStringifier } from '@common/utils/json.util';
import {
  assertCustomerAiEvalGradersRegistered,
  type CustomerAiEvalGraderName,
} from './customer-ai-eval-grader-names';

const stableStringify = createStableStringifier({
  undefinedValue: 'null',
  omitUndefinedObjectProperties: true,
});

/** One version-controlled behavior/safety scenario loaded from JSONL. */
export type CustomerAiEvalFixture = {
  id: string;
  category: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  languageStyle: string;
  startingState: string;
  turns: string[];
  allowedTools: string[];
  forbiddenTools: string[];
  expected: {
    route: 'shadow' | 'deterministic' | 'handoff';
    responseType?: string;
    handoff: boolean;
    factsFromTools?: string[];
  };
  graders: CustomerAiEvalGraderName[];
};

export type CustomerAiRepeatedEvalReport = {
  fixtureCount: number;
  trialCountPerFixture: number;
  totalTrials: number;
  failures: number;
  failureRate: number;
  oneSided95FailureRateUpperBound: number;
  criticalFailures: number;
  cases: Array<{
    fixtureId: string;
    risk: CustomerAiEvalFixture['risk'];
    trials: number;
    failures: number;
    failureRate: number;
    oneSided95FailureRateUpperBound: number;
  }>;
};

/**
 * Loads every JSONL fixture in stable filename/line order and validates the
 * suite before any provider calls are made. Stable ordering makes reports and
 * model comparisons reproducible.
 */
export function loadCustomerAiEvalFixtures(
  fixtureDirectory = join(process.cwd(), 'test/fixtures/customer-ai/evals'),
): CustomerAiEvalFixture[] {
  const fixtures = readdirSync(fixtureDirectory)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .flatMap((name) =>
      readFileSync(join(fixtureDirectory, name), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CustomerAiEvalFixture),
    );
  assertValidFixtures(fixtures);

  return fixtures;
}

/**
 * Produces the immutable corpus identity persisted with evaluation evidence.
 * Fixture IDs are sorted so the same reviewed corpus has the same digest even
 * when a caller loads files in a different order; order inside each scenario
 * remains significant and is preserved by the stable serializer.
 */
export function customerAiEvalDatasetSha256(
  fixtures: CustomerAiEvalFixture[],
): string {
  assertValidFixtures(fixtures);
  const canonicalFixtures = [...fixtures].sort((left, right) =>
    left.id.localeCompare(right.id),
  );

  return sha256(stableStringify(canonicalFixtures));
}

export async function runRepeatedCustomerAiEvaluation(
  fixtures: CustomerAiEvalFixture[],
  trialCountPerFixture: number,
  evaluate: (
    fixture: CustomerAiEvalFixture,
    trial: number,
  ) => boolean | Promise<boolean>,
  options: { concurrency?: number } = {},
): Promise<CustomerAiRepeatedEvalReport> {
  if (!Number.isInteger(trialCountPerFixture) || trialCountPerFixture < 1) {
    throw new Error('trialCountPerFixture must be a positive integer');
  }
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error(
      'Customer AI evaluation concurrency must be between 1 and 32',
    );
  }

  // Results are written by stable task index and aggregated only after every
  // worker finishes. This allows bounded parallel provider calls without making
  // report ordering or arithmetic depend on completion timing.
  const tasks = fixtures.flatMap((fixture, fixtureIndex) =>
    Array.from({ length: trialCountPerFixture }, (_, trialIndex) => ({
      fixture,
      fixtureIndex,
      trial: trialIndex + 1,
    })),
  );
  const passed = new Array<boolean>(tasks.length);
  let nextTaskIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, tasks.length)) },
    async () => {
      while (nextTaskIndex < tasks.length) {
        const taskIndex = nextTaskIndex;
        nextTaskIndex += 1;
        const task = tasks[taskIndex];
        passed[taskIndex] = await evaluate(task.fixture, task.trial);
      }
    },
  );
  await Promise.all(workers);

  const cases: CustomerAiRepeatedEvalReport['cases'] = fixtures.map(
    (fixture, fixtureIndex) => {
      const firstTask = fixtureIndex * trialCountPerFixture;
      const caseFailures = passed
        .slice(firstTask, firstTask + trialCountPerFixture)
        .filter((trialPassed) => !trialPassed).length;

      return {
        fixtureId: fixture.id,
        risk: fixture.risk,
        trials: trialCountPerFixture,
        failures: caseFailures,
        failureRate: caseFailures / trialCountPerFixture,
        oneSided95FailureRateUpperBound: customerAiEvalFailureRateUpperBound(
          caseFailures,
          trialCountPerFixture,
        ),
      };
    },
  );
  const failures = cases.reduce((total, item) => total + item.failures, 0);
  const criticalFailures = cases.reduce(
    (total, item) => total + (item.risk === 'critical' ? item.failures : 0),
    0,
  );

  const totalTrials = fixtures.length * trialCountPerFixture;

  return {
    fixtureCount: fixtures.length,
    trialCountPerFixture,
    totalTrials,
    failures,
    failureRate: totalTrials === 0 ? 0 : failures / totalTrials,
    oneSided95FailureRateUpperBound: customerAiEvalFailureRateUpperBound(
      failures,
      totalTrials,
    ),
    criticalFailures,
    cases,
  };
}

function assertValidFixtures(fixtures: CustomerAiEvalFixture[]): void {
  // Treat a malformed suite as a test configuration failure, never as a passed
  // or skipped model result.
  const ids = new Set<string>();
  for (const fixture of fixtures) {
    if (!fixture.id || ids.has(fixture.id)) {
      throw new Error(
        `Duplicate or missing customer AI eval fixture ID: ${fixture.id}`,
      );
    }
    ids.add(fixture.id);
    if (
      !fixture.category ||
      !fixture.languageStyle ||
      !fixture.startingState ||
      fixture.turns.length === 0 ||
      fixture.graders.length === 0
    ) {
      throw new Error(`Incomplete customer AI eval fixture: ${fixture.id}`);
    }
    const forbidden = new Set(fixture.forbiddenTools);
    if (fixture.allowedTools.some((tool) => forbidden.has(tool))) {
      throw new Error(`Conflicting tool policy in fixture: ${fixture.id}`);
    }
  }
  assertCustomerAiEvalGradersRegistered(fixtures);
}

/** One-sided 95% Wilson upper bound shared by reports and evidence validation. */
export function customerAiEvalFailureRateUpperBound(
  failures: number,
  trials: number,
): number {
  if (trials === 0) {
    return 0;
  }
  // One-sided z-score for 95% confidence. The upper bound captures uncertainty
  // from small samples and is intentionally stricter than the observed rate.
  const z = 1.6448536269514722;
  const rate = failures / trials;
  const zSquared = z * z;
  const denominator = 1 + zSquared / trials;
  const centre = rate + zSquared / (2 * trials);
  const margin =
    z * Math.sqrt((rate * (1 - rate) + zSquared / (4 * trials)) / trials);

  return Math.min(1, (centre + margin) / denominator);
}
