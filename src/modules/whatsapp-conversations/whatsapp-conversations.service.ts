import {
  isWhatsappHomeCommand,
  isWhatsappStandardFlowState,
  resolveWhatsappStandardTextAction,
} from './whatsapp-text-action.util';
import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { AppResponseCode } from '@common/constants/response-codes.constants';
import { AppError } from '@common/errors/app.error';
import { sha256 } from '@common/utils/crypto.util';
import { createStableStringifier } from '@common/utils/json.util';
import { elapsedMilliseconds as elapsedMs } from '@common/utils/date.util';
import {
  getErrorMessage,
  isMongoDuplicateKeyError as isDuplicateKeyError,
} from '@common/utils/error.util';
import {
  isObjectRecord as isRecord,
  toNullableObjectRecord as readRecord,
} from '@common/utils/object.util';
import { normalizePhoneNumberDigits as normalizePhoneNumber } from '@common/utils/phone-number.util';
import {
  toNullableTrimmedTextFromUnknown as toNullableText,
  truncateText,
} from '@common/utils/string.util';
import { AuditAction } from '@modules/audit/audit.types';
import { AuditService } from '@modules/audit/audit.service';
import { CampaignsService } from '@modules/campaigns/campaigns.service';
import { CustomerAiShadowService } from '@modules/customer-ai/customer-ai-shadow.service';
import { CustomerAiIntentService } from '@modules/customer-ai/customer-ai-intent.service';
import type { AuthenticatedUserContext } from '@modules/auth/types/auth.types';
import { getAuthenticatedUserAuditContext as getAuditContext } from '@modules/audit/audit-context.util';
import { toWhatsappOutboundMessageResponse as toOutboundMessageResponse } from './whatsapp-format.util';
import { type CheckoutSessionRecord } from '@modules/checkout-sessions/schemas/checkout-session.schema';
import { isCheckoutSessionExpired } from '@modules/checkout-sessions/checkout-session.util';
import { type PlatformCustomerIdentityRecord } from '@modules/customers/schemas/platform-customer-identity.schema';
import {
  WhatsappChannelMode,
  type WhatsappChannelRecord,
} from '@modules/whatsapp-connections/schemas/whatsapp-channel.schema';
import { type WhatsappChannelBindingRecord } from '@modules/whatsapp-connections/schemas/whatsapp-channel-binding.schema';
import { WhatsappConnectionProvider } from '@modules/whatsapp-connections/types/whatsapp-connection.type';
import { WhatsappChannelsService } from '@modules/whatsapp-connections/whatsapp-channels.service';
import { WorkspaceEventsService } from '@modules/workspace-events/workspace-events.service';
import type { LinkCheckoutSessionDto } from './dto/link-checkout-session.dto';
import type { ListWhatsappConversationsDto } from './dto/list-whatsapp-conversations.dto';
import type { SendWhatsappMessageDto } from './dto/send-whatsapp-message.dto';
import type { WhatsappWebhookDto } from './dto/whatsapp-webhook.dto';
import {
  WhatsappConversationSource,
  WhatsappConversationState,
  WhatsappConversationStatus,
  type WhatsappConversationRecord,
} from './schemas/whatsapp-conversation.schema';
import {
  WhatsappInboundEventStatus,
  type WhatsappInboundEventRecord,
} from './schemas/whatsapp-inbound-event.schema';
import {
  WhatsappOutboundMessageStatus,
  WhatsappOutboundMessageType,
  type WhatsappOutboundMessageRecord,
} from './schemas/whatsapp-outbound-message.schema';
import type {
  WhatsappConversationResponse,
  WhatsappConversationsListResponse,
  WhatsappOutboundMessageResponse,
} from './types/whatsapp-conversation-response.type';
import type { WhatsappWebhookResponse } from './types/whatsapp-webhook-response.type';
import {
  WhatsappConversationsRepository,
  type WhatsappConversationUpdateSet,
} from './whatsapp-conversations.repository';
import {
  extractCheckoutSessionCode,
  normalizeWhatsappCheckoutText,
  readWhatsappFulfillmentChoice,
} from './whatsapp-checkout-flow.util';
import { WhatsappCheckoutFlowService } from './whatsapp-checkout-flow.service';
import { WhatsappInboundQueueService } from './whatsapp-inbound-queue.service';
import { WhatsappOutboundDispatcherService } from './whatsapp-outbound-dispatcher.service';
import { parseWhatsappCheckoutFlowActionId } from './whatsapp-checkout-flow-action-registry';
import { parseWhatsappStandardFlowActionId } from './whatsapp-standard-flow-action-registry';
import { WhatsappStandardFlowService } from './whatsapp-standard-flow.service';

const stableStringify = createStableStringifier({ undefinedValue: 'null' });

type NormalizedWebhookPayload = {
  provider: WhatsappConnectionProvider;
  providerEventId: string;
  providerMessageId?: string | null;
  fromPhoneNumber?: string | null;
  toPhoneNumber?: string | null;
  fromPhoneNumberNormalized?: string | null;
  toPhoneNumberNormalized?: string | null;
  providerPhoneNumberId?: string | null;
  messageType?: string | null;
  text?: string | null;
  interactionId?: string | null;
  interactionTitle?: string | null;
  location?: NormalizedInboundLocation | null;
  customerName?: string | null;
  providerTimestamp?: Date | null;
  rawPayload: Record<string, unknown>;
};

type NormalizedInboundLocation = {
  latitude: number;
  longitude: number;
  name?: string | null;
  address?: string | null;
};

type MetaCloudStatusUpdate = {
  providerMessageId: string;
  status: string;
  timestamp?: Date | null;
  failureReason?: string | null;
};

type InboundChannelTenantContext = {
  workspaceId: string | null;
  restaurantId: string | null;
  branchId: string | null;
  bindingId: string | null;
};

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

@Injectable()
export class WhatsappConversationsService {
  private readonly logger = new Logger(WhatsappConversationsService.name);

  constructor(
    private readonly whatsappConversationsRepository: WhatsappConversationsRepository,
    private readonly auditService: AuditService,
    private readonly checkoutFlowService: WhatsappCheckoutFlowService,
    private readonly whatsappChannelsService: WhatsappChannelsService,
    @Optional()
    private readonly inboundQueueService?: WhatsappInboundQueueService,
    @Optional()
    private readonly outboundDispatcherService?: WhatsappOutboundDispatcherService,
    @Optional()
    private readonly standardFlowService?: WhatsappStandardFlowService,
    @Optional()
    private readonly workspaceEventsService?: WorkspaceEventsService,
    @Optional()
    private readonly campaignsService?: CampaignsService,
    @Optional()
    private readonly customerAiShadowService?: CustomerAiShadowService,
    @Optional()
    private readonly customerAiIntentService?: CustomerAiIntentService,
  ) {}

