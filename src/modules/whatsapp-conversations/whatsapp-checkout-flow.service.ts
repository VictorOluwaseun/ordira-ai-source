import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { sha256 } from '@common/utils/crypto.util';
import { toOptionalFiniteNumber as toOptionalNumber } from '@common/utils/input-normalization.util';
import { createStableStringifier } from '@common/utils/json.util';
import { isHttpUrl } from '@common/utils/url.util';
import {
  getErrorMessage,
  isMongoDuplicateKeyError as isDuplicateKeyError,
} from '@common/utils/error.util';
import { isRecord } from '@common/utils/object.util';
import { AppResponseCode } from '@common/constants/response-codes.constants';
import { AppError } from '@common/errors/app.error';
import {
  AuditAction,
  AuditActorType,
  AuditOutcome,
  AuditSource,
} from '@modules/audit/audit.types';
import { AuditService } from '@modules/audit/audit.service';
import { BranchOperationsService } from '@modules/branch-operations/branch-operations.service';
import { BranchesRepository } from '@modules/branches/branches.repository';
import type { BranchRecord } from '@modules/branches/schemas/branch.schema';
import {
  CheckoutSessionsService,
  type ConfirmCheckoutSessionForConversationResult,
} from '@modules/checkout-sessions/checkout-sessions.service';
import type { SendCheckoutSessionWhatsappOrderRequestDto } from '@modules/checkout-sessions/dto/send-checkout-session-whatsapp-order-request.dto';
import { type CheckoutSessionRecord } from '@modules/checkout-sessions/schemas/checkout-session.schema';
import type { OrderDeliveryAddressDto } from '@modules/orders/dto/order-delivery-address.dto';
import {
  type OrderDeliveryAddress,
  OrderFulfillmentType,
  OrderTimingType,
} from '@modules/orders/schemas/order.schema';
import { WorkspaceEventsService } from '@modules/workspace-events/workspace-events.service';
import {
  type WhatsappConversationRecord,
  WhatsappConversationSource,
  WhatsappConversationState,
  WhatsappConversationStatus,
} from './schemas/whatsapp-conversation.schema';
import {
  type WhatsappOutboundMessageRecord,
  WhatsappOutboundMessageStatus,
  WhatsappOutboundMessageType,
} from './schemas/whatsapp-outbound-message.schema';
import {
  WhatsappConversationsRepository,
  type WhatsappConversationUpdateSet,
} from './whatsapp-conversations.repository';
import {
  extractCheckoutSessionCode,
  normalizeWhatsappCheckoutText,
  readWhatsappFulfillmentChoice,
} from './whatsapp-checkout-flow.util';
import {
  parseWhatsappCheckoutFlowActionId,
  WhatsappCheckoutFlowActionKey,
} from './whatsapp-checkout-flow-action-registry';
import { WhatsappOutboundDispatcherService } from './whatsapp-outbound-dispatcher.service';
import { formatWhatsappMinorUnit as formatMinorUnit } from './whatsapp-format.util';
import { WhatsappOutboundJobPriority } from './whatsapp-outbound-queue.constants';
import type { WhatsappOutboundContent } from './types/whatsapp-outbound-content.type';

const stableStringify = createStableStringifier({
  undefinedValue: 'undefined',
});

type WhatsappCheckoutCommand =
  | 'pickup'
  | 'delivery'
  | 'confirm'
  | 'cancel'
  | 'edit'
  | 'help'
  | 'unknown';

type WhatsappCheckoutFlowMetadata = Record<string, unknown> & {
  fulfillmentType?: OrderFulfillmentType;
  deliveryAddress?: OrderDeliveryAddress;
  lastCommand?:
    | WhatsappCheckoutCommand
    | 'checkout_code'
    | 'delivery_address'
    | 'order_request';
  checkoutFlowUpdatedAt?: string;
};

type ConversationPatch = Partial<
  Pick<
    WhatsappConversationUpdateSet,
    | 'checkoutSessionId'
    | 'checkoutSessionCode'
    | 'workspaceId'
    | 'restaurantId'
    | 'branchId'
    | 'source'
    | 'state'
    | 'status'
    | 'metadata'
    | 'orderId'
  >
>;

type QueueBotTextInput = {
  conversation: WhatsappConversationRecord;
  text: string;
  patch?: ConversationPatch;
  auditAction?: AuditAction;
  auditMetadata?: Record<string, unknown>;
};

type QueueBotMessageInput = QueueBotTextInput & {
  content?: WhatsappOutboundContent;
  responseAction?: string;
  idempotencyKeyHash?: string;
};

export type CheckoutSessionWhatsappOrderRequestResult = {
  queued: boolean;
  checkoutSessionId: string;
  sessionCode: string;
  conversationId: string;
  outboundMessageId: string;
  whatsappUrl: string;
};

const PICKUP_CONFIRMATION_PROMPT =
  'Reply CONFIRM to place your pickup order or CANCEL to stop.';
const DELIVERY_ADDRESS_PROMPT = 'Please send your delivery address.';
const DELIVERY_CONFIRMATION_PROMPT =
  'Delivery address saved. Reply CONFIRM to place your order or CANCEL to stop.';
const CHECKOUT_CODE_PROMPT =
  'Please open your Ordira checkout link or send your checkout code to continue.';
const FULFILLMENT_PROMPT = 'Reply 1 for pickup or 2 for delivery.';
const CONFIRMATION_PROMPT =
  'Reply CONFIRM to place your order or CANCEL to stop.';
const CANCELLED_PROMPT = 'Okay, your checkout was not submitted.';
const MAX_ORDER_SUMMARY_ITEM_LINES = 5;
const MAX_ORDER_SUMMARY_MODIFIERS_PER_ITEM = 2;

@Injectable()
export class WhatsappCheckoutFlowService {
  private readonly logger = new Logger(WhatsappCheckoutFlowService.name);

  constructor(
    private readonly whatsappConversationsRepository: WhatsappConversationsRepository,
    private readonly branchesRepository: BranchesRepository,
    private readonly checkoutSessionsService: CheckoutSessionsService,
    private readonly auditService: AuditService,
    @Optional()
    private readonly outboundDispatcherService?: WhatsappOutboundDispatcherService,
    @Optional()
    private readonly workspaceEventsService?: WorkspaceEventsService,
    @Optional()
    private readonly branchOperationsService?: BranchOperationsService,
  ) {}

