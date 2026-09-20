import { validateCustomerAiEvalToolArguments } from './customer-ai-eval-tool-contract';

describe('customer AI evaluation tool contract', () => {
  it('accepts bounded read-only search arguments', () => {
    expect(
      validateCustomerAiEvalToolArguments('search_menu_items', {
        q: 'burger',
        city: null,
        state: null,
        country: 'NG',
        lat: 6.45,
        lng: 3.47,
        radiusKm: 5,
        limit: 4,
        fulfillmentType: 'delivery',
      }),
    ).toBeNull();
  });

  it.each([
    ['unknown field', { q: 'burger', includePrivate: true }],
    ['string coordinate', { lat: '6.45', lng: 3.47 }],
    ['partial coordinate', { lat: 6.45 }],
    ['oversized result limit', { limit: 5 }],
    ['unsupported fulfillment type', { fulfillmentType: 'drone' }],
  ])('rejects %s', (_label, args) => {
    expect(
      validateCustomerAiEvalToolArguments('search_menu_items', args),
    ).not.toBeNull();
  });
});
