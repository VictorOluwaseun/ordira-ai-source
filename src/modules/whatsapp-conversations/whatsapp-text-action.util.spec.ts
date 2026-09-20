import { WhatsappConversationState as State } from './schemas/whatsapp-conversation.schema';
import { WhatsappStandardFlowActionKey as Action } from './whatsapp-standard-flow-action-registry';
import {
  isWhatsappHomeCommand,
  normalizeWhatsappActionText,
  resolveWhatsappStandardTextAction as resolve,
} from './whatsapp-text-action.util';

describe('WhatsApp home greetings', () => {
  it.each([
    'hi',
    'Hey',
    'hello',
    '👋 HI!',
    'Hello there',
    'hey there!',
    'hi there',
    'hiya',
    'howdy',
    'yo',
    'greetings',
    'Good morning!',
    '  GOOD   AFTERNOON  ',
    'good evening',
    '👋🏽 Hey!!! 👋',
    'ＨＥＬＬＯ！',
    'start',
    'menu',
    'home',
  ])('recognizes the whole greeting %s', (text) => {
    expect(isWhatsappHomeCommand(text)).toBe(true);
  });

  it.each([
    null,
    undefined,
    '',
    '👋',
    '!!!',
    'Hi Street',
    '12 Hello Road',
    'hello@example.com',
    'hey please change my order',
    'good morning cafe',
    'highlight',
    'yoghurt',
    'home delivery',
  ])('does not consume other input: %s', (text) => {
    expect(isWhatsappHomeCommand(text)).toBe(false);
  });
});

