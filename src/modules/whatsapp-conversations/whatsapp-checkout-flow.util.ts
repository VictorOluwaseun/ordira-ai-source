import { WhatsappConversationState as State } from './schemas/whatsapp-conversation.schema';
import { normalizeWhatsappActionText } from './whatsapp-text-action.util';
import { normalizeWhatsappCommandWording } from './whatsapp-language.util';
const CHECKOUT_SESSION_CODE_PATTERN = /\bCHK-\d{6}-[A-Z0-9]{10}\b/i;

export function extractCheckoutSessionCode(
  text: string | null | undefined,
): string | undefined {
  const match = text?.match(CHECKOUT_SESSION_CODE_PATTERN);

  return match?.[0]?.toUpperCase();
}

export function normalizeWhatsappCheckoutText(
  text: string | null | undefined,
): string {
  return normalizeWhatsappCommandWording(normalizeWhatsappActionText(text));
}

/**
 * Recognize an explicit pickup/delivery choice at the checkout steps that allow
 * it, including corrections such as "actually delivery instead" or "I go collect
 * am". Both the inbound AI-bypass guard and checkout command parser use this
 * helper so known wording is handled consistently without inference.
 *
 * In these states, a leading "no" is treated as a correction prefix before an
 * otherwise exact choice. This is a narrow conversational convention, not a
 * general negation parser. This helper returns intent only; the checkout handler
 * still checks available services, requests the address and requires confirmation.
 * Never extend this to fuzzy matching of confirm/cancel or customer addresses.
 */
export function readWhatsappFulfillmentChoice(
  text: string | null | undefined,
  state: string,
): 'pickup' | 'delivery' | null {
  if (
    ![
      State.AwaitingFulfillment,
      State.AwaitingConfirmation,
      State.AwaitingDeliveryAddress,
    ].some((allowed) => allowed === state)
  )
    return null;
  const normalized = normalizeWhatsappCheckoutText(text)
    .replace(/^(?:actually|no)[, ]+/, '')
    .replace(/ instead$/, '');
  if (
    [
      'pickup',
      'pick up',
      'i will collect it',
      'i go collect am',
      'make i collect am',
    ].includes(normalized)
  )
    return 'pickup';
  if (
    [
      'delivery',
      'deliver it',
      'deliver am',
      'make una deliver am',
      'bring am',
    ].includes(normalized)
  )
    return 'delivery';
  return null;
}
