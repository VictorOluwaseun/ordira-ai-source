import { CustomerAiPolicyService } from './customer-ai-policy.service';

describe('CustomerAiPolicyService', () => {
  const policy = new CustomerAiPolicyService();
  const safeSignals = {
    schemaValid: true,
    toolErrorCount: 0,
    ambiguousResultCount: 0,
    missingRequiredFacts: [],
    staleVersionConflict: false,
    unavailableSelectedItem: false,
    scopeMismatch: false,
    contradictoryConstraints: false,
    supportedIntent: true,
    providerRequestedHandoff: false,
  };

  it('continues only when objective signals are safe', () => {
    expect(policy.decide(safeSignals)).toEqual({ action: 'continue' });
  });

  it.each([
    ['schemaValid', false, 'response_schema_invalid'],
    ['staleVersionConflict', true, 'stale_version_conflict'],
    ['scopeMismatch', true, 'scope_mismatch'],
    ['contradictoryConstraints', true, 'contradictory_constraints'],
    ['supportedIntent', false, 'unsupported_intent'],
    ['unavailableSelectedItem', true, 'selected_item_unavailable'],
    ['providerRequestedHandoff', true, 'provider_requested_handoff'],
  ] as const)(
    'hands off on the objective %s signal',
    (key, value, reasonCode) => {
      expect(policy.decide({ ...safeSignals, [key]: value })).toEqual({
        action: 'handoff',
        reasonCode,
      });
    },
  );

  it('hands off when authoritative facts, tools, or result identity are unresolved', () => {
    expect(
      policy.decide({
        ...safeSignals,
        missingRequiredFacts: ['allergen_data'],
      }),
    ).toEqual({ action: 'handoff', reasonCode: 'required_fact_missing' });
    expect(policy.decide({ ...safeSignals, toolErrorCount: 1 })).toEqual({
      action: 'handoff',
      reasonCode: 'tool_error',
    });
    expect(policy.decide({ ...safeSignals, ambiguousResultCount: 1 })).toEqual({
      action: 'handoff',
      reasonCode: 'ambiguous_results',
    });
  });

  it('reports a scope mismatch before the generic schema failure', () => {
    expect(
      policy.decide({
        ...safeSignals,
        schemaValid: false,
        scopeMismatch: true,
      }),
    ).toEqual({ action: 'handoff', reasonCode: 'scope_mismatch' });
  });
});
