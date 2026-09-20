import type { ConfigType } from '@nestjs/config';
import { customerAiConfig } from '@config/customer-ai.config';
import { WhatsappChannelMode } from '@modules/whatsapp-connections/schemas/whatsapp-channel.schema';
import {
  WhatsappConversationState,
  type WhatsappConversationRecord,
} from '@modules/whatsapp-conversations/schemas/whatsapp-conversation.schema';
import {
  CustomerAiRoutingService,
  stableRolloutBucket,
} from './customer-ai-routing.service';

describe('CustomerAiRoutingService', () => {
  const conversation = {
    id: 'conversation-1',
    channelMode: WhatsappChannelMode.SharedPlatform,
    state: WhatsappConversationState.New,
    checkoutSessionId: null,
    orderId: null,
  } as WhatsappConversationRecord;

  function createService(rolloutPercent = 100): CustomerAiRoutingService {
    return new CustomerAiRoutingService({
      mode: 'shadow',
      queueEnabled: true,
      rolloutPercent,
    } as ConfigType<typeof customerAiConfig>);
  }

  it('admits natural shared-channel discovery in a selected bucket', () => {
    expect(
      createService().isShadowEligible({
        conversation,
        customerMessage: 'I want spicy chicken near Lekki',
        deterministicInput: false,
      }),
    ).toBe(true);
  });

  it('always leaves deterministic actions and checkout state to existing flows', () => {
    expect(
      createService().isShadowEligible({
        conversation,
        customerMessage: 'CONFIRM',
        deterministicInput: true,
      }),
    ).toBe(false);
    expect(
      createService().isShadowEligible({
        conversation: { ...conversation, checkoutSessionId: 'checkout-1' },
        customerMessage: 'make it two',
        deterministicInput: false,
      }),
    ).toBe(false);
  });

  it('uses a stable rollout bucket', () => {
    expect(stableRolloutBucket('conversation-1')).toBe(
      stableRolloutBucket('conversation-1'),
    );
    expect(stableRolloutBucket('conversation-1')).toBeGreaterThanOrEqual(0);
    expect(stableRolloutBucket('conversation-1')).toBeLessThan(100);
  });
});