  async receiveWebhook(
    providerParam: string,
    dto: WhatsappWebhookDto,
  ): Promise<WhatsappWebhookResponse> {
    const webhook = normalizeWebhookPayload(
      this.parseProvider(providerParam),
      dto,
    );
    try {
      const event =
        await this.whatsappConversationsRepository.createInboundEvent({
          provider: webhook.provider,
          providerEventId: webhook.providerEventId,
          providerMessageId: webhook.providerMessageId ?? null,
          fromPhoneNumber: webhook.fromPhoneNumber ?? null,
          toPhoneNumber: webhook.toPhoneNumber ?? null,
          providerPhoneNumberId: webhook.providerPhoneNumberId ?? null,
          messageType: webhook.messageType ?? null,
          text: webhook.text ?? null,
          interactionId: webhook.interactionId ?? null,
          interactionTitle: webhook.interactionTitle ?? null,
          location: webhook.location ?? null,
          customerName: webhook.customerName ?? null,
          providerTimestamp: webhook.providerTimestamp ?? null,
          rawPayload: webhook.rawPayload,
          status: WhatsappInboundEventStatus.Received,
          receivedAt: new Date(),
        });
      this.logger.log({
        event: 'whatsapp_latency_webhook_received',
        inboundEventId: event.id,
        provider: webhook.provider,
        providerMessageId: webhook.providerMessageId ?? null,
        webhookKind: isMetaCloudStatusWebhook(webhook) ? 'status' : 'message',
        messageType: webhook.messageType ?? null,
        receivedAt: event.receivedAt.toISOString(),
      });
      await this.enqueueInboundEvent(event.id);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return {
          received: true,
          duplicate: true,
          processed: false,
        };
      }

      throw error;
    }