describe('typed WhatsApp actions', () => {
  it.each([
    ['find', Action.NavigationDiscover],
    ['show', Action.NavigationDiscover],
    ['show me', Action.NavigationDiscover],
    ['search', Action.NavigationDiscover],
    ['find a restaurant', Action.OrderEntrySearch],
    ['find restaurants', Action.OrderEntrySearch],
    ['find a restaurants', Action.OrderEntrySearch],
    ['show restaurants', Action.OrderEntrySearch],
    ['show me a restaurant', Action.OrderEntrySearch],
    ['search for a restaurant', Action.OrderEntrySearch],
    ['look for restaurants', Action.OrderEntrySearch],
    ['find my order', Action.OrdersCurrent],
    ['show my order', Action.OrdersCurrent],
    ['show my orders', Action.HomeMyOrders],
    ['show me my orders', Action.HomeMyOrders],
    ['show order history', Action.HomeMyOrders],
    ['show my receipt', Action.OrdersReceipt],
    ['find my payment receipt', Action.OrdersPaymentReceipt],
    ['show the menu', Action.NavigationHome],
  ])('understands discovery phrase %s', (text, action) => {
    expect(
      resolve(
        { state: State.PlatformHome, metadata: {} },
        ` 🔎 ${text.toUpperCase()}? `,
      ),
    ).toBe(action);
  });
  it('accepts typed choices for the discovery question without swallowing free text', () => {
    const conversation = {
      state: State.AwaitingHomeAction,
      metadata: { standardFlow: { discoveryPrompt: true } },
    };
    expect(resolve(conversation, 'Restaurants')).toBe(Action.OrderEntrySearch);
    expect(resolve(conversation, 'Current order')).toBe(Action.OrdersCurrent);
    expect(resolve(conversation, 'Order history')).toBe(Action.HomeMyOrders);
    for (const state of [
      State.AwaitingRestaurantSearch,
      State.AwaitingDeliveryAddress,
      State.AwaitingEmail,
    ]) {
      for (const text of [
        'find',
        'show',
        'find a restaurant',
        'Show Restaurant on Find Street',
      ]) {
        expect(resolve({ state, metadata: {} }, text)).toBeNull();
      }
    }
    expect(resolve(conversation, 'show my orders to somebody else')).toBeNull();
  });
  it.each([
    ['my order', Action.OrdersCurrent],
    ['order status', Action.OrdersCurrent],
    ['where is my order', Action.OrdersCurrent],
    ['track my order', Action.OrdersCurrent],
    ['my orders', Action.HomeMyOrders],
    ['past orders', Action.HomeMyOrders],
    ['order history', Action.HomeMyOrders],
    ['new order', Action.HomePlaceOrder],
    ['order food', Action.HomePlaceOrder],
    ['near me', Action.OrderEntryNearby],
    ['nearby', Action.OrderEntryNearby],
    ['find restaurants', Action.OrderEntrySearch],
    ['pay', Action.OrdersPay],
    ['make payment', Action.OrdersPay],
    ['payment link', Action.OrdersPay],
    ['receipt', Action.OrdersReceipt],
    ['my receipt', Action.OrdersReceipt],
    ['payment receipt', Action.OrdersPaymentReceipt],
    ['help', Action.AccountHelp],
    ['support', Action.AccountHelp],
    ['contact support', Action.AccountHelp],
    ['cancel', Action.OrdersCancelHelp],
  ])('maps the phrase %s', (text, action) => {
    expect(
      resolve(
        { state: State.PlatformHome, metadata: {} },
        ` 👋 ${text.toUpperCase()}  `,
      ),
    ).toBe(action);
  });
  it('uses the selected order for status and leaves checkout choices to checkout', () => {
    expect(
      resolve({ state: State.ViewingOrder, metadata: {} }, 'track my order'),
    ).toBe(Action.OrdersTrack);
    for (const text of [
      'yes',
      'confirm',
      'change',
      'edit',
      'cancel',
      'help',
      'support',
    ]) {
      expect(
        resolve({ state: State.AwaitingConfirmation, metadata: {} }, text),
      ).toBeNull();
    }
    expect(isWhatsappHomeCommand('Main menu')).toBe(true);
  });
  it.each(Object.values(State))(
    'accepts explicit order commands in %s',
    (state) => {
      expect(resolve({ state, metadata: {} }, '  📋 ORDER  ')).toBe(
        Action.OrdersCurrent,
      );
      expect(resolve({ state, metadata: {} }, ' 🧾 Orders ')).toBe(
        Action.HomeMyOrders,
      );
      expect(resolve({ state, metadata: {} }, '12 Order Street')).toBeNull();
    },
  );
  it.each([
    'Place an order',
    'Place my order',
    '🍽️ Place an order',
    '  PLACE\n AN  ORDER ',
    'Ｐｌａｃｅ an order',
  ])('normalizes %s', (text) => {
    expect(resolve({ state: State.PlatformHome, metadata: {} }, text)).toBe(
      Action.HomePlaceOrder,
    );
  });
  it.each([
    [State.PlatformHome, 'My orders', Action.HomeMyOrders],
    [State.PlatformHome, 'Account and help', Action.HomeAccountHelp],
    [State.AwaitingOrderEntryChoice, '🔎 SEARCH', Action.OrderEntrySearch],
    [State.AwaitingOrderEntryChoice, 'Near me', Action.OrderEntryNearby],
    [State.AccountMenu, 'Update email', Action.AccountEmail],
    [State.AccountMenu, 'Preferences', Action.AccountNotifications],
    [State.AccountMenu, 'Help', Action.AccountHelp],
    [State.ViewingOrder, 'Order status', Action.OrdersTrack],
    [State.ViewingOrder, 'Pay', Action.OrdersPay],
  ])('matches only the current menu: %s / %s', (state, text, action) => {
    expect(resolve({ state, metadata: {} }, text)).toBe(action);
  });
  it.each([
    State.AwaitingRestaurantSearch,
    State.AwaitingEmail,
    State.AwaitingDeliveryAddress,
    State.AwaitingConfirmation,
  ])(
    'does not treat free text or checkout input as a home selection in %s',
    (state) => {
      expect(resolve({ state, metadata: {} }, 'Place an order')).toBeNull();
      expect(resolve({ state, metadata: {} }, 'Search')).toBeNull();
    },
  );
  it('rejects partial labels and ambiguous customized labels', () => {
    expect(
      resolve(
        { state: State.PlatformHome, metadata: {} },
        'please place an order for someone else',
      ),
    ).toBeNull();
    expect(
      resolve(
        {
          state: State.PlatformHome,
          metadata: {
            standardFlowCopy: {
              actionLabels: {
                [Action.HomePlaceOrder]: 'Choose',
                [Action.HomeMyOrders]: 'Choose',
              },
            },
          },
        },
        'choose',
      ),
    ).toBeNull();
  });
  it('matches customized labels without emojis', () => {
    expect(
      resolve(
        {
          state: State.PlatformHome,
          metadata: {
            standardFlowCopy: {
              actionLabels: { [Action.HomePlaceOrder]: '🍴 Order food' },
            },
          },
        },
        'ORDER food',
      ),
    ).toBe(Action.HomePlaceOrder);
  });
  it('matches only displayed branch candidates and refuses duplicate labels', () => {
    const branch = {
      branchId: 'branch_1',
      restaurantName: 'Mama Tee',
      branchName: 'Lekki',
    };
    const conversation = {
      state: State.AwaitingBranchSelection,
      metadata: { standardFlow: { branchCandidates: [branch] } },
    };
    expect(resolve(conversation, 'Mama Tee - Lekki')).toBe(
      'branch.select:branch_1',
    );
    conversation.metadata.standardFlow.branchCandidates.push({
      ...branch,
      branchId: 'branch_2',
    });
    expect(resolve(conversation, 'Mama Tee - Lekki')).toBeNull();
    expect(resolve(conversation, 'branch_1')).toBeNull();
  });
  it('matches a current order reference, but not an arbitrary order', () => {
    const conversation = {
      state: State.ViewingOrders,
      metadata: {
        standardFlow: {
          orderCandidates: [
            { orderId: 'order_1', publicCode: 'ORD-260919-ABCDEFGHIJ' },
          ],
        },
      },
    };
    expect(resolve(conversation, '🧾 ord-260919-abcdefghij')).toBe(
      'order.select:order_1',
    );
    expect(resolve(conversation, 'ORD-260919-ZZZZZZZZZZ')).toBeNull();
  });
  it('offers receipt for a paid order and matches the displayed preference toggle', () => {
    expect(
      resolve(
        {
          state: State.ViewingOrder,
          metadata: {
            standardFlow: { selectedOrder: { paymentStatus: 'paid' } },
          },
        },
        'Receipt',
      ),
    ).toBe(Action.OrdersReceipt);
    expect(
      resolve(
        {
          state: State.NotificationPreferences,
          metadata: {
            standardFlow: {
              notificationPreferences: { whatsappMarketing: false },
            },
          },
        },
        'WhatsApp promos on',
      ),
    ).toBe(Action.NotificationsWhatsappMarketingOn);
  });
  it('ignores decorative emoji sequences without dropping ordinary digits', () => {
    expect(normalizeWhatsappActionText('👩🏽‍🍳  CONFIRM  ')).toBe('confirm');
    expect(normalizeWhatsappActionText('1')).toBe('1');
    expect(normalizeWhatsappActionText('🍽️')).toBe('');
  });
});
