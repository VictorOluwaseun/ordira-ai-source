import { CustomerAiPolicyEvidenceService } from './customer-ai-policy-evidence.service';
import type {
  CustomerAiResponsePlan,
  CustomerAiRunScopedFact,
} from './customer-ai.types';

describe('CustomerAiPolicyEvidenceService', () => {
  const evidence = new CustomerAiPolicyEvidenceService();

  it('keeps an ordinary authoritative menu recommendation eligible', () => {
    expect(
      evidence.collect(
        createInput({
          responsePlan: {
            responseType: 'menu_recommendation',
            itemRefs: ['ref_burger'],
          },
          facts: [menuFact()],
        }),
      ),
    ).toEqual({
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
    });
  });

  it('recognizes an unknown or wrong-kind ref as a scope mismatch', () => {
    const signals = evidence.collect(
      createInput({
        responsePlan: {
          responseType: 'menu_recommendation',
          itemRefs: ['ref_not_from_this_run'],
        },
        compiled: {
          status: 'rejected',
          reasonCode: 'invalid_menu_item_ref',
        },
      }),
    );

    expect(signals).toEqual(
      expect.objectContaining({ schemaValid: false, scopeMismatch: true }),
    );
  });

  it('detects unavailable selections and fulfillment conflicts', () => {
    const signals = evidence.collect(
      createInput({
        customerMessage: 'I need this delivered',
        responsePlan: {
          responseType: 'menu_recommendation',
          itemRefs: ['ref_burger'],
        },
        facts: [menuFact({ orderable: false, deliveryEnabled: false })],
      }),
    );

    expect(signals).toEqual(
      expect.objectContaining({
        unavailableSelectedItem: true,
        contradictoryConstraints: true,
      }),
    );
  });

  it('identifies fact domains unavailable from the current read tools', () => {
    const signals = evidence.collect(
      createInput({
        customerMessage:
          'Is it peanut free, what is my order total and delivery fee to my address?',
        responsePlan: {
          responseType: 'menu_recommendation',
          itemRefs: ['ref_burger'],
        },
        facts: [menuFact()],
      }),
    );

    expect(signals.missingRequiredFacts).toEqual([
      'allergen_data',
      'checkout_total',
      'delivery_eligibility',
      'delivery_fee',
    ]);
  });

  it.each([
    'Refund this charge',
    'What is my payment status?',
    'Track my order',
    'Cancel my order',
    'Confirm the order',
    'Place my order',
  ])(
    'marks deterministic-only or restricted intent as unsupported: %s',
    (message) => {
      expect(
        evidence.collect(createInput({ customerMessage: message }))
          .supportedIntent,
      ).toBe(false);
    },
  );

  it('counts duplicate selected names as unresolved ambiguity', () => {
    const signals = evidence.collect(
      createInput({
        responsePlan: {
          responseType: 'menu_recommendation',
          itemRefs: ['ref_burger', 'ref_burger_2'],
        },
        facts: [
          menuFact(),
          menuFact({ ref: 'ref_burger_2', branchName: 'Ikeja' }),
        ],
      }),
    );

    expect(signals.ambiguousResultCount).toBe(2);
  });

  it('records provider-requested caution without treating it as confidence', () => {
    expect(
      evidence.collect(
        createInput({
          responsePlan: { responseType: 'handoff', reasonCode: 'unclear' },
        }),
      ).providerRequestedHandoff,
    ).toBe(true);
  });

  it('requires a selected branch during the selection phase', () => {
    const restaurant: CustomerAiRunScopedFact = {
      kind: 'restaurant',
      ref: 'ref_restaurant',
      name: 'Example Kitchen',
      restaurantName: 'Example Kitchen',
      branchName: null,
      cuisines: ['Nigerian'],
      pickupEnabled: true,
      deliveryEnabled: true,
    };
    const signals = evidence.collect(
      createInput({
        phase: 'selection',
        responsePlan: {
          responseType: 'restaurant_recommendation',
          restaurantRefs: ['ref_restaurant'],
        },
        facts: [restaurant],
      }),
    );

    expect(signals.missingRequiredFacts).toContain('selected_branch');
  });
});

function createInput(
  overrides: {
    customerMessage?: string;
    phase?: 'discovery' | 'selection';
    responsePlan?: CustomerAiResponsePlan;
    compiled?:
      | { status: 'compiled'; text: string; authoritativeFactCount: number }
      | { status: 'rejected'; reasonCode: string };
    facts?: CustomerAiRunScopedFact[];
  } = {},
) {
  const facts = overrides.facts ?? [];

  return {
    customerMessage: overrides.customerMessage ?? 'Show me burgers',
    phase: overrides.phase ?? ('discovery' as const),
    responsePlan:
      overrides.responsePlan ??
      ({
        responseType: 'low_risk_text',
        text: 'What would you like?',
      } as const),
    compiled: overrides.compiled ?? {
      status: 'compiled' as const,
      text: 'Safe text',
      authoritativeFactCount: 0,
    },
    factsByRef: new Map(facts.map((fact) => [fact.ref, fact])),
    toolErrorCount: 0,
    staleVersionConflict: false,
  };
}

function menuFact(
  overrides: Partial<
    Extract<CustomerAiRunScopedFact, { kind: 'menu_item' }>
  > = {},
): Extract<CustomerAiRunScopedFact, { kind: 'menu_item' }> {
  return {
    kind: 'menu_item',
    ref: 'ref_burger',
    name: 'Chicken Burger',
    priceMinorUnit: 850000,
    currency: 'NGN',
    orderable: true,
    restaurantName: 'Example Kitchen',
    branchName: 'Lekki',
    pickupEnabled: true,
    deliveryEnabled: true,
    ...overrides,
  };
}
