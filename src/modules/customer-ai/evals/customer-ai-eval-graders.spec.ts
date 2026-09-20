import type {
  CustomerAiProvider,
  CustomerAiProviderRequest,
  CustomerAiProviderResult,
} from '../customer-ai.types';
import { CustomerAiPolicyEvidenceService } from '../customer-ai-policy-evidence.service';
import { CustomerAiPolicyService } from '../customer-ai-policy.service';
import { CustomerAiResponseCompilerService } from '../customer-ai-response-compiler.service';
import { gradeCustomerAiEvalObservation } from './customer-ai-eval-graders';
import { loadCustomerAiEvalFixtures } from './customer-ai-eval-runner';
import { CustomerAiEvalScenarioRunner } from './customer-ai-eval-scenario-runner';
import type { CustomerAiModelVariant } from './customer-ai-model-comparison';

describe('customer AI executable evaluation corpus', () => {
  it('runs every registered fixture through deterministic graders offline', async () => {
    const fixtures = loadCustomerAiEvalFixtures();
    const provider = new FixtureAwareEvalProvider();
    const runner = new CustomerAiEvalScenarioRunner(
      provider,
      new CustomerAiResponseCompilerService(),
      new CustomerAiPolicyEvidenceService(),
      new CustomerAiPolicyService(),
      {
        maxProviderCalls: 2,
        maxToolCalls: 4,
        maxOutputTokens: 350,
        providerTimeoutMs: 1000,
        turnDeadlineMs: 2000,
      },
    );
    const failures: string[] = [];

    for (const fixture of fixtures) {
      provider.fixture = fixture;
      const observation = await runner.run({
        executionId: 'offline-corpus-test',
        fixture,
        variant: VARIANT,
        trial: 1,
      });
      const grade = gradeCustomerAiEvalObservation(fixture, observation);
      if (!grade.passed) {
        failures.push(`${fixture.id}: ${grade.failureCodes.join(', ')}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('preserves deterministic fencing evidence when the provider fails', async () => {
    const fixture = loadCustomerAiEvalFixtures().find(
      ({ id }) => id === 'failure-005',
    );
    if (!fixture) throw new Error('Expired-fence fixture is missing');
    const runner = new CustomerAiEvalScenarioRunner(
      {
        name: 'fake',
        createTurn: () =>
          Promise.reject(new Error('CUSTOMER_AI_PROVIDER_UNAVAILABLE')),
      },
      new CustomerAiResponseCompilerService(),
      new CustomerAiPolicyEvidenceService(),
      new CustomerAiPolicyService(),
      {
        maxProviderCalls: 2,
        maxToolCalls: 4,
        maxOutputTokens: 350,
        providerTimeoutMs: 1000,
        turnDeadlineMs: 2000,
      },
    );

    const observation = await runner.run({
      executionId: 'failed-provider-fencing-test',
      fixture,
      variant: VARIANT,
      trial: 1,
    });

    expect(observation.errorCategory).toBe('provider_unavailable');
    expect(observation.simulatedGuardEvents).toEqual(
      expect.arrayContaining([
        'obsolete_write_rejected',
        'deterministic_fallback',
      ]),
    );
  });

  it('does not manufacture ambiguity from duplicate seeded menu names', async () => {
    const fixture = loadCustomerAiEvalFixtures().find(
      ({ id }) => id === 'adv-money-001',
    );
    if (!fixture) throw new Error('Forced-price fixture is missing');
    const runner = new CustomerAiEvalScenarioRunner(
      {
        name: 'fake',
        createTurn: (request) => {
          if (request.priorToolResults.length === 0) {
            return Promise.resolve({
              kind: 'tool_calls' as const,
              toolCalls: [
                {
                  callId: 'dedupe-menu-results',
                  toolName: 'search_menu_items' as const,
                  arguments: { q: 'jollof rice', limit: 4 },
                },
              ],
            });
          }

          return Promise.resolve({
            kind: 'response_plan' as const,
            responsePlan: {
              responseType: 'menu_recommendation' as const,
              itemRefs: readRefs(request),
              introduction: 'Here are the distinct matching options:',
            },
          });
        },
      },
      new CustomerAiResponseCompilerService(),
      new CustomerAiPolicyEvidenceService(),
      new CustomerAiPolicyService(),
      {
        maxProviderCalls: 2,
        maxToolCalls: 4,
        maxOutputTokens: 350,
        providerTimeoutMs: 1000,
        turnDeadlineMs: 2000,
      },
    );

    const observation = await runner.run({
      executionId: 'deduplicated-menu-results-test',
      fixture,
      variant: VARIANT,
      trial: 1,
    });

    expect(observation.toolCalls[0]?.returnedRefs).toHaveLength(3);
    expect(observation.route).toBe('shadow');
    expect(observation.policyReasonCode).toBeNull();
  });

  it('passes the fixture turns as bounded chronological provider context', async () => {
    const fixture = loadCustomerAiEvalFixtures().find(
      ({ id }) => id === 'discovery-008',
    );
    if (!fixture) throw new Error('Contextual follow-up fixture is missing');
    const createTurn = jest.fn().mockResolvedValue({
      kind: 'response_plan' as const,
      responsePlan: {
        responseType: 'handoff' as const,
        reasonCode: 'test_complete',
      },
    });
    const runner = new CustomerAiEvalScenarioRunner(
      { name: 'fake', createTurn },
      new CustomerAiResponseCompilerService(),
      new CustomerAiPolicyEvidenceService(),
      new CustomerAiPolicyService(),
      {
        maxProviderCalls: 2,
        maxToolCalls: 4,
        providerTimeoutMs: 1000,
        turnDeadlineMs: 2000,
      },
    );

    await runner.run({
      executionId: 'context-window-test',
      fixture,
      variant: VARIANT,
      trial: 1,
    });

    expect(createTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        customerMessage: 'How much is it?',
        contextMessages: ['I want a chicken burger', 'How much is it?'],
      }),
    );
  });
});

const VARIANT: CustomerAiModelVariant = {
  id: 'offline-contract',
  provider: 'fake',
  model: 'fixture-aware',
  reasoningEffort: 'none',
  maxOutputTokens: 350,
  maxContextMessages: 4,
  inputCostPerMillionMinorUnit: 1,
  outputCostPerMillionMinorUnit: 1,
  promptVersion: 'customer-ai-v3',
  policyVersion: 'customer-ai-policy-v2',
  toolContractVersion: 'customer-ai-tools-v2',
  responseContractVersion: 'customer-ai-response-v1',
};

type Fixture = ReturnType<typeof loadCustomerAiEvalFixtures>[number];

/**
 * Test-only provider that follows each fixture's declared route. It does not
 * validate model quality; it proves the runner, seeded tools, and every grader
 * can execute locally without network access.
 */
class FixtureAwareEvalProvider implements CustomerAiProvider {
  readonly name = 'fake' as const;
  fixture: Fixture | null = null;

  createTurn(
    request: CustomerAiProviderRequest,
  ): Promise<CustomerAiProviderResult> {
    const fixture = this.fixture;
    if (!fixture) throw new Error('Fixture is not configured');
    const exerciseTool =
      fixture.expected.route === 'shadow' ||
      [
        'tool_failure',
        'tool_timeout',
        'unavailable_selection',
        'empty_results',
      ].includes(fixture.category);

    if (request.priorToolResults.length === 0 && exerciseTool) {
      const toolName = fixture.allowedTools[0];
      if (
        toolName !== 'search_menu_items' &&
        toolName !== 'search_restaurants'
      ) {
        throw new Error(`Fixture ${fixture.id} has no executable read tool`);
      }

      return Promise.resolve({
        kind: 'tool_calls',
        toolCalls: [
          {
            callId: `call-${fixture.id}`,
            toolName,
            arguments: { q: request.customerMessage, limit: 4 },
          },
        ],
      });
    }

    if (fixture.expected.route === 'handoff') {
      if (fixture.category === 'unavailable_selection') {
        return Promise.resolve(menuPlan(readRefs(request), fixture));
      }

      return Promise.resolve({
        kind: 'response_plan',
        responsePlan: { responseType: 'handoff', reasonCode: fixture.category },
      });
    }

    const refs = readRefs(request);
    if (fixture.expected.responseType === 'restaurant_recommendation') {
      return Promise.resolve({
        kind: 'response_plan',
        responsePlan: {
          responseType: 'restaurant_recommendation',
          restaurantRefs: refs.slice(0, 1),
          introduction: 'Here are matching restaurants:',
        },
      });
    }

    return Promise.resolve(menuPlan(refs, fixture));
  }
}

function menuPlan(refs: string[], fixture: Fixture): CustomerAiProviderResult {
  return {
    kind: 'response_plan',
    responsePlan: {
      responseType: 'menu_recommendation',
      itemRefs: refs.slice(0, 1),
      introduction:
        fixture.category === 'numeric_introduction'
          ? 'Here are 8500 options:'
          : 'Here are matching menu items:',
    },
  };
}

function readRefs(request: CustomerAiProviderRequest): string[] {
  const result = request.priorToolResults.at(-1);
  const rows: unknown = result?.output?.results;
  if (!Array.isArray(rows)) return [];

  const refs: string[] = [];
  for (const row of rows as unknown[]) {
    if (isRecord(row) && typeof row.ref === 'string') {
      refs.push(row.ref);
    }
  }

  return refs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
