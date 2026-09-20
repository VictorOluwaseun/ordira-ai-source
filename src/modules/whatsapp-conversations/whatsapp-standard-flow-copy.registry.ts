import { WhatsappConversationState } from './schemas/whatsapp-conversation.schema';
import { WhatsappStandardFlowActionKey } from './whatsapp-standard-flow-action-registry';

export type WhatsappStandardFlowCopyOverrides = {
  brandName?: string | null;
  actionLabels?: Partial<Record<WhatsappStandardFlowActionKey, string>>;
  text?: Partial<Record<WhatsappStandardFlowTextKey, string>>;
};

export const WhatsappStandardFlowTextKey = {
  HomePrompt: 'home_prompt',
  OrderEntryPrompt: 'order_entry_prompt',
  LocationRequest: 'location_request',
  RestaurantSearchPrompt: 'restaurant_search_prompt',
  AccountHelpPrompt: 'account_help_prompt',
  AccountHelpButton: 'account_help_button',
  OrdersPlaceholder: 'orders_placeholder',
  GuidanceLocation: 'guidance_location',
  GuidanceRestaurantSearch: 'guidance_restaurant_search',
  GuidanceStorefrontHandoff: 'guidance_storefront_handoff',
  GuidanceDefault: 'guidance_default',
} as const;

export type WhatsappStandardFlowTextKey =
  (typeof WhatsappStandardFlowTextKey)[keyof typeof WhatsappStandardFlowTextKey];

export const WhatsappOrderStatusCopyKey = {
  OrderSubmitted: 'order_submitted',
  Preparing: 'preparing',
  ReadyForPickup: 'ready_for_pickup',
  OutForDelivery: 'out_for_delivery',
  PaymentConfirmed: 'payment_confirmed',
  ReceiptAvailable: 'receipt_available',
} as const;

export type WhatsappOrderStatusCopyKey =
  (typeof WhatsappOrderStatusCopyKey)[keyof typeof WhatsappOrderStatusCopyKey];

const DEFAULT_BRAND_NAME = 'Ordira';

const DEFAULT_ACTION_LABELS: Record<WhatsappStandardFlowActionKey, string> = {
  [WhatsappStandardFlowActionKey.ConversationAssist]: 'Help with this',
  [WhatsappStandardFlowActionKey.TellFood]: 'I know what I want',
  [WhatsappStandardFlowActionKey.BudgetTotal]: 'Total budget',
  [WhatsappStandardFlowActionKey.BudgetPerPerson]: 'Per person',
  [WhatsappStandardFlowActionKey.RepeatDraft]: 'Review new order',
  [WhatsappStandardFlowActionKey.HomePlaceOrder]: '🍽️ Place an order',
  [WhatsappStandardFlowActionKey.HomeMyOrders]: '🧾 My orders',
  [WhatsappStandardFlowActionKey.HomeAccountHelp]: '⚙️ Account & help',
  [WhatsappStandardFlowActionKey.OrderEntryNearby]: '📍 Near me',
  [WhatsappStandardFlowActionKey.OrderEntrySearch]: '🔎 Search',
  [WhatsappStandardFlowActionKey.OrderEntryRecent]: '🕘 Recent',
  [WhatsappStandardFlowActionKey.NavigationHome]: '🏠 Home',
  [WhatsappStandardFlowActionKey.NavigationDiscover]: '🔎 Find or show',
  [WhatsappStandardFlowActionKey.NavigationClarify]: 'Choose an option',
  [WhatsappStandardFlowActionKey.NavigationChangeRestaurant]:
    '🔁 Change restaurant',
  [WhatsappStandardFlowActionKey.NavigationChangeBranch]: '🏬 Change branch',
  [WhatsappStandardFlowActionKey.NavigationCancelCheckout]: '❌ Cancel order',
  [WhatsappStandardFlowActionKey.OrdersMore]: '🧾 More orders',
  [WhatsappStandardFlowActionKey.OrdersCurrent]: '📋 Current order',
  [WhatsappStandardFlowActionKey.OrdersSelect]: '🧾 View order',
  [WhatsappStandardFlowActionKey.OrdersTrack]: '📋 Order status',
  [WhatsappStandardFlowActionKey.OrdersReceipt]: '🧾 Receipt',
  [WhatsappStandardFlowActionKey.OrdersPaymentReceipt]: '🧾 Payment receipt',
  [WhatsappStandardFlowActionKey.OrdersCancelHelp]: 'Cancel order',
  [WhatsappStandardFlowActionKey.OrdersPay]: '💳 Pay',
  [WhatsappStandardFlowActionKey.AccountEmail]: '✉️ Update email',
  [WhatsappStandardFlowActionKey.AccountNotifications]: '🔔 Preferences',
  [WhatsappStandardFlowActionKey.AccountHelp]: '🛟 Help',
  [WhatsappStandardFlowActionKey.NotificationsWhatsappMarketingOn]:
    '🔔 WhatsApp promos on',
  [WhatsappStandardFlowActionKey.NotificationsWhatsappMarketingOff]:
    '🔕 WhatsApp promos off',
  [WhatsappStandardFlowActionKey.NotificationsEmailMarketingOn]:
    '✉️ Email promos on',
  [WhatsappStandardFlowActionKey.NotificationsEmailMarketingOff]:
    '📪 Email promos off',
  [WhatsappStandardFlowActionKey.NotificationsWhatsappTransactionalOn]:
    '✅ WhatsApp alerts on',
  [WhatsappStandardFlowActionKey.NotificationsWhatsappTransactionalOff]:
    '🔕 WhatsApp alerts off',
  [WhatsappStandardFlowActionKey.NotificationsEmailTransactionalOn]:
    '✅ Email alerts on',
  [WhatsappStandardFlowActionKey.NotificationsEmailTransactionalOff]:
    '📪 Email alerts off',
};

