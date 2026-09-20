import {
  readCustomerFollowup,
  freshConversationContext,
} from './whatsapp-followup.util';
import { toNullableRecord as readRecord } from '@common/utils/object.util';
import { DEFAULT_PLATFORM_CUSTOMER_COMMUNICATION_PREFERENCES } from '@modules/customers/schemas/platform-customer-identity.schema';
import {
  WhatsappConversationState as State,
  type WhatsappConversationRecord,
} from './schemas/whatsapp-conversation.schema';
import {
  WhatsappStandardFlowActionKey as Action,
  WHATSAPP_STANDARD_FLOW_HOME_ACTIONS,
  createBranchSelectActionId,
  createOrderSelectActionId,
} from './whatsapp-standard-flow-action-registry';
import { getWhatsappStandardFlowActionLabel } from './whatsapp-standard-flow-copy.registry';
import {
  extractWhatsappRestaurantSearch,
  normalizeWhatsappCommandWording,
  resolveWhatsappContextualFollowup,
  type WhatsappRestaurantSearch,
} from './whatsapp-language.util';

export function normalizeWhatsappActionText(
  text: string | null | undefined,
): string {
  return (text ?? '')
    .normalize('NFKC')
    .replace(
      /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\uFE0F|\uFE0E|\u200D|\u20E3/gu,
      '',
    )
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const homeCommands = new Set([
  'hi',
  'hey',
  'hello',
  'hi there',
  'hey there',
  'hello there',
  'hiya',
  'howdy',
  'yo',
  'greetings',
  'good morning',
  'good afternoon',
  'good evening',
  'start',
  'menu',
  'main menu',
  'home',
]);

/** Only whole greetings open home; preserve longer messages and addresses. */
export function isWhatsappHomeCommand(
  text: string | null | undefined,
): boolean {
  const normalized = normalizeWhatsappActionText(text)
    .replace(/^[\s.,!?…]+|[\s.,!?…]+$/gu, '')
    .trim();
  return homeCommands.has(normalized);
}

const homeStates: readonly string[] = [
  State.New,
  State.PlatformHome,
  State.AwaitingHomeAction,
  State.OrderCreated,
  State.Closed,
  State.StorefrontHandoff,
];
const standardStates: readonly string[] = [
  State.PlatformHome,
  State.AwaitingHomeAction,
  State.AwaitingOrderEntryChoice,
  State.AwaitingLocation,
  State.AwaitingRestaurantSearch,
  State.AwaitingRestaurantSelection,
  State.AwaitingBranchSelection,
  State.ViewingOrders,
  State.ViewingOrder,
  State.AccountMenu,
  State.AwaitingEmail,
  State.AwaitingEmailVerification,
  State.NotificationPreferences,
];

const discoveryNavigationStates: readonly string[] = [
  ...homeStates,
  State.AwaitingOrderEntryChoice,
  State.AwaitingLocation,
  State.AwaitingRestaurantSelection,
  State.AwaitingBranchSelection,
  State.AccountMenu,
  State.ViewingOrders,
  State.ViewingOrder,
];

export function isWhatsappStandardFlowState(state: string): boolean {
  return standardStates.includes(state);
}

/** Match whole labels for the current step, never substrings or guesses. */
export function resolveWhatsappStandardTextAction(
  conversation: Pick<WhatsappConversationRecord, 'state' | 'metadata'>,
  text: string | null | undefined,
): string | null {
  const pending = freshConversationContext(
    readRecord(conversation.metadata.standardFlow)?.pendingAssist,
  );
  const answer = normalizeWhatsappActionText(text);
  if (
    conversation.state === State.AwaitingOrderEntryChoice &&
    answer === 'i know what i want'
  )
    return Action.TellFood;
  if (
    conversation.state === State.AwaitingOrderEntryChoice &&
    answer === 'find nearby'
  )
    return Action.OrderEntryNearby;
  if (pending?.kind === 'group_budget') {
    if (['total', 'total budget', 'for both', 'for everyone'].includes(answer))
      return Action.BudgetTotal;
    if (['each', 'per person', 'each person'].includes(answer))
      return Action.BudgetPerPerson;
  }
  if (pending?.kind === 'reorder' && answer === 'review new order')
    return Action.RepeatDraft;
  if (readCustomerFollowup(conversation, text))
    return Action.ConversationAssist;
  const exact = resolveExactWhatsappTextAction(conversation, text);
  if (exact) return exact;
  const normalized = normalizeWhatsappActionText(text);
  const wording = normalizeWhatsappCommandWording(normalized);
  if (isWhatsappHomeCommand(wording)) return Action.NavigationHome;
  const natural =
    wording !== normalized
      ? resolveExactWhatsappTextAction(conversation, wording)
      : null;
  if (natural) return natural;
  const followup = resolveWhatsappContextualFollowup(conversation, wording);
  if (followup) return followup;
  if (getWhatsappRestaurantSearch(conversation, text))
    return Action.OrderEntrySearch;
  return null;
}

export function getWhatsappRestaurantSearch(
  conversation: Pick<WhatsappConversationRecord, 'state'>,
  text: string | null | undefined,
): WhatsappRestaurantSearch | null {
  if (!discoveryNavigationStates.includes(conversation.state)) return null;
  return extractWhatsappRestaurantSearch(normalizeWhatsappActionText(text));
}

function resolveExactWhatsappTextAction(
  conversation: Pick<WhatsappConversationRecord, 'state' | 'metadata'>,
  text: string | null | undefined,
): string | null {
  const normalized = normalizeWhatsappActionText(text);
  if (!normalized) return null;
  // Explicit global commands, distinct from starting a new order.
  const { state, metadata } = conversation;
  const phrase = normalized.replace(/[.!?…]+$/u, '').trim();
  const discoveryTarget =
    /^(?:find|find me|show|show me|search for|look for) (?:a |an |the |my )?(restaurant|restaurants|order|orders|order history|receipt|payment receipt|menu)$/.exec(
      phrase,
    )?.[1];
  if (discoveryTarget === 'order') return Action.OrdersCurrent;
  if (discoveryTarget === 'orders' || discoveryTarget === 'order history')
    return Action.HomeMyOrders;
  if (discoveryTarget === 'receipt') return Action.OrdersReceipt;
  if (discoveryTarget === 'payment receipt') return Action.OrdersPaymentReceipt;
  if (discoveryTarget === 'menu') return Action.NavigationHome;
  if (discoveryNavigationStates.includes(state)) {
    if (
      ['find', 'find me', 'show', 'show me', 'search', 'look for'].includes(
        phrase,
      ) &&
      !(phrase === 'search' && state === State.AwaitingOrderEntryChoice)
    )
      return Action.NavigationDiscover;
    if (discoveryTarget === 'restaurant' || discoveryTarget === 'restaurants')
      return Action.OrderEntrySearch;
  }
  if (
    state === State.AwaitingHomeAction &&
    readRecord(metadata.standardFlow)?.discoveryPrompt === true
  ) {
    if (['restaurant', 'restaurants', 'a restaurant'].includes(phrase))
      return Action.OrderEntrySearch;
    if (phrase === 'current order') return Action.OrdersCurrent;
  }
  if (['order', 'my order'].includes(normalized)) return Action.OrdersCurrent;
  if (
    ['order status', 'where is my order', 'track my order'].includes(normalized)
  )
    return state === State.ViewingOrder
      ? Action.OrdersTrack
      : Action.OrdersCurrent;
  if (
    ['orders', 'my orders', 'past orders', 'order history'].includes(normalized)
  )
    return Action.HomeMyOrders;
  if (['pay', 'make payment', 'payment link'].includes(normalized))
    return Action.OrdersPay;
  if (['receipt', 'my receipt'].includes(normalized))
    return Action.OrdersReceipt;
  if (normalized === 'payment receipt') return Action.OrdersPaymentReceipt;
  const checkoutStates: readonly string[] = [
    State.AwaitingFulfillment,
    State.AwaitingDeliveryAddress,
    State.AwaitingConfirmation,
  ];
  if (!checkoutStates.includes(state)) {
    if (['help', 'support', 'contact support'].includes(normalized))
      return Action.AccountHelp;
    if (['cancel', 'stop', 'cancel order'].includes(normalized))
      return Action.OrdersCancelHelp;
  }
  const flow = readRecord(metadata.standardFlow);
  if (
    state === State.AwaitingOrderEntryChoice &&
    typeof flow?.itemQuery === 'string'
  ) {
    if (
      [
        'choose location',
        'share location',
        'closest to me',
        'find one near me',
      ].includes(phrase)
    )
      return Action.OrderEntryNearby;
    if (
      [
        'i have one in mind',
        'have one in mind',
        'a restaurant in mind',
      ].includes(phrase)
    )
      return Action.OrderEntrySearch;
  }
  const copy =
    readRecord(metadata.standardFlowCopy) ??
    readRecord(metadata.platformExperienceCopy);
  const overrides = readRecord(copy?.actionLabels);
  const options: Array<{ id: string; title: string }> = [];
  const addActions = (keys: readonly Action[], useOverrides = false) => {
    for (const key of keys) {
      const override = useOverrides ? overrides?.[key] : undefined;
      options.push({
        id: key,
        title:
          typeof override === 'string' && override.trim()
            ? override
            : getWhatsappStandardFlowActionLabel(key),
      });
    }
  };
  if (homeStates.includes(state)) {
    addActions(WHATSAPP_STANDARD_FLOW_HOME_ACTIONS, true);
    options.push({ id: Action.HomePlaceOrder, title: 'Place my order' });
  }
  const navigationStates: readonly string[] = [
    State.AwaitingOrderEntryChoice,
    State.AccountMenu,
    State.ViewingOrders,
    State.ViewingOrder,
  ];
  if (homeStates.includes(state) || navigationStates.includes(state)) {
    if (
      ['place an order', 'place my order', 'new order', 'order food'].includes(
        normalized,
      )
    )
      return Action.HomePlaceOrder;
    if (['near me', 'nearby'].includes(normalized))
      return Action.OrderEntryNearby;
    if (normalized === 'find restaurants') return Action.OrderEntrySearch;
  }
  if (state === State.AwaitingOrderEntryChoice)
    addActions(
      [
        Action.OrderEntryNearby,
        Action.OrderEntrySearch,
        Action.OrderEntryRecent,
      ],
      true,
    );
  if (state === State.AccountMenu)
    addActions(
      [
        Action.AccountEmail,
        Action.AccountNotifications,
        Action.AccountHelp,
        Action.NavigationHome,
      ],
      true,
    );
  if (state === State.ViewingOrder) {
    const order = readRecord(flow?.selectedOrder);
    addActions([
      Action.OrdersTrack,
      order?.paymentStatus === 'paid' ? Action.OrdersReceipt : Action.OrdersPay,
      Action.NavigationHome,
    ]);
  }
  if (state === State.NotificationPreferences) {
    const preferences = readRecord(flow?.notificationPreferences);
    for (const [key, on, off] of [
      [
        'whatsappTransactional',
        Action.NotificationsWhatsappTransactionalOn,
        Action.NotificationsWhatsappTransactionalOff,
      ],
      [
        'emailTransactional',
        Action.NotificationsEmailTransactionalOn,
        Action.NotificationsEmailTransactionalOff,
      ],
      [
        'whatsappMarketing',
        Action.NotificationsWhatsappMarketingOn,
        Action.NotificationsWhatsappMarketingOff,
      ],
      [
        'emailMarketing',
        Action.NotificationsEmailMarketingOn,
        Action.NotificationsEmailMarketingOff,
      ],
    ] as const) {
      const enabled =
        typeof preferences?.[key] === 'boolean'
          ? preferences[key]
          : DEFAULT_PLATFORM_CUSTOMER_COMMUNICATION_PREFERENCES[key];
      addActions([enabled ? off : on]);
    }
  }
  if (
    state === State.AwaitingBranchSelection &&
    Array.isArray(flow?.branchCandidates)
  ) {
    for (const value of flow.branchCandidates.slice(0, 10)) {
      const branch = readRecord(value);
      if (
        typeof branch?.branchId !== 'string' ||
        typeof branch.restaurantName !== 'string' ||
        typeof branch.branchName !== 'string'
      )
        continue;
      const title = `${branch.restaurantName} - ${branch.branchName}`;
      const id = createBranchSelectActionId(branch.branchId);
      options.push({ id, title }, { id, title: truncateLabel(title, 24) });
    }
  }
  if (state === State.ViewingOrders && Array.isArray(flow?.orderCandidates)) {
    for (const value of flow.orderCandidates) {
      const order = readRecord(value);
      if (
        typeof order?.orderId === 'string' &&
        typeof order.publicCode === 'string'
      ) {
        options.push({
          id: createOrderSelectActionId(order.orderId),
          title: order.publicCode,
        });
      }
    }
  }
  const matches = new Set(
    options
      .filter(
        (option) => normalizeWhatsappActionText(option.title) === normalized,
      )
      .map((option) => option.id),
  );
  return matches.size === 1 ? [...matches][0] : null;
}

function truncateLabel(label: string, maxLength: number): string {
  return label.length <= maxLength
    ? label
    : `${label.slice(0, maxLength - 1).trimEnd()}…`;
}