    return {
      received: true,
      duplicate: false,
      processed: false,
    };
  }

  async listConversations(
    auth: AuthenticatedUserContext,
    query: ListWhatsappConversationsDto = {},
  ): Promise<WhatsappConversationsListResponse> {
    const page = Math.max(query.page ?? DEFAULT_PAGE, 1);
    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const { total, conversations } =
      await this.whatsappConversationsRepository.listConversations({
        workspaceId: auth.workspaceId,
        restaurantId: query.restaurantId,
        branchId: query.branchId,
        status: query.status,
        checkoutSessionId: query.checkoutSessionId,
        customerPhoneNumberNormalized: query.customerPhoneNumber
          ? normalizePhoneNumber(query.customerPhoneNumber)
          : null,
        page,
        limit,
      });

    return {
      conversations: conversations.map(toConversationResponse),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getConversation(
    auth: AuthenticatedUserContext,
    conversationId: string,
  ): Promise<WhatsappConversationResponse> {
    return toConversationResponse(
      await this.findConversationForWorkspace(auth.workspaceId, conversationId),
    );
  }

  async linkCheckoutSession(
    auth: AuthenticatedUserContext,
    conversationId: string,
    dto: LinkCheckoutSessionDto,
  ): Promise<WhatsappConversationResponse> {
    const conversation = await this.findConversationForWorkspace(
      auth.workspaceId,
      conversationId,
    );
    const checkoutSession = await this.findCheckoutSessionForManualLink(dto);
    this.assertCheckoutSessionBelongsToConversation(
      conversation,
      checkoutSession,
    );

    const updatedConversation = await this.applyCheckoutSessionLink(
      conversation,
      checkoutSession,
    );
    await this.auditService.record({
      ...getAuditContext(auth),
      action: AuditAction.WhatsappConversationCheckoutLinked,
      resource: 'whatsapp_conversation',
      resourceId: updatedConversation.id,
      metadata: {
        checkoutSessionId: checkoutSession.id,
        checkoutSessionCode: checkoutSession.sessionCode,
        restaurantId: updatedConversation.restaurantId ?? null,
        branchId: updatedConversation.branchId ?? null,
      },
    });
    await this.publishConversationUpdated(updatedConversation);

    return toConversationResponse(updatedConversation);
  }

  async queueOutboundMessage(
    auth: AuthenticatedUserContext,
    conversationId: string,
    dto: SendWhatsappMessageDto,
  ): Promise<WhatsappOutboundMessageResponse> {
    const text = toNullableText(dto.text);
    if (!text) {
      throw AppError.badRequest({
        code: AppResponseCode.ValidationError,
        message: 'text is required',
      });
    }

    const conversation = await this.findConversationForWorkspace(
      auth.workspaceId,
      conversationId,
    );
    const idempotencyKeyHash = dto.idempotencyKey
      ? hashConversationIdempotencyKey(
          auth.workspaceId,
          conversation.id,
          dto.idempotencyKey,
        )
      : null;
    const existingMessage = idempotencyKeyHash
      ? await this.findOutboundMessageByIdempotencyKey(
          auth.workspaceId,
          conversation.id,
          idempotencyKeyHash,
        )
      : null;
    if (existingMessage) {
      await this.enqueueOutboundMessage(existingMessage.id);

      return toOutboundMessageResponse(existingMessage);
    }

    const now = new Date();
    let record: WhatsappOutboundMessageRecord;
    try {
      record = await this.whatsappConversationsRepository.createOutboundMessage(
        {
          workspaceId: conversation.workspaceId,
          restaurantId: conversation.restaurantId ?? null,
          branchId: conversation.branchId ?? null,
          channelId: conversation.channelId ?? null,
          conversationId: conversation.id,
          checkoutSessionId: conversation.checkoutSessionId ?? null,
          orderId: conversation.orderId ?? null,
          toPhoneNumber: conversation.customerPhoneNumber,
          toPhoneNumberNormalized: conversation.customerPhoneNumberNormalized,
          messageType: WhatsappOutboundMessageType.Text,
          text,
          payload: {},
          status: WhatsappOutboundMessageStatus.Queued,
          attemptCount: 0,
          maxAttempts: 3,
          nextAttemptAt: now,
          idempotencyKeyHash,
          createdByUserId: auth.userId,
        },
      );
    } catch (error) {
      if (!isDuplicateKeyError(error) || !idempotencyKeyHash) {
        throw error;
      }

      const duplicateMessage = await this.findOutboundMessageByIdempotencyKey(
        auth.workspaceId,
        conversation.id,
        idempotencyKeyHash,
      );
      if (!duplicateMessage) {
        throw error;
      }
      record = duplicateMessage;
    }
    this.logger.log({
      event: 'whatsapp_latency_outbound_message_created',
      source: 'dashboard',
      outboundMessageId: record.id,
      conversationId: conversation.id,
      channelId: conversation.channelId ?? null,
      checkoutSessionId: conversation.checkoutSessionId ?? null,
      orderId: conversation.orderId ?? null,
      hasTenantScope: Boolean(conversation.workspaceId),
    });
    await this.enqueueOutboundMessage(record.id);

    const updatedConversation = await this.updateConversation(conversation.id, {
      status: WhatsappConversationStatus.WaitingForCustomer,
      lastMessageText: text,
      lastMessageAt: now,
      lastOutboundAt: now,
    });
    await this.auditService.record({
      ...getAuditContext(auth),
      action: AuditAction.WhatsappMessageQueued,
      resource: 'whatsapp_outbound_message',
      resourceId: record.id,
      metadata: {
        conversationId: conversation.id,
        restaurantId: conversation.restaurantId ?? null,
        branchId: conversation.branchId ?? null,
        textLength: text.length,
      },
    });
    await this.publishConversationUpdated(updatedConversation);

    return toOutboundMessageResponse(record);
  }

  private async enqueueOutboundMessage(
    outboundMessageId: string,
  ): Promise<void> {
    try {
      await this.outboundDispatcherService?.enqueueOutboundMessage(
        outboundMessageId,
      );
    } catch (error) {
      this.logger.warn({
        message: 'Could not enqueue WhatsApp outbound message',
        outboundMessageId,
        error: getErrorMessage(error),
      });
    }
  }

  async processInboundEventJob(inboundEventId: string): Promise<boolean> {
    const event = await this.claimInboundEventForProcessing(inboundEventId);
    if (!event) {
      return false;
    }

    const webhook = normalizedWebhookPayloadFromInboundEvent(event);
    const jobStartedAt = new Date();
    this.logger.log({
      event: 'whatsapp_latency_inbound_job_started',
      inboundEventId,
      provider: webhook.provider,
      providerMessageId: webhook.providerMessageId ?? null,
      webhookKind: isMetaCloudStatusWebhook(webhook) ? 'status' : 'message',
      messageType: webhook.messageType ?? null,
      receivedToJobStartMs: elapsedMs(event.receivedAt, jobStartedAt),
    });
    try {
      const processed = await this.processInboundEvent(event, webhook);
      const completedAt = new Date();
      this.logger.log({
        event: 'whatsapp_latency_inbound_job_completed',
        inboundEventId,
        provider: webhook.provider,
        providerMessageId: webhook.providerMessageId ?? null,
        webhookKind: isMetaCloudStatusWebhook(webhook) ? 'status' : 'message',
        processed,
        jobDurationMs: elapsedMs(jobStartedAt, completedAt),
        receivedToJobCompletedMs: elapsedMs(event.receivedAt, completedAt),
      });

      return processed;
    } catch (error) {
      await this.markInboundEventFailed(event, error);
      this.logger.error({
        message: 'WhatsApp inbound webhook processing failed',
        provider: webhook.provider,
        providerEventId: webhook.providerEventId,
        inboundEventId,
        error: getErrorMessage(error),
      });

      return false;
    }
  }

  async enqueueStaleReceivedInboundEvents(input: {
    staleBefore: Date;
    limit: number;
  }): Promise<{ processed: number; enqueued: number; skipped: number }> {
    const events =
      await this.whatsappConversationsRepository.findReceivedInboundEventsBefore(
        {
          staleBefore: input.staleBefore,
          limit: input.limit,
        },
      );
    const result = {
      processed: 0,
      enqueued: 0,
      skipped: 0,
    };

    for (const event of events) {
      result.processed += 1;
      const enqueued = await this.inboundQueueService?.enqueueProcessJob(
        event.id,
      );
      if (enqueued) {
        result.enqueued += 1;
        continue;
      }

      result.skipped += 1;
      break;
    }

    return result;
  }

  private async enqueueInboundEvent(inboundEventId: string): Promise<void> {
    try {
      await this.inboundQueueService?.enqueueProcessJob(inboundEventId);
    } catch (error) {
      this.logger.warn({
        message: 'Could not enqueue WhatsApp inbound event',
        inboundEventId,
        error: getErrorMessage(error),
      });
    }
  }

  private async claimInboundEventForProcessing(
    inboundEventId: string,
  ): Promise<WhatsappInboundEventRecord | null> {
    return this.whatsappConversationsRepository.claimInboundEventForProcessing(
      inboundEventId,
    );
  }

  private async processInboundEvent(
    event: WhatsappInboundEventRecord,
    webhook: NormalizedWebhookPayload,
  ): Promise<boolean> {
    const channel = await this.whatsappChannelsService.resolveInboundChannel({
      providerPhoneNumberId: webhook.providerPhoneNumberId,
      phoneNumberNormalized: webhook.toPhoneNumberNormalized,
    });
    if (!channel || channel.provider !== webhook.provider) {
      await this.markInboundEventIgnored(event, 'No matching WhatsApp channel');
      return false;
    }

    const binding = await this.resolveInboundChannelBinding(channel);
    if (channel.mode === WhatsappChannelMode.DedicatedTenant && !binding) {
      await this.markInboundEventIgnored(
        event,
        'Dedicated WhatsApp channel has no active binding',
      );
      return false;
    }

    const tenantContext = getTenantContextFromChannelBinding(binding);
    await this.updateInboundEvent(event, {
      channelId: channel.id,
      workspaceId: tenantContext.workspaceId,
      restaurantId: tenantContext.restaurantId,
      branchId: tenantContext.branchId,
    });

    if (isMetaCloudStatusWebhook(webhook)) {
      const processed = await this.processMetaCloudStatusWebhook(
        event,
        tenantContext,
        webhook,
      );
      return processed;
    }

    if (!webhook.fromPhoneNumberNormalized || !webhook.fromPhoneNumber) {
      await this.markInboundEventIgnored(event, 'No customer phone number');
      return false;
    }

    const platformIdentity = await this.resolveOrCreatePlatformIdentity(
      webhook,
      channel,
    );
    await this.updateInboundEvent(event, {
      platformCustomerIdentityId: platformIdentity.id,
    });

    const conversation = await this.upsertConversationFromInbound(
      channel,
      binding,
      platformIdentity,
      webhook,
    );
    const checkoutSessionCode = extractCheckoutSessionCode(webhook.text);
    // Rules keep precedence even though this hook runs before normal dispatch:
    // deterministicInput tells the interpreter to skip recognized commands and
    // button/location/checkout inputs without calling the provider. Unknown text
    // is eligible only in the interpreter's explicitly supported states.
    if (this.standardFlowService && shouldProcessInboundText(webhook)) {
      const interpreted = await this.customerAiIntentService?.interpret({
        conversation,
        text: webhook.text,
        onInferenceStart: async () => {
          await this.outboundDispatcherService?.sendTypingIndicator({
            conversation,
            providerMessageId: webhook.providerMessageId,
            reason: 'customer-ai-intent',
          });
        },
        deterministicInput: isDeterministicCustomerAiInput(
          webhook,
          checkoutSessionCode,
          conversation,
        ),
      });
      if (interpreted && interpreted.status !== 'skipped') {
        if (interpreted.status === 'interpreted') {
          // Pass the validated action, not the original utterance. Reinterpreting
          // text here could conflict with the chosen action or start a second
          // flow. Existing handlers still resolve records and authorize access.
          await this.standardFlowService.processInbound({
            conversation,
            inboundEventId: event.id,
            providerMessageId: webhook.providerMessageId ?? null,
            interactionId: interpreted.actionId,
            restaurantSearch: interpreted.restaurantSearch,
            followup: interpreted.followup,
          });
        }
        // A stale result is also consumed: newer input/state owns the dialogue,
        // so neither this action nor an ordinary fallback reply should be sent.
        await this.updateInboundEvent(event, {
          conversationId: conversation.id,
          status: WhatsappInboundEventStatus.Processed,
          processedAt: new Date(),
        });
        // One live reply only: do not also enqueue shadow inference or the
        // ordinary unknown-message response for this same inbound event.
        return true;
      }
    }
    if (shouldRouteToStandardFlow(conversation, webhook, checkoutSessionCode)) {
      await this.standardFlowService?.processInbound({
        conversation,
        inboundEventId: event.id,
        providerMessageId: webhook.providerMessageId ?? null,
        text: webhook.text,
        interactionId: webhook.interactionId,
        interactionTitle: webhook.interactionTitle,
        location: webhook.location,
      });
      await this.updateInboundEvent(event, {
        conversationId: conversation.id,
        status: WhatsappInboundEventStatus.Processed,
        processedAt: new Date(),
      });
      await this.observeCustomerAiAfterDeterministicFlow(
        event,
        webhook,
        checkoutSessionCode,
        conversation,
      );
      return true;
    }

    if (!shouldProcessInboundText(webhook)) {
      await this.markInboundEventIgnored(
        event,
        'Unsupported WhatsApp message type',
      );
      return false;
    }

    await this.checkoutFlowService.processInboundTextForConversation(
      conversation,
      webhook.text,
      webhook.interactionId,
    );

    await this.updateInboundEvent(event, {
      conversationId: conversation.id,
      status: WhatsappInboundEventStatus.Processed,
      processedAt: new Date(),
    });

    await this.observeCustomerAiAfterDeterministicFlow(
      event,
      webhook,
      checkoutSessionCode,
      conversation,
    );

    return true;
  }

  /**
   * Capture shadow work only after the primary deterministic flow finishes.
   * The AI service then snapshots the resulting conversation state while still
   * retaining the input version that belongs to this exact inbound event.
   */
  private async observeCustomerAiAfterDeterministicFlow(
    event: WhatsappInboundEventRecord,
    webhook: NormalizedWebhookPayload,
    checkoutSessionCode: string | null | undefined,
    conversation: WhatsappConversationRecord,
  ): Promise<void> {
    try {
      await this.customerAiShadowService?.observeInbound({
        inboundEventId: event.id,
        customerMessage: webhook.text,
        deterministicInput: isDeterministicCustomerAiInput(
          webhook,
          checkoutSessionCode,
          conversation,
        ),
        conversation,
      });
    } catch (error) {
      this.logger.warn({
        event: 'customer_ai_shadow_hook_failed',
        inboundEventId: event.id,
        error: getErrorMessage(error),
      });
    }
  }

  private async processMetaCloudStatusWebhook(
    event: WhatsappInboundEventRecord,
    tenantContext: InboundChannelTenantContext,
    webhook: NormalizedWebhookPayload,
  ): Promise<boolean> {
    const statuses = extractMetaCloudStatusUpdates(webhook.rawPayload);
    if (statuses.length === 0) {
      await this.markInboundEventIgnored(event, 'No Meta status updates');
      return false;
    }

    for (const status of statuses) {
      this.logger.log({
        event: 'whatsapp_latency_meta_status_received',
        inboundEventId: event.id,
        provider: webhook.provider,
        providerMessageId: status.providerMessageId,
        providerStatus: status.status,
        statusTimestampToWebhookReceivedMs: status.timestamp
          ? elapsedMs(status.timestamp, event.receivedAt)
          : null,
      });
    }

    let reconciled = 0;
    if (tenantContext.workspaceId) {
      for (const status of statuses) {
        const updated =
          await this.campaignsService?.recordWhatsappProviderStatus({
            workspaceId: tenantContext.workspaceId,
            providerMessageId: status.providerMessageId,
            providerStatus: status.status,
            providerTimestamp: status.timestamp,
            failureReason: status.failureReason,
          });
        if (updated) {
          reconciled += 1;
        }
      }
    }

    await this.updateInboundEvent(event, {
      status: WhatsappInboundEventStatus.Processed,
      processedAt: new Date(),
      failureReason: reconciled > 0 ? null : 'No matching outbound message',
    });

    return reconciled > 0;
  }

  private async upsertConversationFromInbound(
    channel: WhatsappChannelRecord,
    binding: WhatsappChannelBindingRecord | null,
    platformIdentity: PlatformCustomerIdentityRecord,
    webhook: NormalizedWebhookPayload,
  ): Promise<WhatsappConversationRecord> {
    const now = new Date();
    const text = webhook.text ?? null;
    const customerPhoneNumber = webhook.fromPhoneNumber;
    const customerPhoneNumberNormalized = webhook.fromPhoneNumberNormalized;
    if (!customerPhoneNumber || !customerPhoneNumberNormalized) {
      throw AppError.internal('WhatsApp customer phone number is required');
    }

    const tenantContext = getTenantContextFromChannelBinding(binding);
    const tenantUpdate: Pick<
      WhatsappConversationUpdateSet,
      'workspaceId' | 'restaurantId' | 'branchId'
    > = tenantContext.workspaceId
      ? {
          workspaceId: tenantContext.workspaceId,
          restaurantId: tenantContext.restaurantId,
          branchId: tenantContext.branchId,
        }
      : {};
    const conversation =
      await this.whatsappConversationsRepository.upsertInboundConversation({
        channelId: channel.id,
        platformCustomerIdentityId: platformIdentity.id,
        customerPhoneNumberNormalized,
        set: {
          channelId: channel.id,
          channelMode: channel.mode,
          platformCustomerIdentityId: platformIdentity.id,
          ...tenantUpdate,
          customerName: webhook.customerName ?? null,
          status: WhatsappConversationStatus.WaitingForStaff,
          lastMessageText: text,
          lastMessageAt: now,
          lastInboundAt: now,
          lastInboundProviderMessageId: webhook.providerMessageId ?? null,
        },
        setOnInsert: {
          customerPhoneNumber,
          customerPhoneNumberNormalized,
          source: WhatsappConversationSource.Whatsapp,
          state: WhatsappConversationState.New,
          metadata: {},
        },
      });

    if (!conversation) {
      throw AppError.internal('Could not upsert WhatsApp conversation');
    }

    return conversation;
  }

  private async resolveInboundChannelBinding(
    channel: WhatsappChannelRecord,
  ): Promise<WhatsappChannelBindingRecord | null> {
    if (channel.mode !== WhatsappChannelMode.DedicatedTenant) {
      return null;
    }

    return this.whatsappChannelsService.findActiveBindingForChannel(channel.id);
  }

  private async resolveOrCreatePlatformIdentity(
    webhook: NormalizedWebhookPayload,
    channel: WhatsappChannelRecord,
  ): Promise<PlatformCustomerIdentityRecord> {
    const phoneNumber = webhook.fromPhoneNumber;
    const phoneNumberNormalized = webhook.fromPhoneNumberNormalized;
    if (!phoneNumber || !phoneNumberNormalized) {
      throw AppError.internal('WhatsApp customer phone number is required');
    }

    const identity =
      await this.whatsappConversationsRepository.resolveOrCreatePlatformIdentity(
        {
          phoneNumber,
          phoneNumberNormalized,
          whatsappProfileName: webhook.customerName ?? null,
          marketCode: channel.marketCode,
          lastSeenAt: new Date(),
        },
      );
    if (!identity) {
      throw AppError.internal('Could not resolve platform customer identity');
    }

    return identity;
  }

  private async applyCheckoutSessionLink(
    conversation: WhatsappConversationRecord,
    checkoutSession: CheckoutSessionRecord,
  ): Promise<WhatsappConversationRecord> {
    return this.updateConversation(conversation.id, {
      checkoutSessionId: checkoutSession.id,
      checkoutSessionCode: checkoutSession.sessionCode,
      orderId: checkoutSession.convertedOrderId ?? null,
      source: WhatsappConversationSource.StorefrontHandoff,
      state: WhatsappConversationState.CheckoutLinked,
    });
  }

  private async updateConversation(
    conversationId: string,
    set: WhatsappConversationUpdateSet,
  ): Promise<WhatsappConversationRecord> {
    const conversation =
      await this.whatsappConversationsRepository.updateConversation(
        conversationId,
        set,
      );
    if (!conversation) {
      throw this.conversationNotFound();
    }

    return conversation;
  }

  private async findConversationForWorkspace(
    workspaceId: string,
    conversationId: string,
  ): Promise<WhatsappConversationRecord> {
    const conversation =
      await this.whatsappConversationsRepository.findConversationForWorkspace(
        workspaceId,
        conversationId,
      );
    if (!conversation) {
      throw this.conversationNotFound();
    }

    return conversation;
  }

  private async findCheckoutSessionForManualLink(
    dto: LinkCheckoutSessionDto,
  ): Promise<CheckoutSessionRecord> {
    const token = toNullableText(dto.checkoutSessionToken);
    const code = extractCheckoutSessionCode(dto.checkoutSessionCode);
    if (!token && !code) {
      throw AppError.badRequest({
        code: AppResponseCode.ValidationError,
        message: 'checkoutSessionToken or checkoutSessionCode is required',
      });
    }

    const session = token
      ? await this.findCheckoutSessionByToken(token)
      : await this.findCheckoutSessionByCode(code as string);
    if (!session) {
      throw this.checkoutSessionNotFound();
    }
    if (isCheckoutSessionExpired(session)) {
      await this.markCheckoutSessionExpired(session.id);
      throw this.checkoutSessionExpired();
    }

    return session;
  }

  private async findCheckoutSessionByToken(
    checkoutSessionToken: string,
  ): Promise<CheckoutSessionRecord | null> {
    return this.whatsappConversationsRepository.findCheckoutSessionByTokenHash(
      sha256(checkoutSessionToken),
    );
  }

  private async findCheckoutSessionByCode(
    checkoutSessionCode: string,
  ): Promise<CheckoutSessionRecord | null> {
    return this.whatsappConversationsRepository.findCheckoutSessionByCode(
      checkoutSessionCode,
    );
  }

  private async markCheckoutSessionExpired(sessionId: string): Promise<void> {
    await this.whatsappConversationsRepository.markCheckoutSessionExpired(
      sessionId,
      new Date(),
    );
  }

  private assertCheckoutSessionBelongsToConversation(
    conversation: WhatsappConversationRecord,
    checkoutSession: CheckoutSessionRecord,
  ): void {
    if (conversation.workspaceId !== checkoutSession.workspaceId) {
      throw this.checkoutSessionNotFound();
    }
    if (
      conversation.restaurantId &&
      conversation.restaurantId !== checkoutSession.restaurantId
    ) {
      throw AppError.badRequest({
        code: AppResponseCode.ValidationError,
        message: 'Checkout session does not belong to this restaurant',
      });
    }
    if (
      conversation.branchId &&
      conversation.branchId !== checkoutSession.branchId
    ) {
      throw AppError.badRequest({
        code: AppResponseCode.ValidationError,
        message: 'Checkout session does not belong to this branch',
      });
    }
  }

  private async findOutboundMessageByIdempotencyKey(
    workspaceId: string,
    conversationId: string,
    idempotencyKeyHash: string,
  ): Promise<WhatsappOutboundMessageRecord | null> {
    return this.whatsappConversationsRepository.findOutboundMessageByIdempotencyKey(
      {
        workspaceId,
        conversationId,
        idempotencyKeyHash,
      },
    );
  }

  private async updateInboundEvent(
    event: WhatsappInboundEventRecord,
    set: Partial<WhatsappInboundEventRecord>,
  ): Promise<void> {
    await this.whatsappConversationsRepository.updateInboundEvent(
      event.id,
      set,
    );
  }

  private async markInboundEventIgnored(
    event: WhatsappInboundEventRecord,
    reason: string,
  ): Promise<void> {
    await this.updateInboundEvent(event, {
      status: WhatsappInboundEventStatus.Ignored,
      failureReason: reason,
      processedAt: new Date(),
    });
  }

  private async markInboundEventFailed(
    event: WhatsappInboundEventRecord,
    error: unknown,
  ): Promise<void> {
    await this.updateInboundEvent(event, {
      status: WhatsappInboundEventStatus.Failed,
      failureReason: truncateText(getErrorMessage(error), 500),
      processedAt: new Date(),
    });
  }

  private async publishConversationUpdated(
    conversation: WhatsappConversationRecord,
  ): Promise<void> {
    if (!conversation.workspaceId) {
      return;
    }

    try {
      await this.workspaceEventsService?.publishWhatsappConversationUpdated({
        workspaceId: conversation.workspaceId,
        restaurantId: conversation.restaurantId ?? undefined,
        branchId: conversation.branchId ?? undefined,
        conversationId: conversation.id,
        status: conversation.status,
        state: conversation.state,
        customerPhoneNumber: conversation.customerPhoneNumber,
        customerName: conversation.customerName ?? null,
        checkoutSessionId: conversation.checkoutSessionId ?? null,
        checkoutSessionCode: conversation.checkoutSessionCode ?? null,
        orderId: conversation.orderId ?? null,
        lastMessageText: conversation.lastMessageText ?? null,
        lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
      });
    } catch (error) {
      this.logger.warn({
        message: 'Could not publish WhatsApp conversation event',
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  private parseProvider(providerParam: string): WhatsappConnectionProvider {
    const provider = providerParam.trim().toLowerCase();
    if (isWhatsappProvider(provider)) {
      return provider;
    }

    throw AppError.badRequest({
      code: AppResponseCode.ValidationError,
      message: 'Unsupported WhatsApp webhook provider',
      data: {
        provider,
        allowedProviders: Object.values(WhatsappConnectionProvider),
      },
    });
  }

  private conversationNotFound(): AppError {
    return new AppError({
      code: AppResponseCode.WhatsappConversationNotFound,
      statusCode: HttpStatus.NOT_FOUND,
    });
  }

  private checkoutSessionNotFound(): AppError {
    return new AppError({
      code: AppResponseCode.CheckoutSessionNotFound,
      statusCode: HttpStatus.NOT_FOUND,
    });
  }

  private checkoutSessionExpired(): AppError {
    return AppError.badRequest({
      code: AppResponseCode.CheckoutSessionExpired,
      message: 'Checkout session has expired',
    });
  }
}

export { extractCheckoutSessionCode } from './whatsapp-checkout-flow.util';

function normalizeWebhookPayload(
  provider: WhatsappConnectionProvider,
  dto: WhatsappWebhookDto,
): NormalizedWebhookPayload {
  const rawPayload = dto.rawPayload ?? {};
  if (provider === WhatsappConnectionProvider.MetaCloud) {
    return normalizeMetaCloudWebhookPayload(provider, dto, rawPayload);
  }

  return normalizeGenericWebhookPayload(provider, dto, rawPayload);
}

function normalizeGenericWebhookPayload(
  provider: WhatsappConnectionProvider,
  dto: WhatsappWebhookDto,
  rawPayload: Record<string, unknown>,
): NormalizedWebhookPayload {
  const providerMessageId =
    toNullableText(dto.providerMessageId) ??
    readFirstString(rawPayload, [
      ['providerMessageId'],
      ['messageId'],
      ['message', 'id'],
      ['messages', 0, 'id'],
      ['entry', 0, 'changes', 0, 'value', 'messages', 0, 'id'],
    ]);
  const providerEventId =
    toNullableText(dto.providerEventId) ??
    readFirstString(rawPayload, [
      ['providerEventId'],
      ['eventId'],
      ['id'],
      ['webhookEventId'],
      ['entry', 0, 'id'],
      ['entry', 0, 'changes', 0, 'value', 'messages', 0, 'id'],
      ['entry', 0, 'changes', 0, 'value', 'statuses', 0, 'id'],
    ]) ??
    createStableProviderEventId(provider, rawPayload);
  const fromPhoneNumber =
    toNullableText(dto.fromPhoneNumber) ??
    readFirstString(rawPayload, [
      ['fromPhoneNumber'],
      ['from'],
      ['sender'],
      ['message', 'from'],
      ['messages', 0, 'from'],
      ['entry', 0, 'changes', 0, 'value', 'messages', 0, 'from'],
      ['entry', 0, 'changes', 0, 'value', 'contacts', 0, 'wa_id'],
    ]);
  const toPhoneNumber =
    toNullableText(dto.toPhoneNumber) ??
    readFirstString(rawPayload, [
      ['toPhoneNumber'],
      ['to'],
      ['recipient'],
      ['message', 'to'],
      ['metadata', 'display_phone_number'],
      ['entry', 0, 'changes', 0, 'value', 'metadata', 'display_phone_number'],
    ]);
  const providerPhoneNumberId =
    toNullableText(dto.providerPhoneNumberId) ??
    readFirstString(rawPayload, [
      ['providerPhoneNumberId'],
      ['phoneNumberId'],
      ['metadata', 'phone_number_id'],
      ['entry', 0, 'changes', 0, 'value', 'metadata', 'phone_number_id'],
    ]);
  const messageType =
    toNullableText(dto.messageType) ??
    readFirstString(rawPayload, [
      ['messageType'],
      ['type'],
      ['message', 'type'],
      ['messages', 0, 'type'],
      ['entry', 0, 'changes', 0, 'value', 'messages', 0, 'type'],
    ]) ??
    (readFirstString(rawPayload, [
      ['text'],
      ['body'],
      ['message', 'text'],
      ['messages', 0, 'text', 'body'],
      ['entry', 0, 'changes', 0, 'value', 'messages', 0, 'text', 'body'],
    ])
      ? 'text'
      : null);
  const text =
    toNullableText(dto.text) ??
    readFirstString(rawPayload, [
      ['text'],
      ['body'],
      ['message', 'text'],
      ['message', 'body'],
      ['messages', 0, 'text', 'body'],
      ['entry', 0, 'changes', 0, 'value', 'messages', 0, 'text', 'body'],
    ]);
  const customerName =
    toNullableText(dto.customerName) ??
    readFirstString(rawPayload, [
      ['customerName'],
      ['profileName'],
      ['contact', 'name'],
      ['contacts', 0, 'profile', 'name'],
      ['entry', 0, 'changes', 0, 'value', 'contacts', 0, 'profile', 'name'],
    ]);

  return {
    provider,
    providerEventId: truncateText(providerEventId, 240),
    providerMessageId: providerMessageId
      ? truncateText(providerMessageId, 240)
      : null,
    fromPhoneNumber,
    toPhoneNumber,
    fromPhoneNumberNormalized: normalizePhoneNumber(fromPhoneNumber),
    toPhoneNumberNormalized: normalizePhoneNumber(toPhoneNumber),
    providerPhoneNumberId: providerPhoneNumberId
      ? truncateText(providerPhoneNumberId, 120)
      : null,
    messageType: messageType ? truncateText(messageType, 80) : null,
    text: text ? truncateText(text, 4000) : null,
    interactionId: null,
    interactionTitle: null,
    location: null,
    customerName: customerName ? truncateText(customerName, 160) : null,
    providerTimestamp: null,
    rawPayload,
  };
}

function normalizeMetaCloudWebhookPayload(
  provider: WhatsappConnectionProvider,
  dto: WhatsappWebhookDto,
  rawPayload: Record<string, unknown>,
): NormalizedWebhookPayload {
  const meta = extractMetaCloudWebhookPayload(rawPayload);
  const providerMessageId =
    toNullableText(dto.providerMessageId) ?? meta.providerMessageId;
  const providerEventId =
    toNullableText(dto.providerEventId) ??
    meta.providerEventId ??
    createStableProviderEventId(provider, rawPayload);
  const fromPhoneNumber =
    toNullableText(dto.fromPhoneNumber) ?? meta.fromPhoneNumber;
  const toPhoneNumber = toNullableText(dto.toPhoneNumber) ?? meta.toPhoneNumber;
  const providerPhoneNumberId =
    toNullableText(dto.providerPhoneNumberId) ?? meta.providerPhoneNumberId;
  const messageType = toNullableText(dto.messageType) ?? meta.messageType;
  const text = toNullableText(dto.text) ?? meta.text;
  const customerName = toNullableText(dto.customerName) ?? meta.customerName;

  return {
    provider,
    providerEventId: truncateText(providerEventId, 240),
    providerMessageId: providerMessageId
      ? truncateText(providerMessageId, 240)
      : null,
    fromPhoneNumber,
    toPhoneNumber,
    fromPhoneNumberNormalized: normalizePhoneNumber(fromPhoneNumber),
    toPhoneNumberNormalized: normalizePhoneNumber(toPhoneNumber),
    providerPhoneNumberId: providerPhoneNumberId
      ? truncateText(providerPhoneNumberId, 120)
      : null,
    messageType: messageType ? truncateText(messageType, 80) : null,
    text: text ? truncateText(text, 4000) : null,
    interactionId: meta.interactionId
      ? truncateText(meta.interactionId, 256)
      : null,
    interactionTitle: meta.interactionTitle
      ? truncateText(meta.interactionTitle, 160)
      : null,
    location: meta.location,
    customerName: customerName ? truncateText(customerName, 160) : null,
    providerTimestamp: meta.providerTimestamp,
    rawPayload,
  };
}

type ExtractedMetaCloudWebhookPayload = {
  providerEventId?: string | null;
  providerMessageId?: string | null;
  fromPhoneNumber?: string | null;
  toPhoneNumber?: string | null;
  providerPhoneNumberId?: string | null;
  messageType?: string | null;
  text?: string | null;
  interactionId?: string | null;
  interactionTitle?: string | null;
  location?: NormalizedInboundLocation | null;
  customerName?: string | null;
  providerTimestamp?: Date | null;
};

function extractMetaCloudWebhookPayload(
  rawPayload: Record<string, unknown>,
): ExtractedMetaCloudWebhookPayload {
  const entry = firstRecord(rawPayload.entry);
  const change = firstRecord(entry?.changes);
  const value = readRecord(change?.value);
  const metadata =
    readRecord(value?.metadata) ?? readRecord(rawPayload.metadata);
  const message =
    firstRecord(value?.messages) ?? firstRecord(rawPayload.messages);
  const status =
    firstRecord(value?.statuses) ?? firstRecord(rawPayload.statuses);
  const contact =
    firstRecord(value?.contacts) ?? firstRecord(rawPayload.contacts);
  const messageType =
    toNullableText(message?.type) ?? (status ? 'status' : null);
  const messageTimestampText = toNullableText(message?.timestamp);
  const statusTimestampText = toNullableText(status?.timestamp);
  const providerTimestamp =
    parseMetaTimestamp(messageTimestampText) ??
    parseMetaTimestamp(statusTimestampText);
  const providerMessageId = toNullableText(message?.id);
  const statusId = toNullableText(status?.id);
  const statusRecipient = toNullableText(status?.recipient_id);
  const entryId = toNullableText(entry?.id);
  const changeField = toNullableText(change?.field);
  const providerEventId =
    providerMessageId ??
    createMetaStatusEventId(statusId, statusTimestampText, statusRecipient) ??
    createMetaChangeEventId(entryId, changeField, messageTimestampText) ??
    createMetaChangeEventId(entryId, changeField, statusTimestampText);

  return {
    providerEventId,
    providerMessageId,
    fromPhoneNumber:
      toNullableText(message?.from) ?? toNullableText(contact?.wa_id),
    toPhoneNumber: toNullableText(metadata?.display_phone_number),
    providerPhoneNumberId: toNullableText(metadata?.phone_number_id),
    messageType,
    text: readMetaMessageText(message, messageType),
    interactionId: readMetaInteractionId(message, messageType),
    interactionTitle: readMetaInteractionTitle(message, messageType),
    location: readMetaLocation(message, messageType),
    customerName: toNullableText(readPath(contact, ['profile', 'name'])),
    providerTimestamp,
  };
}

function isMetaCloudStatusWebhook(webhook: NormalizedWebhookPayload): boolean {
  return (
    webhook.provider === WhatsappConnectionProvider.MetaCloud &&
    webhook.messageType === 'status'
  );
}

function extractMetaCloudStatusUpdates(
  rawPayload: Record<string, unknown>,
): MetaCloudStatusUpdate[] {
  const statuses = collectMetaCloudStatusRecords(rawPayload);

  return statuses.flatMap((status) => {
    const providerMessageId = toNullableText(status.id);
    const providerStatus = toNullableText(status.status);
    if (!providerMessageId || !providerStatus) {
      return [];
    }

    return [
      {
        providerMessageId: truncateText(providerMessageId, 240),
        status: truncateText(providerStatus, 80),
        timestamp: parseMetaTimestamp(toNullableText(status.timestamp)),
        failureReason: extractMetaStatusFailureReason(status),
      },
    ];
  });
}

function collectMetaCloudStatusRecords(
  rawPayload: Record<string, unknown>,
): Record<string, unknown>[] {
  const directStatuses = readRecordArray(rawPayload.statuses);
  const entryStatuses = readRecordArray(rawPayload.entry).flatMap((entry) =>
    readRecordArray(entry.changes).flatMap((change) => {
      const value = readRecord(change.value);

      return readRecordArray(value?.statuses);
    }),
  );

  return [...directStatuses, ...entryStatuses];
}

function extractMetaStatusFailureReason(
  status: Record<string, unknown>,
): string | null {
  const error = firstRecord(status.errors);
  if (!error) {
    return null;
  }

  const code = toNullableText(error.code);
  const title = toNullableText(error.title);
  const message = toNullableText(error.message);
  const reason = [code, title, message].filter(Boolean).join(': ');

  return reason ? truncateText(reason, 500) : null;
}

function readMetaMessageText(
  message: Record<string, unknown> | null,
  messageType: string | null,
): string | null {
  if (!message) {
    return null;
  }

  if (messageType === 'text') {
    return toNullableText(readPath(message, ['text', 'body']));
  }

  if (messageType === 'button') {
    return (
      toNullableText(readPath(message, ['button', 'text'])) ??
      toNullableText(readPath(message, ['button', 'payload']))
    );
  }

  if (messageType !== 'interactive') {
    return null;
  }

  return (
    toNullableText(
      readPath(message, ['interactive', 'button_reply', 'title']),
    ) ??
    toNullableText(readPath(message, ['interactive', 'button_reply', 'id'])) ??
    toNullableText(readPath(message, ['interactive', 'list_reply', 'title'])) ??
    toNullableText(readPath(message, ['interactive', 'list_reply', 'id']))
  );
}

function readMetaInteractionId(
  message: Record<string, unknown> | null,
  messageType: string | null,
): string | null {
  if (!message) {
    return null;
  }
  if (messageType === 'button') {
    return toNullableText(readPath(message, ['button', 'payload']));
  }
  if (messageType !== 'interactive') {
    return null;
  }

  return (
    toNullableText(readPath(message, ['interactive', 'button_reply', 'id'])) ??
    toNullableText(readPath(message, ['interactive', 'list_reply', 'id']))
  );
}

function readMetaInteractionTitle(
  message: Record<string, unknown> | null,
  messageType: string | null,
): string | null {
  if (!message) {
    return null;
  }
  if (messageType === 'button') {
    return toNullableText(readPath(message, ['button', 'text']));
  }
  if (messageType !== 'interactive') {
    return null;
  }

  return (
    toNullableText(
      readPath(message, ['interactive', 'button_reply', 'title']),
    ) ??
    toNullableText(readPath(message, ['interactive', 'list_reply', 'title']))
  );
}

function readMetaLocation(
  message: Record<string, unknown> | null,
  messageType: string | null,
): NormalizedInboundLocation | null {
  if (!message || messageType !== 'location') {
    return null;
  }
  const location = readRecord(message.location);
  const latitude = readNumber(location?.latitude);
  const longitude = readNumber(location?.longitude);
  if (latitude === null || longitude === null) {
    return null;
  }

  return {
    latitude,
    longitude,
    name: toNullableText(location?.name),
    address: toNullableText(location?.address),
  };
}

function createMetaStatusEventId(
  statusId: string | null,
  timestamp: string | null,
  recipient: string | null,
): string | null {
  if (!statusId || !timestamp || !recipient) {
    return null;
  }

  return `${statusId}:${timestamp}:${recipient}`;
}

function createMetaChangeEventId(
  entryId: string | null,
  changeField: string | null,
  timestamp: string | null,
): string | null {
  if (!entryId || !changeField || !timestamp) {
    return null;
  }

  return `${entryId}:${changeField}:${timestamp}`;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return readRecord(value[0]);
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord);
}

function readNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function parseMetaTimestamp(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return new Date(seconds * 1000);
}

function normalizedWebhookPayloadFromInboundEvent(
  event: WhatsappInboundEventRecord,
): NormalizedWebhookPayload {
  return {
    provider: event.provider,
    providerEventId: event.providerEventId,
    providerMessageId: event.providerMessageId ?? null,
    fromPhoneNumber: event.fromPhoneNumber ?? null,
    toPhoneNumber: event.toPhoneNumber ?? null,
    fromPhoneNumberNormalized: normalizePhoneNumber(event.fromPhoneNumber),
    toPhoneNumberNormalized: normalizePhoneNumber(event.toPhoneNumber),
    providerPhoneNumberId: event.providerPhoneNumberId ?? null,
    messageType: event.messageType ?? null,
    text: event.text ?? null,
    interactionId: event.interactionId ?? null,
    interactionTitle: event.interactionTitle ?? null,
    location: event.location ?? null,
    customerName: event.customerName ?? null,
    providerTimestamp: event.providerTimestamp ?? null,
    rawPayload: event.rawPayload ?? {},
  };
}

function getTenantContextFromChannelBinding(
  binding: WhatsappChannelBindingRecord | null,
): InboundChannelTenantContext {
  if (!binding) {
    return {
      workspaceId: null,
      restaurantId: null,
      branchId: null,
      bindingId: null,
    };
  }

  return {
    workspaceId: binding.workspaceId,
    restaurantId: binding.restaurantId,
    branchId: binding.branchId ?? null,
    bindingId: binding.id,
  };
}

function shouldRouteToStandardFlow(
  conversation: WhatsappConversationRecord,
  webhook: NormalizedWebhookPayload,
  checkoutSessionCode: string | null | undefined,
): boolean {
  if (checkoutSessionCode) {
    return false;
  }
  if (parseWhatsappCheckoutFlowActionId(webhook.interactionId)) return false;
  if (
    webhook.text?.trim().toLowerCase() === 'email' ||
    conversation.state === WhatsappConversationState.AwaitingEmail
  )
    return true;
  if (isWhatsappHomeCommand(webhook.text)) {
    return true;
  }
  if (
    parseWhatsappStandardFlowActionId(webhook.interactionId) ||
    (!webhook.interactionId &&
      resolveWhatsappStandardTextAction(conversation, webhook.text))
  ) {
    return true;
  }
  if (
    webhook.location &&
    conversation.state === WhatsappConversationState.AwaitingLocation
  ) {
    return true;
  }

  return (
    isWhatsappStandardFlowState(conversation.state) ||
    !conversation.workspaceId ||
    !conversation.restaurantId
  );
}

/**
 * Protects the existing command path from unnecessary inference and cost.
 * Includes normalized natural-language aliases as well as exact button IDs.
 * Returning true is only a routing exclusion: checkout handlers still decide
 * whether a command such as confirm/cancel is valid at the current step.
 * Keep fulfillment aliases shared with parseCommand through the same helper;
 * otherwise a phrase checkout already understands can incur an AI call first.
 * Do not replace these checks with broad keyword matching: field values and
 * negated or compound requests must remain available to their proper handlers.
 */
function isDeterministicCustomerAiInput(
  webhook: NormalizedWebhookPayload,
  checkoutSessionCode: string | null | undefined,
  conversation: WhatsappConversationRecord,
): boolean {
  if (
    checkoutSessionCode ||
    readWhatsappFulfillmentChoice(webhook.text, conversation.state) ||
    webhook.location ||
    webhook.interactionId ||
    isWhatsappHomeCommand(webhook.text) ||
    resolveWhatsappStandardTextAction(conversation, webhook.text)
  ) {
    return true;
  }
  const normalizedText = normalizeWhatsappCheckoutText(webhook.text);
  if (
    conversation.state === WhatsappConversationState.AwaitingConfirmation &&
    (normalizedText === 'change' || normalizedText === 'edit')
  )
    return true;

  return Boolean(
    normalizedText &&
    [
      '1',
      '2',
      'pickup',
      'delivery',
      'confirm',
      'yes',
      'y',
      'cancel',
      'stop',
      'help',
      'support',
      'contact support',
    ].includes(normalizedText),
  );
}

function toConversationResponse(
  conversation: WhatsappConversationRecord,
): WhatsappConversationResponse {
  if (!conversation.workspaceId) {
    throw AppError.internal(
      'Tenant conversation response requires workspaceId',
    );
  }

  return {
    id: conversation.id,
    workspaceId: conversation.workspaceId,
    restaurantId: conversation.restaurantId ?? null,
    branchId: conversation.branchId ?? null,
    channelId: conversation.channelId ?? null,
    customerPhoneNumber: conversation.customerPhoneNumber,
    customerPhoneNumberNormalized: conversation.customerPhoneNumberNormalized,
    customerName: conversation.customerName ?? null,
    status: conversation.status,
    source: conversation.source,
    checkoutSessionId: conversation.checkoutSessionId ?? null,
    checkoutSessionCode: conversation.checkoutSessionCode ?? null,
    orderId: conversation.orderId ?? null,
    lastMessageText: conversation.lastMessageText ?? null,
    lastMessageAt: conversation.lastMessageAt ?? null,
    lastInboundAt: conversation.lastInboundAt ?? null,
    lastOutboundAt: conversation.lastOutboundAt ?? null,
    state: conversation.state,
    metadata: conversation.metadata,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

function shouldProcessInboundText(webhook: NormalizedWebhookPayload): boolean {
  return Boolean(
    toNullableText(webhook.text) ||
    parseWhatsappCheckoutFlowActionId(webhook.interactionId),
  );
}

function hashConversationIdempotencyKey(
  workspaceId: string,
  conversationId: string,
  idempotencyKey: string,
): string {
  return sha256(`${workspaceId}:${conversationId}:${idempotencyKey.trim()}`);
}

function createStableProviderEventId(
  provider: WhatsappConnectionProvider,
  rawPayload: Record<string, unknown>,
): string {
  return `hash_${sha256(`${provider}:${stableStringify(rawPayload)}`)}`;
}

function readFirstString(
  value: unknown,
  paths: readonly (readonly (string | number)[])[],
): string | null {
  for (const path of paths) {
    const stringValue = toNullableText(readPath(value, path));
    if (stringValue) {
      return stringValue;
    }
  }

  return null;
}

function readPath(value: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (typeof key === 'number') {
      return Array.isArray(current) ? current[key] : undefined;
    }
    if (!isRecord(current)) {
      return undefined;
    }

    return current[key];
  }, value);
}

function isWhatsappProvider(
  value: string,
): value is WhatsappConnectionProvider {
  return Object.values(WhatsappConnectionProvider).includes(
    value as WhatsappConnectionProvider,
  );
}