  async requestCheckoutOrderConfirmation(
    sessionToken: string,
    dto: SendCheckoutSessionWhatsappOrderRequestDto,
  ): Promise<CheckoutSessionWhatsappOrderRequestResult> {
    const session =
      await this.checkoutSessionsService.prepareWhatsappOrderRequest(
        sessionToken,
        dto,
      );
    const conversation =
      await this.whatsappConversationsRepository.findConversationByCheckoutSessionId(
        session.id,
      );
    if (!conversation) {
      throw AppError.badRequest({
        code: AppResponseCode.WhatsappConversationNotFound,
        message: 'WhatsApp conversation not found for checkout session',
      });
    }

    const handoff =
      await this.checkoutSessionsService.getWhatsappHandoff(sessionToken);
    const whatsappUrl = toPlainWhatsappUrl(handoff.url);
    if (!handoff.available || !whatsappUrl) {
      throw new AppError({
        code: AppResponseCode.RequestFailed,
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'WhatsApp handoff is not available right now',
      });
    }

    const branch = await this.findCheckoutSessionBranch(session);
    if (!branch) {
      throw AppError.badRequest({
        code: AppResponseCode.BranchNotFound,
      });
    }

    const message = await this.queueOrderRequestPrompt({
      conversation,
      session,
      branch,
      dto,
    });

    return {
      queued: true,
      checkoutSessionId: session.id,
      sessionCode: session.sessionCode,
      conversationId: conversation.id,
      outboundMessageId: message.outboundMessageId,
      whatsappUrl,
    };
  }

  async processInboundTextForConversation(
    conversation: WhatsappConversationRecord,
    text: string | null | undefined,
    interactionId?: string | null,
  ): Promise<WhatsappConversationRecord> {
    const checkoutSessionCode = extractCheckoutSessionCode(text);
    if (checkoutSessionCode) {
      return this.handleCheckoutCode(conversation, checkoutSessionCode);
    }

    const command = parseCommand(text, interactionId, conversation.state);
    if (command === 'help') {
      return this.handleHelp(conversation);
    }
    if (command === 'cancel') {
      return this.handleCancel(conversation);
    }
    if (command === 'edit') {
      return this.handleEditCart(conversation);
    }
    if (command === 'pickup' || command === 'delivery') {
      return this.handleFulfillmentChoice(conversation, command);
    }
    if (command === 'confirm') {
      return this.handleConfirmation(conversation);
    }
    if (
      conversation.state === WhatsappConversationState.AwaitingDeliveryAddress
    ) {
      return this.handleDeliveryAddress(conversation, text);
    }

    return this.handleUnknownMessage(conversation);
  }

  private async queueOrderRequestPrompt(input: {
    conversation: WhatsappConversationRecord;
    session: CheckoutSessionRecord;
    branch: BranchRecord;
    dto: SendCheckoutSessionWhatsappOrderRequestDto;
  }): Promise<{
    conversation: WhatsappConversationRecord;
    outboundMessageId: string;
  }> {
    const fulfillmentAvailability = await this.getBranchFulfillmentAvailability(
      input.branch,
    );
    const basePatch: ConversationPatch = {
      workspaceId: input.session.workspaceId,
      restaurantId: input.session.restaurantId,
      branchId: input.session.branchId,
      checkoutSessionId: input.session.id,
      checkoutSessionCode: input.session.sessionCode,
      orderId: input.session.convertedOrderId ?? null,
      source: WhatsappConversationSource.StorefrontHandoff,
    };
    const idempotencyKeyHash = hashCheckoutOrderRequest({
      session: input.session,
      fulfillmentType: input.dto.fulfillmentType ?? null,
      deliveryAddress: input.dto.deliveryAddress ?? null,
    });
    const existingMessage =
      await this.whatsappConversationsRepository.findOutboundMessageByIdempotencyKey(
        {
          workspaceId: input.session.workspaceId,
          conversationId: input.conversation.id,
          idempotencyKeyHash,
        },
      );
    const prompt = this.buildOrderRequestPrompt({
      conversation: input.conversation,
      session: input.session,
      fulfillmentAvailability,
      fulfillmentType: input.dto.fulfillmentType,
      deliveryAddress: input.dto.deliveryAddress,
      basePatch,
    });

    if (existingMessage) {
      if (existingMessage.status === WhatsappOutboundMessageStatus.Queued) {
        const enqueued = await this.enqueueOutboundMessage(existingMessage.id);
        if (!enqueued) {
          throw whatsappQueueUnavailable();
        }
      }

      const updatedConversation = await this.updateConversation(
        input.conversation,
        {
          ...prompt.patch,
          lastMessageText: prompt.text,
          lastMessageAt: new Date(),
          lastOutboundAt: new Date(),
        },
      );

      return {
        conversation: updatedConversation,
        outboundMessageId: existingMessage.id,
      };
    }

    return this.queueBotMessage({
      conversation: input.conversation,
      text: prompt.text,
      content: prompt.content,
      patch: prompt.patch,
      auditAction: AuditAction.WhatsappConversationCheckoutFlowUpdated,
      auditMetadata: {
        checkoutSessionId: input.session.id,
        checkoutSessionCode: input.session.sessionCode,
        responseAction: prompt.responseAction,
        fulfillmentType: input.dto.fulfillmentType ?? null,
      },
      responseAction: prompt.responseAction,
      idempotencyKeyHash,
    });
  }

