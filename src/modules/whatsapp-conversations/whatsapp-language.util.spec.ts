import { WhatsappConversationState as State } from './schemas/whatsapp-conversation.schema';
import { WhatsappStandardFlowActionKey as Action } from './whatsapp-standard-flow-action-registry';
import {
  getWhatsappRestaurantSearch,
  resolveWhatsappStandardTextAction as resolve,
} from './whatsapp-text-action.util';

const home = { state: State.PlatformHome, metadata: {} };

describe('natural WhatsApp requests', () => {
  it.each([
    'I wan chop rice and chicken',
    'Abeg I wan rice and chicken',
    'I want some rice and chicken',
    'I would like rice and chicken',
    'Can I get rice and chicken?',
    'Please get rice and chicken',
  ])('recognizes a food request without a restaurant: %s', (text) => {
    expect(getWhatsappRestaurantSearch(home, text)).toEqual({
      itemQuery: 'rice and chicken',
    });
    expect(resolve(home, text)).toBe(Action.OrderEntrySearch);
  });
  it.each([
    'I want to modify my rice order',
    'I want rice again',
    'I want rice and cancel my order',
    'I want rice without chicken',
  ])(
    'leaves modifications and exclusions out of the simple food rule: %s',
    (text) => {
      expect(getWhatsappRestaurantSearch(home, text)).toBeNull();
    },
  );
  it.each([
    ['Choose location', Action.OrderEntryNearby],
    ['I have one in mind', Action.OrderEntrySearch],
  ])('supports the typed food-scope button %s', (text, action) => {
    expect(
      resolve(
        {
          state: State.AwaitingOrderEntryChoice,
          metadata: { standardFlow: { itemQuery: 'rice and chicken' } },
        },
        text,
      ),
    ).toBe(action);
  });
  it.each([
    ['Please show me my orders', Action.HomeMyOrders],
    ['Could you please show me my oders, thanks!', Action.HomeMyOrders],
    ['Kindly find a resturant', Action.OrderEntrySearch],
    ['Can you show my reciept please?', Action.OrdersReceipt],
    ['I would like to place an order', Action.HomePlaceOrder],
    ['Please take me home', null],
    ['Could you show the menu?', Action.NavigationHome],
    ['Do not confirm', null],
    ['Please do not cancel', null],
    ['Please show my orders and cancel one', null],
    ['Please confirm maybe', null],
    ['confrim', null],
    ['cancle', null],
  ])('routes %s conservatively', (text, action) => {
    expect(resolve(home, text)).toBe(action);
  });

  it.each([
    [
      'I want to get rice from Love restaurant',
      { q: 'love', itemQuery: 'rice' },
    ],
    [
      'Please order jollof rice from Madam Love restaurant',
      { q: 'madam love', itemQuery: 'jollof rice' },
    ],
    [
      'Could you find some rice at Mama Tee?',
      { q: 'mama tee', itemQuery: 'rice' },
    ],
    [
      'Get rice from Love restaurant in Lagos',
      { q: 'love', itemQuery: 'rice', city: 'lagos' },
    ],
    ['Find a restaurant called At Home', { q: 'at home' }],
    ['Find Madam Love in Lekki', { q: 'madam love', city: 'lekki' }],
    ['Could you please find a restaurant called Mama Tee?', { q: 'mama tee' }],
    ['Show me restaurants in Lagos', { city: 'lagos' }],
    ['Find Restaurant 24', { q: '24' }],
    ['Find Reciept Kitchen', { q: 'reciept kitchen' }],
  ])(
    'extracts search details from %s without correcting restaurant names',
    (text, query) => {
      expect(resolve(home, text)).toBe(Action.OrderEntrySearch);
      expect(getWhatsappRestaurantSearch(home, text)).toEqual(query);
    },
  );

  it.each([
    'Get my order from Love restaurant',
    'Get rice from Love and cancel my order',
    'Do not get rice from Love',
    'Find rice from Love or Tee',
    'Get the same order from Love',
    'Get rice from Love again',
    'Find my orders',
    'Find my address',
    'Find my receipt and pay',
    'Find a restaurant',
    '12 Find Street',
    'Find ' + 'x'.repeat(121),
  ])('does not invent a search from %s', (text) => {
    expect(getWhatsappRestaurantSearch(home, text)).toBeNull();
  });

  it('keeps delivery addresses, email, and requested restaurant names as free text', () => {
    for (const state of [
      State.AwaitingDeliveryAddress,
      State.AwaitingEmail,
      State.AwaitingRestaurantSearch,
    ]) {
      expect(resolve({ state, metadata: {} }, 'Please Eat Kitchen')).toBeNull();
      expect(
        getWhatsappRestaurantSearch(
          { state },
          'I want to get rice from Love restaurant',
        ),
      ).toBeNull();
      expect(
        getWhatsappRestaurantSearch({ state }, 'Find Madam Love in Lekki'),
      ).toBeNull();
    }
  });

  const list = {
    state: State.ViewingOrders,
    metadata: {
      standardFlow: {
        orderCandidates: [{ orderId: 'order_new' }, { orderId: 'order_old' }],
      },
    },
  };
  it.each([
    ['the latest one', 'order.select:order_new'],
    ['please show me the latest one', 'order.select:order_new'],
    ['the second one', 'order.select:order_old'],
    ['2', 'order.select:order_old'],
    ['last', 'order.select:order_old'],
    ['that one', Action.NavigationClarify],
    ['the third one', Action.NavigationClarify],
  ])('resolves %s only against the displayed list', (text, action) => {
    expect(resolve(list, text)).toBe(action);
  });

  it('resolves branch choices, without treating checkout numbers as selections', () => {
    expect(
      resolve(
        {
          state: State.AwaitingBranchSelection,
          metadata: {
            standardFlow: { branchCandidates: [{ branchId: 'branch_1' }] },
          },
        },
        'that one',
      ),
    ).toBe('branch.select:branch_1');
    expect(
      resolve(
        { state: State.AwaitingConfirmation, metadata: list.metadata },
        '1',
      ),
    ).toBeNull();
    expect(resolve(home, 'the latest one')).toBeNull();
  });

  it.each([
    'Has it been accepted?',
    'Is it ready?',
    'Could you please tell me what is its status?',
  ])('uses current order facts for %s', (text) => {
    expect(resolve({ state: State.ViewingOrder, metadata: {} }, text)).toBe(
      Action.OrdersTrack,
    );
  });
});
