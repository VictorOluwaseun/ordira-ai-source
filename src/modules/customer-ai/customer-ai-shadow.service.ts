import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { customerAiConfig } from '@config/customer-ai.config';
import type { WhatsappConversationRecord } from '@modules/whatsapp-conversations/schemas/whatsapp-conversation.schema';
import { CustomerAiQueueService } from './customer-ai-queue.service';
import { CustomerAiMetricsService } from './customer-ai-metrics.service';
import { CustomerAiRepository } from './customer-ai.repository';
import { CustomerAiRoutingService } from './customer-ai-routing.service';

export type CustomerAiShadowObservation = {
  inboundEventId: string;
  customerMessage?: string | null;
  deterministicInput: boolean;
  conversation: WhatsappConversationRecord;
};

/**
 * Non-blocking entry point from the live inbound-message flow.
 *
 * This service only records and queues an observation. It never waits for a
 * model response, sends WhatsApp output, or mutates checkout/order state.
 * Failures are deliberately swallowed after structured logging so experimental
 * AI cannot interrupt the deterministic customer experience.
 */
@Injectable()
export class CustomerAiShadowService {
  private readonly logger = new Logger(CustomerAiShadowService.name);

  constructor(
    private readonly routingService: CustomerAiRoutingService,
    private readonly repository: CustomerAiRepository,
    private readonly queueService: CustomerAiQueueService,
    private readonly metrics: CustomerAiMetricsService,
    @Inject(customerAiConfig.KEY)
    private readonly config: ConfigType<typeof customerAiConfig>,
  ) {}

  async observeInbound(input: CustomerAiShadowObservation): Promise<boolean> {
    if (!this.routingService.isShadowEligible(input)) {
      return false;
    }

    try {
      const postDeterministic = await this.repository.findConversationVersions(
        input.conversation.id,
      );
      const causalInputVersion = input.conversation.inputVersion ?? 0;
      // A newer customer message won the race before this observation could be
      // captured. Do not attach its state to the older inbound event.
      if (
        !postDeterministic ||
        postDeterministic.inputVersion !== causalInputVersion
      ) {
        return false;
      }
      const observedConversationVersion = input.conversation.stateVersion ?? 0;
      // inboundEventId is unique, making webhook redelivery idempotent.
      const run = await this.repository.createRunIfAbsent({
        conversationId: input.conversation.id,
        inboundEventId: input.inboundEventId,
        workspaceId: input.conversation.workspaceId ?? null,
        restaurantId: input.conversation.restaurantId ?? null,
        branchId: input.conversation.branchId ?? null,
        mode: this.config.mode,
        provider: this.config.provider,
        model: this.config.model,
        reasoningEffort: this.config.reasoningEffort,
        promptVersion: this.config.promptVersion,
        policyVersion: this.config.policyVersion,
        toolContractVersion: this.config.toolContractVersion,
        responseContractVersion: this.config.responseContractVersion,
        causalInputVersion,
        observedConversationVersion,
        deterministicPostConversationVersion: postDeterministic.stateVersion,
        expectedConversationVersion: postDeterministic.stateVersion,
        maxProviderCalls: this.config.maxProviderCalls,
        maxToolCalls: this.config.maxToolCalls,
        maxOutputTokens: this.config.maxOutputTokens,
        maxContextMessages: this.config.maxContextMessages,
        turnDeadlineMs: this.config.turnDeadlineMs,
      });

      const enqueued = await this.queueService.enqueueProcessJob(
        run._id.toHexString(),
      );
      if (enqueued) {
        this.metrics.increment('shadow_runs_queued');
      }

      return enqueued;
    } catch (error) {
      // Shadow observation is best-effort; the primary flow must keep running.
      this.logger.warn({
        event: 'customer_ai_shadow_observation_failed',
        inboundEventId: input.inboundEventId,
        error: error instanceof Error ? error.message : 'unknown_error',
      });

      return false;
    }
  }
}
