import { CustomerAiResponseCompilerService } from './customer-ai-response-compiler.service';
import type { CustomerAiRunScopedFact } from './customer-ai.types';

describe('CustomerAiResponseCompilerService', () => {
  const compiler = new CustomerAiResponseCompilerService();

  it('renders money and availability only from authoritative item facts', () => {
    const facts = new Map<string, CustomerAiRunScopedFact>([
      [
        'ref_burger',
        {
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
        },
      ],
    ]);

    expect(
      compiler.compile(
        {
          responseType: 'menu_recommendation',
          itemRefs: ['ref_burger'],
          introduction: 'Here is a close match:',
        },
        facts,
      ),
    ).toEqual({
      status: 'compiled',
      text: 'Here is a close match:\nChicken Burger — ₦8,500 — Available',
      authoritativeFactCount: 2,
    });
  });

  it('rejects unknown references instead of inventing details', () => {
    expect(
      compiler.compile(
        {
          responseType: 'menu_recommendation',
          itemRefs: ['ref_missing'],
        },
        new Map(),
      ),
    ).toEqual({ status: 'rejected', reasonCode: 'invalid_menu_item_ref' });
  });

  it.each([
    'That costs ₦8,000.',
    'The item is available.',
    'Your payment is confirmed.',
    'Your total is 25.',
  ])('rejects transactional claims in low-risk model text: %s', (text) => {
    expect(
      compiler.compile({ responseType: 'low_risk_text', text }, new Map()),
    ).toEqual({
      status: 'rejected',
      reasonCode: 'uncompiled_transactional_claim',
    });
  });
});