  private buildOrderRequestPrompt(input: {
    conversation: WhatsappConversationRecord;
    session: CheckoutSessionRecord;
    fulfillmentAvailability: {
      pickupAvailable: boolean;
      deliveryAvailable: boolean;
    };
    fulfillmentType?: OrderFulfillmentType;
    deliveryAddress?: OrderDeliveryAddressDto;
    basePatch: ConversationPatch;
  }): {
    text: string;
    content: WhatsappOutboundContent;
    patch: ConversationPatch;
    responseAction: string;
  } {
    const orderSummary = formatCheckoutOrderSummary(input.session);
    // A new basket must not inherit the previous order's fulfillment choice or
    // address. Availability decides which buttons exist, never the user's choice.
    const unselectedMetadata = this.withMetadata(input.conversation, {
      lastCommand: 'order_request',
    });
    delete unselectedMetadata.fulfillmentType;
    delete unselectedMetadata.deliveryAddress;

    if (
      !input.fulfillmentAvailability.pickupAvailable &&
      !input.fulfillmentAvailability.deliveryAvailable
    ) {
      const text = `${orderSummary}\n\nThis branch is not accepting pickup or delivery orders right now. Please contact staff.`;

      return {
        text,
        content: {
          type: 'text',
          text,
        },
        patch: {
          ...input.basePatch,
          state: WhatsappConversationState.HandoffToStaff,
          status: WhatsappConversationStatus.WaitingForStaff,
          metadata: unselectedMetadata,
        },
        responseAction: 'order_request_unavailable',
      };
    }

    if (!input.fulfillmentType) {
      const question =
        input.fulfillmentAvailability.pickupAvailable &&
        input.fulfillmentAvailability.deliveryAvailable
          ? 'Would you like pickup or delivery?'
          : input.fulfillmentAvailability.pickupAvailable
            ? 'This branch currently offers pickup only. Would you like to collect your order?'
            : 'This branch currently offers delivery only. Would you like your order delivered?';
      const text = truncateInteractiveBody(`${orderSummary}\n\n${question}`);

      return {
        text,
        content: {
          type: 'reply_buttons',
          body: text,
          headerImageUrl: getOrderRequestHeaderImageUrl(input.session),
          buttons: [
            ...(input.fulfillmentAvailability.pickupAvailable
              ? [
                  {
                    id: WhatsappCheckoutFlowActionKey.Pickup,
                    title: '🛍️ Pickup',
                  },
                ]
              : []),
            ...(input.fulfillmentAvailability.deliveryAvailable
              ? [
                  {
                    id: WhatsappCheckoutFlowActionKey.Delivery,
                    title: '🛵 Delivery',
                  },
                ]
              : []),
            {
              id: WhatsappCheckoutFlowActionKey.Cancel,
              title: '❌ Cancel',
            },
          ],
        },
        patch: {
          ...input.basePatch,
          state: WhatsappConversationState.AwaitingFulfillment,
          status: WhatsappConversationStatus.WaitingForCustomer,
          metadata: unselectedMetadata,
        },
        responseAction: 'order_request_fulfillment',
      };
    }

    this.assertFulfillmentAvailable(
      input.fulfillmentType,
      input.fulfillmentAvailability,
    );

    if (
      input.fulfillmentType === OrderFulfillmentType.Delivery &&
      !input.deliveryAddress
    ) {
      const text = `${orderSummary}\n\nPlease send your delivery address.`;

      return {
        text,
        content: {
          type: 'text',
          text,
        },
        patch: {
          ...input.basePatch,
          state: WhatsappConversationState.AwaitingDeliveryAddress,
          status: WhatsappConversationStatus.WaitingForCustomer,
          metadata: this.withMetadata(input.conversation, {
            fulfillmentType: OrderFulfillmentType.Delivery,
            lastCommand: 'order_request',
          }),
        },
        responseAction: 'order_request_delivery_address',
      };
    }

    const metadata = this.withMetadata(input.conversation, {
      fulfillmentType: input.fulfillmentType,
      ...(input.fulfillmentType === OrderFulfillmentType.Delivery
        ? {
            deliveryAddress: toDeliveryAddress(input.deliveryAddress),
          }
        : {}),
      lastCommand: 'order_request',
    });
    if (input.fulfillmentType === OrderFulfillmentType.Pickup) {
      delete metadata.deliveryAddress;
    }

    const fulfillmentLabel =
      input.fulfillmentType === OrderFulfillmentType.Pickup
        ? 'pickup'
        : 'delivery';
    const text = truncateInteractiveBody(
      `${orderSummary}\n\nReady to submit this ${fulfillmentLabel} order?`,
    );

    return {
      text,
      content: {
        type: 'reply_buttons',
        body: text,
        headerImageUrl: getOrderRequestHeaderImageUrl(input.session),
        buttons: [
          {
            id: WhatsappCheckoutFlowActionKey.Confirm,
            title: '✅ Confirm',
          },
          {
            id: WhatsappCheckoutFlowActionKey.Edit,
            title: '✏️ Change',
          },
          {
            id: WhatsappCheckoutFlowActionKey.Cancel,
            title: '❌ Cancel',
          },
        ],
      },
      patch: {
        ...input.basePatch,
        state: WhatsappConversationState.AwaitingConfirmation,
        status: WhatsappConversationStatus.WaitingForCustomer,
        metadata,
      },
      responseAction: 'order_request_confirmation',
    };
  }

  private async handleCheckoutCode(
    conversation: WhatsappConversationRecord,
    checkoutSessionCode: string,
  ): Promise<WhatsappConversationRecord> {
    const checkoutSession =
      await this.findActiveCheckoutSessionByCode(checkoutSessionCode);
    if (
      !checkoutSession ||
      !isCheckoutSessionCompatibleWithConversation(
        conversation,
        checkoutSession,
      )
    ) {
      return this.queueBotText({
        conversation,
        text: CHECKOUT_CODE_PROMPT,
      });
    }

    const branch = await this.findCheckoutSessionBranch(checkoutSession);
    if (!branch) {
      return this.queueBotText({
        conversation,
        text: 'We found your cart, but this branch is no longer available. Please contact staff.',
        patch: {
          workspaceId: checkoutSession.workspaceId,
          restaurantId: checkoutSession.restaurantId,
          branchId: checkoutSession.branchId,
          checkoutSessionId: checkoutSession.id,
          checkoutSessionCode: checkoutSession.sessionCode,
          orderId: checkoutSession.convertedOrderId ?? null,
          source: WhatsappConversationSource.StorefrontHandoff,
          state: WhatsappConversationState.HandoffToStaff,
          status: WhatsappConversationStatus.WaitingForStaff,
          metadata: this.withMetadata(conversation, {
            lastCommand: 'checkout_code',
          }),
        },
        auditAction: AuditAction.WhatsappConversationCheckoutFlowUpdated,
        auditMetadata: {
          checkoutSessionId: checkoutSession.id,
          checkoutSessionCode: checkoutSession.sessionCode,
          reason: 'branch_not_available',
        },
      });
    }

    return this.handleLinkedCheckoutSession(
      conversation,
      checkoutSession,
      branch,
    );
  }

  private async handleLinkedCheckoutSession(
    conversation: WhatsappConversationRecord,
    checkoutSession: CheckoutSessionRecord,
    branch: BranchRecord,
  ): Promise<WhatsappConversationRecord> {
    const basePatch: ConversationPatch = {
      workspaceId: checkoutSession.workspaceId,
      restaurantId: checkoutSession.restaurantId,
      branchId: checkoutSession.branchId,
      checkoutSessionId: checkoutSession.id,
      checkoutSessionCode: checkoutSession.sessionCode,
      orderId: checkoutSession.convertedOrderId ?? null,
      source: WhatsappConversationSource.StorefrontHandoff,
    };
    const fulfillmentAvailability =
      await this.getBranchFulfillmentAvailability(branch);

    // Use the same explicit-choice prompt for a pasted checkout code and the
    // storefront handoff, including branches with only one available service.
    const prompt = this.buildOrderRequestPrompt({
      conversation,
      session: checkoutSession,
      fulfillmentAvailability,
      basePatch,
    });
    const result = await this.queueBotMessage({
      conversation,
      text: prompt.text,
      content: prompt.content,
      patch: prompt.patch,
      responseAction: prompt.responseAction,
      auditAction: AuditAction.WhatsappConversationCheckoutFlowUpdated,
      auditMetadata: {
        checkoutSessionId: checkoutSession.id,
        checkoutSessionCode: checkoutSession.sessionCode,
        responseAction: prompt.responseAction,
      },
    });
    return result.conversation;
  }

