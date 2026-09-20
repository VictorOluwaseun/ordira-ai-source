import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { customerAiConfig } from '@config/customer-ai.config';
import { WhatsappChannelMode } from '@modules/whatsapp-connections/schemas/whatsapp-channel.schema';
import {
  WhatsappConversationState,
  type WhatsappConversationRecord,
} from '@modules/whatsapp-conversations/schemas/whatsapp-conversation.schema';

const ELIGIBLE_STATES = new Set<WhatsappConversationRecord['state']>([
  WhatsappConversationState.New,
  WhatsappConversationState.PlatformHome,
  WhatsappConversationState.AwaitingHomeAction,
  WhatsappConversationState.AwaitingRestaurantSearch,
  WhatsappConversationState.AwaitingRestaurantSelection,
  WhatsappConversationState.AwaitingBranchSelection,
]);

export type CustomerAiRoutingInput = {
  conversation: WhatsappConversationRecord;
  customerMessage?: string | null;
  deterministicInput: boolean;
};

@Injectable()
export class CustomerAiRoutingService {
  constructor(
    @Inject(customerAiConfig.KEY)
    private readonly config: ConfigType<typeof customerAiConfig>,
  ) {}

  /**
   * Returns true only when a message may be copied into the shadow pipeline.
   * This does not transfer control of the live WhatsApp conversation to AI.
   */
  isShadowEligible(input: CustomerAiRoutingInput): boolean {
    const message = input.customerMessage?.trim() ?? '';
    // Operational gates: shadow must be deliberately enabled, asynchronous,
    // non-deterministic input only, and bounded before it reaches a provider.
    if (
      this.config.mode !== 'shadow' ||
      !this.config.queueEnabled ||
      input.deterministicInput ||
      message.length === 0 ||
      message.length > 1000
    ) {
      return false;
    }
    // Domain gates: the first rollout excludes tenant-owned channels and any
    // conversation that has crossed into checkout or order state.
    if (
      input.conversation.channelMode !== WhatsappChannelMode.SharedPlatform ||
      input.conversation.checkoutSessionId ||
      input.conversation.orderId ||
      !ELIGIBLE_STATES.has(input.conversation.state)
    ) {
      return false;
    }

    return (
      stableRolloutBucket(input.conversation.id) < this.config.rolloutPercent
    );
  }
}

/**
 * Assigns a conversation to a stable 0-99 bucket. A stable hash prevents the
 * same customer from moving in and out of an experiment on every message.
 */
export function stableRolloutBucket(key: string): number {
  const prefix = createHash('sha256').update(key).digest('hex').slice(0, 8);

  return Number.parseInt(prefix, 16) % 100;
}