const DEFAULT_TEXT: Record<WhatsappStandardFlowTextKey, string> = {
  [WhatsappStandardFlowTextKey.HomePrompt]:
    '👋 Hi {customerName}, welcome to {brandName}.\nWhat would you like to do?',
  [WhatsappStandardFlowTextKey.OrderEntryPrompt]:
    '🍽️ How would you like to find a restaurant?',
  [WhatsappStandardFlowTextKey.LocationRequest]:
    '📍 Share your location so {brandName} can show restaurants near you.',
  [WhatsappStandardFlowTextKey.RestaurantSearchPrompt]:
    '🔎 Send the restaurant name, food, or area you are looking for.',
  [WhatsappStandardFlowTextKey.AccountHelpPrompt]: '⚙️ Account & help',
  [WhatsappStandardFlowTextKey.AccountHelpButton]: 'Choose',
  [WhatsappStandardFlowTextKey.OrdersPlaceholder]:
    '🧾 Your {brandName} order history will appear here. Reply HOME to return to the main menu.',
  [WhatsappStandardFlowTextKey.GuidanceLocation]:
    '📍 Please share your location using the button above.',
  [WhatsappStandardFlowTextKey.GuidanceRestaurantSearch]:
    '🔎 Send a restaurant, meal, or area to search.',
  [WhatsappStandardFlowTextKey.GuidanceStorefrontHandoff]:
    '🍽️ Use the menu link above, or reply HOME to start again.',
  [WhatsappStandardFlowTextKey.GuidanceDefault]:
    '🏠 Reply HOME to return to the {brandName} menu.',
};

const DEFAULT_ORDER_STATUS_LABELS: Record<WhatsappOrderStatusCopyKey, string> =
  {
    [WhatsappOrderStatusCopyKey.OrderSubmitted]: '✅ Order submitted',
    [WhatsappOrderStatusCopyKey.Preparing]: '👨‍🍳 Preparing',
    [WhatsappOrderStatusCopyKey.ReadyForPickup]: '🛍️ Ready for pickup',
    [WhatsappOrderStatusCopyKey.OutForDelivery]: '🛵 Out for delivery',
    [WhatsappOrderStatusCopyKey.PaymentConfirmed]: '💳 Payment confirmed',
    [WhatsappOrderStatusCopyKey.ReceiptAvailable]: '🧾 Receipt available',
  };

export function getWhatsappStandardFlowActionLabel(
  key: WhatsappStandardFlowActionKey,
  overrides?: WhatsappStandardFlowCopyOverrides | null,
): string {
  return overrides?.actionLabels?.[key] ?? DEFAULT_ACTION_LABELS[key];
}

export function getWhatsappStandardFlowText(
  key: WhatsappStandardFlowTextKey,
  values: Record<string, string> = {},
  overrides?: WhatsappStandardFlowCopyOverrides | null,
): string {
  const template = overrides?.text?.[key] ?? DEFAULT_TEXT[key];
  const brandName = overrides?.brandName?.trim() || DEFAULT_BRAND_NAME;
  const replacements = {
    brandName,
    ...values,
  };

  return Object.entries(replacements).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    template,
  );
}

export function getWhatsappOrderStatusLabel(
  key: WhatsappOrderStatusCopyKey,
): string {
  return DEFAULT_ORDER_STATUS_LABELS[key];
}

export function getWhatsappStateGuidanceText(
  state: WhatsappConversationState,
  overrides?: WhatsappStandardFlowCopyOverrides | null,
): string {
  if (state === WhatsappConversationState.AwaitingLocation) {
    return getWhatsappStandardFlowText(
      WhatsappStandardFlowTextKey.GuidanceLocation,
      {},
      overrides,
    );
  }
  if (state === WhatsappConversationState.AwaitingRestaurantSearch) {
    return getWhatsappStandardFlowText(
      WhatsappStandardFlowTextKey.GuidanceRestaurantSearch,
      {},
      overrides,
    );
  }
  if (state === WhatsappConversationState.StorefrontHandoff) {
    return getWhatsappStandardFlowText(
      WhatsappStandardFlowTextKey.GuidanceStorefrontHandoff,
      {},
      overrides,
    );
  }

  return getWhatsappStandardFlowText(
    WhatsappStandardFlowTextKey.GuidanceDefault,
    {},
    overrides,
  );
}

export function toWhatsappTextOnlyFallback(label: string): string {
  return label
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