  private async handleFulfillmentChoice(
    conversation: WhatsappConversationRecord,
    command: 'pickup' | 'delivery',
  ): Promise<WhatsappConversationRecord> {
    if (!conversation.checkoutSessionId) {
      return this.queueBotText({
        conversation,
        text: CHECKOUT_CODE_PROMPT,
      });
    }

    const fulfillmentType =
      command === 'pickup'
        ? OrderFulfillmentType.Pickup
        : OrderFulfillmentType.Delivery;
    const support = await this.resolveFulfillmentSupport(
      conversation,
      fulfillmentType,
    );
    if (!support.supported) {
      return this.queueBotText({
        conversation,
        text: support.message,
        patch: {
          state: support.nextState,
          status: WhatsappConversationStatus.WaitingForCustomer,
          metadata: this.withMetadata(conversation, {
            lastCommand: command,
          }),
        },
      });
    }

    if (fulfillmentType === OrderFulfillmentType.Delivery) {
      const metadata = this.withMetadata(conversation, {
        fulfillmentType,
        lastCommand: command,
      });
      // A renewed delivery choice asks for a fresh address; an earlier address
      // must not allow CONFIRM to skip that question. Clear it in the same patch
      // that enters AwaitingDeliveryAddress so a correction cannot carry a stale
      // destination through checkout. Selecting delivery still does not submit
      // the order; the customer must finish the address and confirmation steps.
      delete metadata.deliveryAddress;
      return this.queueBotText({
        conversation,
        text: DELIVERY_ADDRESS_PROMPT,
        patch: {
          state: WhatsappConversationState.AwaitingDeliveryAddress,
          status: WhatsappConversationStatus.WaitingForCustomer,
          metadata,
        },
        auditAction: AuditAction.WhatsappConversationCheckoutFlowUpdated,
        auditMetadata: {
          checkoutSessionId: conversation.checkoutSessionId,
          fulfillmentType,
        },
      });
    }

    const metadata = this.withMetadata(conversation, {
      fulfillmentType,
      lastCommand: command,
    });
    delete metadata.deliveryAddress;

    return this.queueBotText({
      conversation,
      text: PICKUP_CONFIRMATION_PROMPT,
      patch: {
        state: WhatsappConversationState.AwaitingConfirmation,
        status: WhatsappConversationStatus.WaitingForCustomer,
        metadata,
      },
      auditAction: AuditAction.WhatsappConversationCheckoutFlowUpdated,
      auditMetadata: {
        checkoutSessionId: conversation.checkoutSessionId,
        fulfillmentType,
      },
    });
  }

  private async handleDeliveryAddress(
    conversation: WhatsappConversationRecord,
    text: string | null | undefined,
  ): Promise<WhatsappConversationRecord> {
    if (!conversation.checkoutSessionId) {
      return this.queueBotText({
        conversation,
        text: CHECKOUT_CODE_PROMPT,
      });
    }

    const addressText = text?.trim();
    if (!addressText) {
      return this.queueBotText({
        conversation,
        text: DELIVERY_ADDRESS_PROMPT,
      });
    }

    return this.queueBotText({
      conversation,
      text: DELIVERY_CONFIRMATION_PROMPT,
      patch: {
        state: WhatsappConversationState.AwaitingConfirmation,
        status: WhatsappConversationStatus.WaitingForCustomer,
        metadata: this.withMetadata(conversation, {
          fulfillmentType: OrderFulfillmentType.Delivery,
          deliveryAddress: {
            note: addressText,
          },
          lastCommand: 'delivery_address',
        }),
      },
      auditAction: AuditAction.WhatsappConversationCheckoutFlowUpdated,
      auditMetadata: {
        checkoutSessionId: conversation.checkoutSessionId,
        fulfillmentType: OrderFulfillmentType.Delivery,
        deliveryAddressCaptured: true,
      },
    });
  }

  private async handleConfirmation(
    conversation: WhatsappConversationRecord,
  ): Promise<WhatsappConversationRecord> {
    // A conversation is reused across checkouts. Its orderId may belong to an
    // older checkout; the linked session owns the idempotent conversion result.
    if (conversation.orderId && !conversation.checkoutSessionId) {
      return this.queueBotText({
        conversation,
        text: 'Your order has been submitted.',
      });
    }
    if (!conversation.checkoutSessionId) {
      return this.queueBotText({
        conversation,
        text: CHECKOUT_CODE_PROMPT,
      });
    }

    const metadata = toFlowMetadata(conversation.metadata);
    if (!metadata.fulfillmentType) {
      return this.queueBotText({
        conversation,
        text: FULFILLMENT_PROMPT,
        patch: {
          state: WhatsappConversationState.AwaitingFulfillment,
          status: WhatsappConversationStatus.WaitingForCustomer,
          metadata: this.withMetadata(conversation, {
            lastCommand: 'confirm',
          }),
        },
      });
    }
    if (
      metadata.fulfillmentType === OrderFulfillmentType.Delivery &&
      !metadata.deliveryAddress
    ) {
      return this.queueBotText({
        conversation,
        text: DELIVERY_ADDRESS_PROMPT,
        patch: {
          state: WhatsappConversationState.AwaitingDeliveryAddress,
          status: WhatsappConversationStatus.WaitingForCustomer,
          metadata: this.withMetadata(conversation, {
            fulfillmentType: OrderFulfillmentType.Delivery,
            lastCommand: 'confirm',
          }),
        },
      });
    }

    let paymentUrl: string | null | undefined;
    try {
      paymentUrl =
        await this.checkoutSessionsService.prepareConversationPayment?.({
          checkoutSessionId: conversation.checkoutSessionId,
          customerPhoneNumber: conversation.customerPhoneNumber,
          dto: {
            fulfillmentType: metadata.fulfillmentType,
            orderTiming: OrderTimingType.Immediate,
            deliveryAddress: toDeliveryAddressDto(metadata.deliveryAddress),
          },
        });
    } catch (error) {
      this.logger.warn({
        message: 'WhatsApp payment preparation blocked',
        conversationId: conversation.id,
        error: getErrorMessage(error),
      });
      return this.queueBotText({
        conversation,
        text: 'We could not prepare your payment link. Your order has not been submitted. Please try CONFIRM again shortly or contact the restaurant for help.',
      });
    }
    if (paymentUrl) {
      const text =
        'Your checkout is confirmed. Please complete payment to submit your order.\n\nYour order will be submitted automatically when payment is confirmed.';
      const queued = await this.queueBotMessage({
        conversation,
        text,
        content: {
          type: 'cta_url',
          body: text,
          displayText: 'Pay now',
          url: paymentUrl,
        },
        patch: {
          state: WhatsappConversationState.AwaitingConfirmation,
          status: WhatsappConversationStatus.WaitingForCustomer,
        },
      });
      return queued.conversation;
    }

    const result = await this.confirmCheckoutSession(conversation, metadata);
    if (!result) {
      return this.queueBotText({
        conversation,
        text: 'We could not submit this checkout in WhatsApp. Please contact staff.',
        patch: {
          state: WhatsappConversationState.HandoffToStaff,
          status: WhatsappConversationStatus.WaitingForStaff,
          metadata: this.withMetadata(conversation, {
            lastCommand: 'confirm',
          }),
        },
      });
    }

    return this.handleConfirmedOrder(conversation, metadata, result);
  }

