import {
  customerAiEvalDatasetSha256,
  loadCustomerAiEvalFixtures,
  runRepeatedCustomerAiEvaluation,
} from './customer-ai-eval-runner';
import { assertCustomerAiEvalGradersRegistered } from './customer-ai-eval-grader-names';

describe('customer AI evaluation fixtures', () => {
  it('loads at least 100 versioned architecture and adversarial cases', () => {
    const fixtures = loadCustomerAiEvalFixtures();

    expect(fixtures.length).toBeGreaterThanOrEqual(100);
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(
      fixtures.length,
    );
    expect(fixtures.some((fixture) => fixture.risk === 'critical')).toBe(true);
    expect(
      fixtures.every((fixture) =>
        fixture.forbiddenTools.includes('submit_order'),
      ),
    ).toBe(true);
  });

  it('hashes the same fixture corpus independently of input order', () => {
    const fixtures = loadCustomerAiEvalFixtures().slice(0, 3);

    expect(customerAiEvalDatasetSha256(fixtures)).toMatch(/^[a-f0-9]{64}$/);
    expect(customerAiEvalDatasetSha256([...fixtures].reverse())).toBe(
      customerAiEvalDatasetSha256(fixtures),
    );
  });

  it('records every independent trial and critical failure', async () => {
    const fixtures = loadCustomerAiEvalFixtures().slice(0, 2);
    fixtures[0].risk = 'critical';
    const report = await runRepeatedCustomerAiEvaluation(
      fixtures,
      5,
      (fixture, trial) => fixture.id !== fixtures[0].id || trial !== 3,
    );

    expect(report).toEqual(
      expect.objectContaining({
        fixtureCount: 2,
        trialCountPerFixture: 5,
        totalTrials: 10,
        failures: 1,
        criticalFailures: 1,
      }),
    );
    expect(report.oneSided95FailureRateUpperBound).toBeGreaterThan(
      report.failureRate,
    );
  });

  it('bounds concurrent trials while preserving fixture report order', async () => {
    const fixtures = loadCustomerAiEvalFixtures().slice(0, 4);
    let active = 0;
    let maximumActive = 0;
    const report = await runRepeatedCustomerAiEvaluation(
      fixtures,
      2,
      async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return true;
      },
      { concurrency: 2 },
    );

    expect(maximumActive).toBe(2);
    expect(report.cases.map((item) => item.fixtureId)).toEqual(
      fixtures.map((fixture) => fixture.id),
    );
  });

  it('rejects unknown graders before a corpus can reach a provider', () => {
    expect(() =>
      assertCustomerAiEvalGradersRegistered([
        { id: 'broken-fixture', graders: ['misspelled_grader'] },
      ]),
    ).toThrow('Unknown customer AI eval grader');
  });
});
