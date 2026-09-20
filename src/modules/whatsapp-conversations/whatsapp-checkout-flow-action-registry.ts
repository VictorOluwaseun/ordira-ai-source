export const WhatsappCheckoutFlowActionKey = {
  Pickup: 'checkout.pickup',
  Delivery: 'checkout.delivery',
  Confirm: 'checkout.confirm',
  Edit: 'checkout.edit',
  Cancel: 'checkout.cancel',
} as const;

export type WhatsappCheckoutFlowActionKey =
  (typeof WhatsappCheckoutFlowActionKey)[keyof typeof WhatsappCheckoutFlowActionKey];

const APPROVED_ACTION_KEYS = new Set<string>(
  Object.values(WhatsappCheckoutFlowActionKey),
);

export function parseWhatsappCheckoutFlowActionId(
  actionId: string | null | undefined,
): WhatsappCheckoutFlowActionKey | null {
  const normalizedActionId = actionId?.trim();
  if (!normalizedActionId || !APPROVED_ACTION_KEYS.has(normalizedActionId)) {
    return null;
  }

  return normalizedActionId as WhatsappCheckoutFlowActionKey;
}