  private async handleConfirmedOrder(
    conversation: WhatsappConversationRecord,
    metadata: WhatsappCheckoutFlowMetadata,
    result: ConfirmCheckoutSessionForConversationResult,
  ): Promise<WhatsappConversationRecord> {
    const text = result.created
      ? `Your order ${result.order.publicCode} has been submitted successfully.`
      : `Your order ${result.order.publicCode} has already been submitted.`;
    return await this.queueBotText({
      conversation,
      text,
      patch: {
        orderId: result.order.id,
        state: WhatsappConversationState.OrderCreated,
        status: WhatsappConversationStatus.Resolved,
        metadata: {
          ...metadata,
          lastCommand: 'confirm',
          checkoutFlowUpdatedAt: new Date().toISOString(),
        },
      },
      auditAction: AuditAction.WhatsappConversationOrderConfirmed,
      auditMetadata: {
        checkoutSessionId: conversation.checkoutSessionId,
        orderId: result.order.id,
        publicCode: result.order.publicCode,
        created: result.created,
      },
    });
  }

  private async handleCancel(
    conversation: WhatsappConversationRecord,
  ): Promise<WhatsappConversationRecord> {
    const checkoutStates: readonly string[] = [
      WhatsappConversationState.AwaitingFulfillment,
      WhatsappConversationState.AwaitingDeliveryAddress,
      WhatsappConversationState.AwaitingConfirmation,
    ];
    if (!checkoutStates.includes(conversation.state)) {
      return this.queueBotText({
        conversation,
        text: '🛟 No order has been cancelled. If you mean a submitted order, contact the restaurant about cancellation. Reply ORDERS to view your orders.',
      });
    }
    if (conversation.checkoutSessionId)
      await this.checkoutSessionsService.cancelPendingPaymentForConversation?.(
        conversation.checkoutSessionId,
      );
    return this.queueBotText({
      conversation,
      text: CANCELLED_PROMPT,
      patch: {
        state: WhatsappConversationState.Closed,
        status: WhatsappConversationStatus.Resolved,
        metadata: this.withMetadata(conversation, {
          lastCommand: 'cancel',
        }),
      },
      auditAction: AuditAction.WhatsappConversationCancelled,
      auditMetadata: {
        checkoutSessionId: conversation.checkoutSessionId ?? null,
        orderId: conversation.orderId ?? null,
      },
    });
  }

  private async handleEditCart(
    conversation: WhatsappConversationRecord,
  ): Promise<WhatsappConversationRecord> {
    if (conversation.checkoutSessionId)
      await this.checkoutSessionsService.cancelPendingPaymentForConversation?.(
        conversation.checkoutSessionId,
      );
    return this.queueBotText({
      conversation,
      text: 'No problem. Open your Ordira menu link again, update your basket, then tap Send order request.',
      patch: {
        state: WhatsappConversationState.StorefrontHandoff,
        status: WhatsappConversationStatus.WaitingForCustomer,
        metadata: this.withMetadata(conversation, {
          lastCommand: 'edit',
        }),
      },
    });
  }

  private async handleHelp(
    conversation: WhatsappConversationRecord,
  ): Promise<WhatsappConversationRecord> {
    return this.queueBotText({
      conversation,
      text: this.getHelpText(conversation),
    });
  }

  private async handleUnknownMessage(
    conversation: WhatsappConversationRecord,
  ): Promise<WhatsappConversationRecord> {
    if (!conversation.checkoutSessionId) {
      return this.queueBotText({
        conversation,
        text: CHECKOUT_CODE_PROMPT,
      });
    }

    return this.queueBotText({
      conversation,
      text: this.getHelpText(conversation),
    });
  }

  private async confirmCheckoutSession(
    conversation: WhatsappConversationRecord,
    metadata: WhatsappCheckoutFlowMetadata,
  ): Promise<ConfirmCheckoutSessionForConversationResult | null> {
    if (!conversation.checkoutSessionId || !metadata.fulfillmentType) {
      return null;
    }

    try {
      return await this.checkoutSessionsService.confirmCheckoutSessionForConversation(
        {
          checkoutSessionId: conversation.checkoutSessionId,
          customerPhoneNumber:
            conversation.customerPhoneNumber ||
            conversation.customerPhoneNumberNormalized,
          dto: {
            fulfillmentType: metadata.fulfillmentType,
            orderTiming: OrderTimingType.Immediate,
            ...(metadata.fulfillmentType === OrderFulfillmentType.Delivery
              ? {
                  deliveryAddress: toDeliveryAddressDto(
                    metadata.deliveryAddress,
                  ),
                }
              : {}),
            customerNote: 'Confirmed via WhatsApp',
          },
          requestContext: {
            userAgent: 'ordira-whatsapp-checkout-flow',
          },
        },
      );
    } catch (error) {
      if (error instanceof AppError) {
        this.logger.warn({
          message: 'WhatsApp checkout confirmation blocked',
          conversationId: conversation.id,
          checkoutSessionId: conversation.checkoutSessionId,
          code: error.code,
          error: error.message,
        });
        return null;
      }

      throw error;
    }
  }

  private async queueBotText(
    input: QueueBotTextInput,
  ): Promise<WhatsappConversationRecord> {
    const result = await this.queueBotMessage({
      ...input,
      content: {
        type: 'text',
        text: input.text,
      },
    });

    return result.conversation;
  }

