export const WhatsappStandardFlowActionKey = {
  ConversationAssist: 'conversation.assist',
  TellFood: 'conversation.tell_food',
  BudgetTotal: 'conversation.budget_total',
  BudgetPerPerson: 'conversation.budget_person',
  RepeatDraft: 'conversation.repeat_draft',
  HomePlaceOrder: 'home.place_order',
  HomeMyOrders: 'home.my_orders',
  HomeAccountHelp: 'home.account_help',
  OrderEntryNearby: 'order_entry.nearby',
  OrderEntrySearch: 'order_entry.search',
  OrderEntryRecent: 'order_entry.recent',
  NavigationHome: 'navigation.home',
  NavigationDiscover: 'navigation.discover',
  NavigationClarify: 'navigation.clarify',
  NavigationChangeRestaurant: 'navigation.change_restaurant',
  NavigationChangeBranch: 'navigation.change_branch',
  NavigationCancelCheckout: 'navigation.cancel_checkout',
  OrdersMore: 'orders.more',
  OrdersCurrent: 'orders.current',
  OrdersSelect: 'orders.select',
  OrdersTrack: 'orders.track',
  OrdersReceipt: 'orders.receipt',
  OrdersPaymentReceipt: 'orders.payment_receipt',
  OrdersCancelHelp: 'orders.cancel_help',
  OrdersPay: 'orders.pay',
  AccountEmail: 'account.email',
  AccountNotifications: 'account.notifications',
  AccountHelp: 'account.help',
  NotificationsWhatsappMarketingOn: 'notifications.whatsapp_marketing_on',
  NotificationsWhatsappMarketingOff: 'notifications.whatsapp_marketing_off',
  NotificationsEmailMarketingOn: 'notifications.email_marketing_on',
  NotificationsEmailMarketingOff: 'notifications.email_marketing_off',
  NotificationsWhatsappTransactionalOn:
    'notifications.whatsapp_transactional_on',
  NotificationsWhatsappTransactionalOff:
    'notifications.whatsapp_transactional_off',
  NotificationsEmailTransactionalOn: 'notifications.email_transactional_on',
  NotificationsEmailTransactionalOff: 'notifications.email_transactional_off',
} as const;

export type WhatsappStandardFlowActionKey =
  (typeof WhatsappStandardFlowActionKey)[keyof typeof WhatsappStandardFlowActionKey];

export type WhatsappStandardFlowParsedAction =
  | {
      type: 'meal_select';
      questionId: string;
      index: number;
    }
  | {
      type: 'action';
      key: WhatsappStandardFlowActionKey;
    }
  | {
      type: 'restaurant_select';
      restaurantId: string;
    }
  | {
      type: 'branch_select';
      branchId: string;
    }
  | {
      type: 'order_select';
      orderId: string;
    };

export const WHATSAPP_STANDARD_FLOW_HOME_ACTIONS = [
  WhatsappStandardFlowActionKey.HomePlaceOrder,
  WhatsappStandardFlowActionKey.HomeMyOrders,
  WhatsappStandardFlowActionKey.HomeAccountHelp,
] as const;

const APPROVED_ACTION_KEYS = new Set<string>(
  Object.values(WhatsappStandardFlowActionKey),
);

export function parseWhatsappStandardFlowActionId(
  actionId: string | null | undefined,
): WhatsappStandardFlowParsedAction | null {
  const normalizedActionId = actionId?.trim();
  if (!normalizedActionId) {
    return null;
  }
  if (APPROVED_ACTION_KEYS.has(normalizedActionId)) {
    return {
      type: 'action',
      key: normalizedActionId as WhatsappStandardFlowActionKey,
    };
  }

  // A selection belongs to one generated question, not merely to "option 2".
  // The handler still verifies that question against this conversation's context.
  const meal = /^meal\.select:([a-f0-9-]{36}):([0-9])$/.exec(
    normalizedActionId,
  );
  if (meal)
    return { type: 'meal_select', questionId: meal[1], index: Number(meal[2]) };
  return parseEntitySelectionAction(normalizedActionId);
}

export function createMealSelectActionId(
  questionId: string,
  index: number,
): string {
  return `meal.select:${questionId}:${index}`;
}

export function createRestaurantSelectActionId(restaurantId: string): string {
  return `restaurant.select:${restaurantId}`;
}

export function createBranchSelectActionId(branchId: string): string {
  return `branch.select:${branchId}`;
}

export function createOrderSelectActionId(orderId: string): string {
  return `order.select:${orderId}`;
}

function parseEntitySelectionAction(
  actionId: string,
): WhatsappStandardFlowParsedAction | null {
  const [prefix, id, extra] = actionId.split(':');
  if (extra !== undefined) return null;
  if (!id || !isSafeEntityId(id)) {
    return null;
  }
  if (prefix === 'restaurant.select') {
    return {
      type: 'restaurant_select',
      restaurantId: id,
    };
  }
  if (prefix === 'branch.select') {
    return {
      type: 'branch_select',
      branchId: id,
    };
  }
  if (prefix === 'order.select') {
    return {
      type: 'order_select',
      orderId: id,
    };
  }

  return null;
}

function isSafeEntityId(value: string): boolean {
  return /^[A-Za-z0-9_-]{3,80}$/.test(value);
}
