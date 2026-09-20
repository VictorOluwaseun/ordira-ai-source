import {
  WhatsappOrderStatusCopyKey,
  WhatsappStandardFlowTextKey,
  getWhatsappOrderStatusLabel,
  getWhatsappStandardFlowActionLabel,
  getWhatsappStandardFlowText,
  toWhatsappTextOnlyFallback,
} from './whatsapp-standard-flow-copy.registry';
import { WhatsappStandardFlowActionKey } from './whatsapp-standard-flow-action-registry';

describe('whatsapp standard flow copy registry', () => {
  it('keeps emojis in display labels while action IDs remain stable', () => {
    expect(
      getWhatsappStandardFlowActionLabel(
        WhatsappStandardFlowActionKey.HomePlaceOrder,
      ),
    ).toBe('🍽️ Place an order');
    expect(WhatsappStandardFlowActionKey.HomePlaceOrder).toBe(
      'home.place_order',
    );
    expect(WhatsappStandardFlowActionKey.HomePlaceOrder).not.toContain('🍽️');
  });

  it('supports platform copy overrides without changing routing IDs', () => {
    expect(
      getWhatsappStandardFlowActionLabel(
        WhatsappStandardFlowActionKey.HomePlaceOrder,
        {
          brandName: 'Ordira NG',
          actionLabels: {
            [WhatsappStandardFlowActionKey.HomePlaceOrder]: '🍲 Order food',
          },
        },
      ),
    ).toBe('🍲 Order food');
    expect(
      getWhatsappStandardFlowText(
        WhatsappStandardFlowTextKey.HomePrompt,
        { customerName: 'Ada' },
        { brandName: 'Ordira NG' },
      ),
    ).toBe('👋 Hi Ada, welcome to Ordira NG.\nWhat would you like to do?');
  });

  it('provides order-state labels and provider-safe text-only fallbacks', () => {
    expect(
      getWhatsappOrderStatusLabel(WhatsappOrderStatusCopyKey.Preparing),
    ).toBe('👨‍🍳 Preparing');
    expect(toWhatsappTextOnlyFallback('🍽️ Place an order')).toBe(
      'Place an order',
    );
  });
});