  private async queueBotMessage(input: QueueBotMessageInput): Promise<{
    conversation: WhatsappConversationRecord;
    outboundMessageId: string;
  }> {
    const now = new Date();
    const nextConversation = {
      ...input.conversation,
      ...input.patch,
    };
    const content = input.content ?? {
      type: 'text',
      text: input.text,
    };
    const messageType = getOutboundMessageType(content);
    const outboundRecord = await this.createCheckoutOutboundMessage({
      input,
      nextConversation,
      content,
      messageType,
      now,
    });
    this.logger.log({
      event: 'whatsapp_latency_outbound_message_created',
      source: 'whatsapp_checkout_flow',
      responseAction: input.responseAction ?? null,
      outboundMessageId: outboundRecord.id,
      conversationId: nextConversation.id,
      channelId: nextConversation.channelId ?? null,
      checkoutSessionId: nextConversation.checkoutSessionId ?? null,
      orderId: nextConversation.orderId ?? null,
      hasTenantScope: Boolean(nextConversation.workspaceId),
    });
    const enqueued = await this.enqueueOutboundMessage(outboundRecord.id);
    if (!enqueued && input.idempotencyKeyHash) {
      throw whatsappQueueUnavailable();
    }
    const updatedConversation = await this.updateConversation(
      input.conversation,
      {
        ...(input.patch ?? {}),
        lastMessageText: input.text,
        lastMessageAt: now,
        lastOutboundAt: now,
      },
    );
    await this.recordAuditIfNeeded(
      input,
      updatedConversation,
      outboundRecord.id,
    );
    await this.publishConversationUpdated(updatedConversation);

    return {
      conversation: updatedConversation,
      outboundMessageId: outboundRecord.id,
    };
  }

  private async createCheckoutOutboundMessage(params: {
    input: QueueBotMessageInput;
    nextConversation: WhatsappConversationRecord;
    content: WhatsappOutboundContent;
    messageType: WhatsappOutboundMessageType;
    now: Date;
  }): Promise<WhatsappOutboundMessageRecord> {
    try {
      return await this.whatsappConversationsRepository.createOutboundMessage({
        workspaceId: params.nextConversation.workspaceId,
        restaurantId: params.nextConversation.restaurantId ?? null,
        branchId: params.nextConversation.branchId ?? null,
        channelId: params.nextConversation.channelId ?? null,
        conversationId: params.nextConversation.id,
        checkoutSessionId: params.nextConversation.checkoutSessionId ?? null,
        orderId: params.nextConversation.orderId ?? null,
        toPhoneNumber: params.nextConversation.customerPhoneNumber,
        toPhoneNumberNormalized:
          params.nextConversation.customerPhoneNumberNormalized,
        messageType: params.messageType,
        text: params.input.text,
        content: params.content,
        payload: {
          automated: true,
          source: 'whatsapp_checkout_flow',
          ...(params.input.responseAction
            ? { responseAction: params.input.responseAction }
            : {}),
        },
        status: WhatsappOutboundMessageStatus.Queued,
        attemptCount: 0,
        maxAttempts: 3,
        nextAttemptAt: params.now,
        idempotencyKeyHash: params.input.idempotencyKeyHash ?? null,
      });
    } catch (error) {
      if (!params.input.idempotencyKeyHash || !isDuplicateKeyError(error)) {
        throw error;
      }

      const existingMessage =
        await this.whatsappConversationsRepository.findOutboundMessageByIdempotencyKey(
          {
            workspaceId: params.nextConversation.workspaceId ?? '',
            conversationId: params.nextConversation.id,
            idempotencyKeyHash: params.input.idempotencyKeyHash,
          },
        );
      if (!existingMessage) {
        throw error;
      }

      return existingMessage;
    }
  }

  private async enqueueOutboundMessage(
    outboundMessageId: string,
  ): Promise<boolean> {
    try {
      return (
        (await this.outboundDispatcherService?.enqueueOutboundMessage(
          outboundMessageId,
          {
            priority: WhatsappOutboundJobPriority.Transactional,
          },
        )) ?? false
      );
    } catch (error) {
      this.logger.warn({
        message: 'Could not enqueue WhatsApp checkout outbound message',
        outboundMessageId,
        error: getErrorMessage(error),
      });

      return false;
    }
  }

  private async queueTypingIndicator(
    conversation: WhatsappConversationRecord,
    input: { reason: string },
  ): Promise<void> {
    try {
      await this.outboundDispatcherService?.sendTypingIndicator({
        conversation,
        providerMessageId: conversation.lastInboundProviderMessageId ?? null,
        reason: input.reason,
      });
    } catch (error) {
      this.logger.debug({
        event: 'whatsapp_checkout_flow_typing_indicator_failed',
        conversationId: conversation.id,
        reason: input.reason,
        error: getErrorMessage(error),
      });
    }
  }

  private async updateConversation(
    conversation: WhatsappConversationRecord,
    set: WhatsappConversationUpdateSet,
  ): Promise<WhatsappConversationRecord> {
    const updatedConversation =
      await this.whatsappConversationsRepository.updateConversationForWorkspace(
        {
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId,
          set,
        },
      );
    if (!updatedConversation) {
      throw AppError.badRequest({
        code: AppResponseCode.WhatsappConversationNotFound,
      });
    }

    return updatedConversation;
  }

  private async findActiveCheckoutSessionByCode(
    checkoutSessionCode: string,
  ): Promise<CheckoutSessionRecord | null> {
    const record =
      await this.whatsappConversationsRepository.findCheckoutSessionByCode(
        checkoutSessionCode,
      );
    if (!record) {
      return null;
    }

    if (record.expiresAt.getTime() > Date.now()) {
      return record;
    }

    await this.whatsappConversationsRepository.markCheckoutSessionExpired(
      record.id,
      new Date(),
    );

    return null;
  }

  private async resolveFulfillmentSupport(
    conversation: WhatsappConversationRecord,
    fulfillmentType: OrderFulfillmentType,
  ): Promise<{
    supported: boolean;
    message: string;
    nextState: WhatsappConversationState;
  }> {
    const branch = await this.findConversationBranch(conversation);
    if (!branch) {
      return {
        supported: false,
        message:
          'This branch is no longer available. Please contact staff to continue.',
        nextState: WhatsappConversationState.HandoffToStaff,
      };
    }
    const fulfillmentAvailability =
      await this.getBranchFulfillmentAvailability(branch);
    if (
      (fulfillmentType === OrderFulfillmentType.Pickup &&
        fulfillmentAvailability.pickupAvailable) ||
      (fulfillmentType === OrderFulfillmentType.Delivery &&
        fulfillmentAvailability.deliveryAvailable)
    ) {
      return {
        supported: true,
        message: '',
        nextState: conversation.state,
      };
    }
    if (
      fulfillmentType === OrderFulfillmentType.Pickup &&
      fulfillmentAvailability.deliveryAvailable
    ) {
      return {
        supported: false,
        message:
          'Pickup is not available for this branch. Reply 2 for delivery.',
        nextState: WhatsappConversationState.AwaitingFulfillment,
      };
    }
    if (
      fulfillmentType === OrderFulfillmentType.Delivery &&
      fulfillmentAvailability.pickupAvailable
    ) {
      return {
        supported: false,
        message:
          'Delivery is not available for this branch. Reply 1 for pickup.',
        nextState: WhatsappConversationState.AwaitingFulfillment,
      };
    }

    return {
      supported: false,
      message:
        'This branch is not accepting pickup or delivery orders right now. Please contact staff.',
      nextState: WhatsappConversationState.HandoffToStaff,
    };
  }

