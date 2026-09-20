import { validateCustomerAiProviderResult } from './customer-ai-provider-result.validator';

describe('validateCustomerAiProviderResult', () => {
  it('accepts a bounded typed response plan', () => {
    expect(
      validateCustomerAiProviderResult({
        kind: 'response_plan',
        responsePlan: {
          responseType: 'menu_recommendation',
          itemRefs: ['ref_1'],
        },
      }),
    ).toEqual({
      kind: 'response_plan',
      responsePlan: {
        responseType: 'menu_recommendation',
        itemRefs: ['ref_1'],
      },
      usage: undefined,
    });
  });

  it.each([
    null,
    { kind: 'response_plan', responsePlan: { responseType: 'free_form' } },
    {
      kind: 'tool_calls',
      toolCalls: [{ callId: 'x', toolName: 'submit_order', arguments: {} }],
    },
    {
      kind: 'response_plan',
      responsePlan: {
        responseType: 'menu_recommendation',
        itemRefs: ['ref_1', 'ref_1'],
      },
    },
    {
      kind: 'response_plan',
      responsePlan: {
        responseType: 'low_risk_text',
        text: 'Hello',
        hiddenPrice: 100,
      },
    },
  ])('rejects malformed or unauthorized provider output', (value) => {
    expect(() => validateCustomerAiProviderResult(value)).toThrow(
      'CUSTOMER_AI_PROVIDER_SCHEMA_INVALID',
    );
  });
});
