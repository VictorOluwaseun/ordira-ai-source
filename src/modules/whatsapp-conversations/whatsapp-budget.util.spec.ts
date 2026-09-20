import { extractWhatsappBudgetSearch } from './whatsapp-budget.util';
import { getWhatsappRestaurantSearch } from './whatsapp-text-action.util';
import { WhatsappConversationState as State } from './schemas/whatsapp-conversation.schema';

const home = { state: State.PlatformHome };
describe('WhatsApp budget extraction', () => {
  it.each([
    'What food can I get for N5000',
    'What can I get for 5,000',
    'What can I get for 5,000 naira',
    'What food can I get for ₦5,000?',
    'Show me meals within NGN 5000',
    'Find food under 5k',
    'what food can i get for 5000 naira',
  ])('recognizes %s without AI', (text) => {
    expect(getWhatsappRestaurantSearch(home, text)).toEqual({
      budget: {
        maxPriceMinorUnit: 500000,
        currency: 'NGN',
        includesDelivery: false,
      },
    });
  });
  it('extracts dish, restaurant and delivery inclusion without conflating prices', () => {
    expect(
      extractWhatsappBudgetSearch(
        'get rice for n5000 from love restaurant including delivery',
      ),
    ).toEqual({
      q: 'love',
      itemQuery: 'rice',
      budget: {
        maxPriceMinorUnit: 500000,
        currency: 'NGN',
        includesDelivery: true,
      },
    });
  });
  it.each([
    'get food for $5000',
    'get food for n0',
    'get food for n-5000',
    'get food for n5,00',
    'get food for n5000 or n6000',
    'get food for n1000001',
    'get food for n5000 each',
    'get food for n5000 for 3 people',
    'get food for n5000 and cancel my order',
  ])('does not silently accept %s', (text) => {
    expect(extractWhatsappBudgetSearch(text)).toBeNull();
  });
  it('preserves exact kobo and does not treat checkout data as a budget command', () => {
    expect(
      extractWhatsappBudgetSearch('get food for n5000.25')?.budget
        .maxPriceMinorUnit,
    ).toBe(500025);
    expect(
      getWhatsappRestaurantSearch(
        { state: State.AwaitingDeliveryAddress },
        'get food for n5000',
      ),
    ).toBeNull();
  });
});