  private assertFulfillmentAvailable(
    fulfillmentType: OrderFulfillmentType,
    fulfillmentAvailability: {
      pickupAvailable: boolean;
      deliveryAvailable: boolean;
    },
  ): void {
    if (
      fulfillmentType === OrderFulfillmentType.Pickup &&
      fulfillmentAvailability.pickupAvailable
    ) {
      return;
    }
    if (
      fulfillmentType === OrderFulfillmentType.Delivery &&
      fulfillmentAvailability.deliveryAvailable
    ) {
      return;
    }

    throw AppError.badRequest(
      `${fulfillmentType} is not available for this branch right now`,
    );
  }

  private async findCheckoutSessionBranch(
    checkoutSession: CheckoutSessionRecord,
  ): Promise<BranchRecord | null> {
    return this.branchesRepository.findActiveById(
      checkoutSession.workspaceId,
      checkoutSession.restaurantId,
      checkoutSession.branchId,
    );
  }

  private async getBranchFulfillmentAvailability(
    branch: BranchRecord,
  ): Promise<{
    pickupAvailable: boolean;
    deliveryAvailable: boolean;
  }> {
    if (!this.branchOperationsService) {
      return {
        pickupAvailable: branch.pickupEnabled,
        deliveryAvailable: branch.deliveryEnabled,
      };
    }

    const availability =
      await this.branchOperationsService.getBranchAvailability({
        branch,
      });

    return {
      pickupAvailable: availability.pickup.available,
      deliveryAvailable: availability.delivery.available,
    };
  }

  private async findConversationBranch(
    conversation: WhatsappConversationRecord,
  ): Promise<BranchRecord | null> {
    if (
      !conversation.workspaceId ||
      !conversation.restaurantId ||
      !conversation.branchId
    ) {
      return null;
    }

    return this.branchesRepository.findActiveById(
      conversation.workspaceId,
      conversation.restaurantId,
      conversation.branchId,
    );
  }

  private withMetadata(
    conversation: WhatsappConversationRecord,
    patch: Partial<WhatsappCheckoutFlowMetadata>,
  ): WhatsappCheckoutFlowMetadata {
    return {
      ...toFlowMetadata(conversation.metadata),
      ...patch,
      checkoutFlowUpdatedAt: new Date().toISOString(),
    };
  }

  private getHelpText(conversation: WhatsappConversationRecord): string {
    if (!conversation.checkoutSessionId) {
      return CHECKOUT_CODE_PROMPT;
    }
    if (conversation.state === WhatsappConversationState.AwaitingFulfillment) {
      return FULFILLMENT_PROMPT;
    }
    if (
      conversation.state === WhatsappConversationState.AwaitingDeliveryAddress
    ) {
      return DELIVERY_ADDRESS_PROMPT;
    }
    if (conversation.state === WhatsappConversationState.AwaitingConfirmation) {
      return CONFIRMATION_PROMPT;
    }
    if (conversation.state === WhatsappConversationState.OrderCreated) {
      return 'Your order has been submitted.';
    }

    return FULFILLMENT_PROMPT;
  }

