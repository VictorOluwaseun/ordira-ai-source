import type { CustomerAiProviderRequest } from '../customer-ai.types';
import { CustomerAiEvalBudget } from './customer-ai-eval-budget';

describe('CustomerAiEvalBudget', () => {
  it('fails before a provider call can exceed the declared command ceiling', () => {
    const budget = new CustomerAiEvalBudget(1, 1, 1);

    budget.admit(request());
    expect(() => budget.admit(request())).toThrow('CUSTOMER_AI_EVAL_MAX_COST');
    expect(budget.snapshot()).toEqual({
      maximumMinorUnit: 1,
      admittedMinorUnit: 1,
    });
  });

  it('rejects zero-valued budgets and token rates', () => {
    expect(() => new CustomerAiEvalBudget(0, 1, 1)).toThrow(
      'budget configuration is invalid',
    );
    expect(() => new CustomerAiEvalBudget(1, 0, 1)).toThrow(
      'budget configuration is invalid',
    );
  });
});

function request(): CustomerAiProviderRequest {
  return {
    runId: 'eval-run',
    budgetReservationId: 'eval-reservation',
    safetyIdentifier: 'ordira_eval_safe',
    model: 'quality-model',
    reasoningEffort: 'high',
    customerMessage: 'Find burgers',
    contextMessages: ['Find burgers'],
    phase: 'discovery',
    promptVersion: 'prompt-v1',
    policyVersion: 'policy-v1',
    toolContractVersion: 'tools-v1',
    responseContractVersion: 'response-v1',
    priorToolResults: [],
    maxOutputTokens: 100,
    signal: new AbortController().signal,
  };
}