  private async recordAuditIfNeeded(
    input: QueueBotTextInput,
    conversation: WhatsappConversationRecord,
    outboundMessageId: string,
  ): Promise<void> {
    if (!input.auditAction || !conversation.workspaceId) {
      return;
    }

    await this.auditService.record({
      workspaceId: conversation.workspaceId,
      actorId: null,
      actorType: AuditActorType.System,
      outcome: AuditOutcome.Success,
      source: AuditSource.System,
      action: input.auditAction,
      resource: 'whatsapp_conversation',
      resourceId: conversation.id,
      metadata: {
        restaurantId: conversation.restaurantId ?? null,
        branchId: conversation.branchId ?? null,
        checkoutSessionId: conversation.checkoutSessionId ?? null,
        checkoutSessionCode: conversation.checkoutSessionCode ?? null,
        orderId: conversation.orderId ?? null,
        outboundMessageId,
        ...(input.auditMetadata ?? {}),
      },
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
}

function parseCommand(
  text: string | null | undefined,
  interactionId?: string | null,
  state?: WhatsappConversationState,
): WhatsappCheckoutCommand {
  const action = parseWhatsappCheckoutFlowActionId(interactionId);
  if (action) {
    return checkoutActionToCommand(action);
  }

  // Share the state-aware English/Pidgin matcher with the inbound AI bypass.
  // Interactive action IDs above remain authoritative for button replies; text
  // reaches the same checkout validation without letting AI confirm the order.
  const fulfillment = readWhatsappFulfillmentChoice(text, state ?? '');
  if (fulfillment) return fulfillment;
  const normalizedText = normalizeWhatsappCheckoutText(text);
  if (normalizedText === 'pickup' || normalizedText === '1') {
    return 'pickup';
  }
  if (normalizedText === 'delivery' || normalizedText === '2') {
    return 'delivery';
  }
  if (
    (normalizedText === 'confirm' &&
      (state === WhatsappConversationState.AwaitingConfirmation ||
        state === WhatsappConversationState.OrderCreated)) ||
    (state === WhatsappConversationState.AwaitingConfirmation &&
      (normalizedText === 'yes' || normalizedText === 'y'))
  ) {
    return 'confirm';
  }
  if (normalizedText === 'cancel' || normalizedText === 'stop') {
    return 'cancel';
  }
  if (
    state === WhatsappConversationState.AwaitingConfirmation &&
    (normalizedText === 'change' || normalizedText === 'edit')
  ) {
    return 'edit';
  }
  if (['help', 'support', 'contact support'].includes(normalizedText)) {
    return 'help';
  }

  return 'unknown';
}

function checkoutActionToCommand(
  action: WhatsappCheckoutFlowActionKey,
): WhatsappCheckoutCommand {
  if (action === WhatsappCheckoutFlowActionKey.Pickup) {
    return 'pickup';
  }
  if (action === WhatsappCheckoutFlowActionKey.Delivery) {
    return 'delivery';
  }
  if (action === WhatsappCheckoutFlowActionKey.Confirm) {
    return 'confirm';
  }
  if (action === WhatsappCheckoutFlowActionKey.Cancel) {
    return 'cancel';
  }

  return 'edit';
}

function toFlowMetadata(
  metadata: Record<string, unknown>,
): WhatsappCheckoutFlowMetadata {
  const base = isRecord(metadata) ? { ...metadata } : {};
  const flowMetadata: WhatsappCheckoutFlowMetadata = { ...base };
  if (!isOrderFulfillmentType(flowMetadata.fulfillmentType)) {
    delete flowMetadata.fulfillmentType;
  }

  const deliveryAddress = toDeliveryAddress(flowMetadata.deliveryAddress);
  if (deliveryAddress) {
    flowMetadata.deliveryAddress = deliveryAddress;
  } else {
    delete flowMetadata.deliveryAddress;
  }

  return flowMetadata;
}

function toDeliveryAddress(value: unknown): OrderDeliveryAddress | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const address: OrderDeliveryAddress = {
    street: toOptionalString(value.street) ?? null,
    city: toOptionalString(value.city) ?? null,
    state: toOptionalString(value.state) ?? null,
    country: toOptionalString(value.country) ?? null,
    latitude: toOptionalNumber(value.latitude) ?? null,
    longitude: toOptionalNumber(value.longitude) ?? null,
    note: toOptionalString(value.note) ?? null,
  };

  return Object.values(address).some((entry) => Boolean(entry))
    ? address
    : undefined;
}

function toDeliveryAddressDto(
  address: OrderDeliveryAddress | undefined,
): OrderDeliveryAddressDto | undefined {
  if (!address) {
    return undefined;
  }

  return {
    street: toOptionalString(address.street),
    city: toOptionalString(address.city),
    state: toOptionalString(address.state),
    country: toOptionalString(address.country),
    latitude: toOptionalNumber(address.latitude),
    longitude: toOptionalNumber(address.longitude),
    note: toOptionalString(address.note),
  };
}

function isCheckoutSessionCompatibleWithConversation(
  conversation: WhatsappConversationRecord,
  checkoutSession: CheckoutSessionRecord,
): boolean {
  if (
    conversation.workspaceId &&
    conversation.workspaceId !== checkoutSession.workspaceId
  ) {
    return false;
  }
  if (
    conversation.restaurantId &&
    conversation.restaurantId !== checkoutSession.restaurantId
  ) {
    return false;
  }

  return !(
    conversation.branchId && conversation.branchId !== checkoutSession.branchId
  );
}

function isOrderFulfillmentType(value: unknown): value is OrderFulfillmentType {
  return (
    value === OrderFulfillmentType.Pickup ||
    value === OrderFulfillmentType.Delivery
  );
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed || undefined;
}

function formatCheckoutOrderSummary(session: CheckoutSessionRecord): string {
  const itemLines = session.items
    .slice(0, MAX_ORDER_SUMMARY_ITEM_LINES)
    .map(formatCheckoutOrderSummaryItemLine);
  const moreItems =
    session.items.length > MAX_ORDER_SUMMARY_ITEM_LINES
      ? [
          `• +${session.items.length - MAX_ORDER_SUMMARY_ITEM_LINES} more item(s)`,
        ]
      : [];

  return [
    `🧾 Order request ${session.sessionCode}`,
    ...itemLines,
    ...moreItems,
    `Total: ${formatMinorUnit(session.totalMinorUnit, session.currency)}`,
  ].join('\n');
}

function formatCheckoutOrderSummaryItemLine(
  item: CheckoutSessionRecord['items'][number],
): string {
  const baseLine = `• ${item.quantity} x ${item.name} - ${formatMinorUnit(
    item.lineTotalMinorUnit,
    item.currency,
  )}`;
  const modifierNames = item.modifierSelections
    .flatMap((selection) =>
      selection.options.map(
        (option) => `${option.optionName} x${option.quantity}`,
      ),
    )
    .slice(0, MAX_ORDER_SUMMARY_MODIFIERS_PER_ITEM);
  if (modifierNames.length === 0) {
    return baseLine;
  }

  const moreModifierCount =
    item.modifierSelections.reduce(
      (count, selection) => count + selection.options.length,
      0,
    ) - modifierNames.length;
  const modifierSummary =
    moreModifierCount > 0
      ? `${modifierNames.join(', ')} +${moreModifierCount} more`
      : modifierNames.join(', ');

  return `${baseLine} (${modifierSummary})`;
}

function getOutboundMessageType(
  content: WhatsappOutboundContent,
): WhatsappOutboundMessageType {
  if (content.type === 'text') {
    return WhatsappOutboundMessageType.Text;
  }
  if (content.type === 'image') {
    return WhatsappOutboundMessageType.Image;
  }

  return WhatsappOutboundMessageType.Interactive;
}

function getOrderRequestHeaderImageUrl(
  session: CheckoutSessionRecord,
): string | null {
  return (
    session.items.find((item) => isHttpUrl(item.imageUrl ?? null))?.imageUrl ??
    null
  );
}

function truncateInteractiveBody(body: string): string {
  if (body.length <= 1024) {
    return body;
  }

  return `${body.slice(0, 1000).trimEnd()}\n...`;
}

function toPlainWhatsappUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }

  try {
    const parsedUrl = new URL(url);
    parsedUrl.search = '';

    return parsedUrl.toString();
  } catch {
    return null;
  }
}

function hashCheckoutOrderRequest(input: {
  session: CheckoutSessionRecord;
  fulfillmentType: OrderFulfillmentType | null;
  deliveryAddress: OrderDeliveryAddressDto | null;
}): string {
  return sha256(
    stableStringify({
      kind: 'checkout-whatsapp-order-request',
      sessionId: input.session.id,
      items: input.session.items.map((item) => ({
        menuItemId: item.menuItemId,
        quantity: item.quantity,
        note: item.note ?? null,
        unitPriceMinorUnit: item.unitPriceMinorUnit,
        modifierSelections: item.modifierSelections.map((selection) => ({
          modifierGroupId: selection.modifierGroupId,
          options: selection.options.map((option) => ({
            modifierOptionId: option.modifierOptionId,
            quantity: option.quantity,
            unitPriceDeltaMinorUnit: option.unitPriceDeltaMinorUnit,
          })),
        })),
      })),
      totalMinorUnit: input.session.totalMinorUnit,
      fulfillmentType: input.fulfillmentType,
      deliveryAddress: input.deliveryAddress ?? null,
    }),
  );
}

function whatsappQueueUnavailable(): AppError {
  return new AppError({
    code: AppResponseCode.RequestFailed,
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'WhatsApp message queue is unavailable right now',
  });
}
