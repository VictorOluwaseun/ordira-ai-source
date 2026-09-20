import { AppResponseCode } from '@common/constants/response-codes.constants';
import { AppError } from '@common/errors/app.error';
import type { AuditService } from '@modules/audit/audit.service';
import { AuditAction } from '@modules/audit/audit.types';
import type { BranchesRepository } from '@modules/branches/branches.repository';
import {
  BranchStatus,
  createDefaultOpeningHours,
  type BranchRecord,
} from '@modules/branches/schemas/branch.schema';
import type { CheckoutSessionsService } from '@modules/checkout-sessions/checkout-sessions.service';
import {
  CheckoutSession,
  CheckoutSessionSource,
  CheckoutSessionStatus,
  toCheckoutSessionRecord,
  type CheckoutSessionDocument,
} from '@modules/checkout-sessions/schemas/checkout-session.schema';
import { PlatformCustomerIdentity } from '@modules/customers/schemas/platform-customer-identity.schema';
import {
  Order,
  OrderActorType,
  OrderFulfillmentType,
  OrderSourceType,
  OrderStatus,
  OrderTimingType,
  PaymentStatus,
  type OrderRecord,
} from '@modules/orders/schemas/order.schema';
import type { WorkspaceEventsService } from '@modules/workspace-events/workspace-events.service';
import { Types, type Model } from 'mongoose';
import {
  toWhatsappConversationRecord,
  WhatsappConversation,
  WhatsappConversationSource,
  WhatsappConversationState,
  WhatsappConversationStatus,
  type WhatsappConversationDocument,
  type WhatsappConversationRecord,
} from './schemas/whatsapp-conversation.schema';
import {
  WhatsappOutboundMessage,
  WhatsappOutboundMessageStatus,
  WhatsappOutboundMessageType,
  type WhatsappOutboundMessageDocument,
} from './schemas/whatsapp-outbound-message.schema';
import { WhatsappConversationsRepository } from './whatsapp-conversations.repository';
import { WhatsappCheckoutFlowActionKey } from './whatsapp-checkout-flow-action-registry';
import { WhatsappCheckoutFlowService } from './whatsapp-checkout-flow.service';
import type { WhatsappOutboundDispatcherService } from './whatsapp-outbound-dispatcher.service';
import { WhatsappOutboundJobPriority } from './whatsapp-outbound-queue.constants';
import { WhatsappInboundEvent } from './schemas/whatsapp-inbound-event.schema';

type QueryMock<TResult> = {
  sort: jest.Mock<QueryMock<TResult>, [Record<string, 1 | -1>]>;
  exec: jest.Mock<Promise<TResult>, []>;
};

type ConversationModelMock = {
  findOne: jest.Mock<
    QueryMock<WhatsappConversationDocument | null>,
    [Record<string, unknown>]
  >;
  findOneAndUpdate: jest.Mock<
    QueryMock<WhatsappConversationDocument | null>,
    [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown> | undefined,
    ]
  >;
};

type OutboundMessageModelMock = jest.Mock<
  WhatsappOutboundMessageDocument,
  [Record<string, unknown>]
> & {
  findOne: jest.Mock<
    QueryMock<WhatsappOutboundMessageDocument | null>,
    [Record<string, unknown>]
  >;
};

type CheckoutSessionModelMock = {
  findOne: jest.Mock<
    QueryMock<CheckoutSessionDocument | null>,
    [Record<string, unknown>]
  >;
  findOneAndUpdate: jest.Mock<
    QueryMock<CheckoutSessionDocument | null>,
    [Record<string, unknown>, Record<string, unknown>]
  >;
};

const WORKSPACE_ID = '507f1f77bcf86cd799439010';
const RESTAURANT_ID = '507f1f77bcf86cd799439011';
const BRANCH_ID = '507f1f77bcf86cd799439012';
const CHANNEL_ID = '507f1f77bcf86cd799439013';
const CONVERSATION_ID = '507f1f77bcf86cd799439014';
const CHECKOUT_SESSION_ID = '507f1f77bcf86cd799439015';
const OUTBOUND_MESSAGE_ID = '507f1f77bcf86cd799439016';
const ORDER_ID = '507f1f77bcf86cd799439017';
const CUSTOMER_ID = '507f1f77bcf86cd799439018';
const USER_ID = '507f1f77bcf86cd799439019';
const MENU_ITEM_ID = '507f1f77bcf86cd799439020';
const NOW = new Date('2026-06-07T09:00:00.000Z');
const SESSION_CODE = 'CHK-260607-ABC1234567';

describe('WhatsappCheckoutFlowService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('links a valid checkout code and asks for pickup or delivery', async () => {
    const {
      service,
      outboundMessageModel,
      conversationModel,
      outboundDispatcherService,
    } = createService();

    await service.processInboundTextForConversation(
      createConversationRecord({ orderId: ORDER_ID }),
      `Continue my Ordira order ${SESSION_CODE}`,
    );

    expect(outboundMessageModel).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: CHECKOUT_SESSION_ID,
        text: expect.stringContaining(
          'Would you like pickup or delivery?',
        ) as unknown,
        status: WhatsappOutboundMessageStatus.Queued,
        messageType: WhatsappOutboundMessageType.Interactive,
      }),
    );
    expect(getConversationUpdate(conversationModel)).toEqual(
      expect.objectContaining({
        checkoutSessionId: CHECKOUT_SESSION_ID,
        checkoutSessionCode: SESSION_CODE,
        orderId: null,
        source: WhatsappConversationSource.StorefrontHandoff,
        state: WhatsappConversationState.AwaitingFulfillment,
        status: WhatsappConversationStatus.WaitingForCustomer,
      }),
    );
    expect(
      outboundDispatcherService.enqueueOutboundMessage,
    ).toHaveBeenCalledWith(OUTBOUND_MESSAGE_ID, {
      priority: WhatsappOutboundJobPriority.Transactional,
    });
  });

  it('links an unscoped shared-platform conversation from a checkout code', async () => {
    const { service, conversationModel, outboundMessageModel } =
      createService();

    await service.processInboundTextForConversation(
      createConversationRecord({
        workspaceId: null,
        restaurantId: null,
        branchId: null,
      }),
      `Continue my Ordira order ${SESSION_CODE}`,
    );

    expect(outboundMessageModel).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        restaurantId: RESTAURANT_ID,
        branchId: BRANCH_ID,
        checkoutSessionId: CHECKOUT_SESSION_ID,
      }),
    );
    expect(getConversationUpdate(conversationModel)).toEqual(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        restaurantId: RESTAURANT_ID,
        branchId: BRANCH_ID,
        checkoutSessionId: CHECKOUT_SESSION_ID,
        checkoutSessionCode: SESSION_CODE,
        source: WhatsappConversationSource.StorefrontHandoff,
      }),
    );
  });

  it.each([
    [true, false, 'pickup only', WhatsappCheckoutFlowActionKey.Pickup],
    [false, true, 'delivery only', WhatsappCheckoutFlowActionKey.Delivery],
  ])(
    'asks explicitly even with a single available service (%s/%s)',
    async (pickupEnabled, deliveryEnabled, wording, action) => {
      const h = createService();
      h.branchesRepository.findActiveById.mockResolvedValueOnce(
        createBranch({ pickupEnabled, deliveryEnabled }),
      );
      await h.service.processInboundTextForConversation(
        createConversationRecord({
          metadata: {
            fulfillmentType: OrderFulfillmentType.Pickup,
            deliveryAddress: { note: 'Old address' },
          },
        }),
        `Continue ${SESSION_CODE}`,
      );
      const update = getConversationUpdate(h.conversationModel);
      expect(update.state).toBe(WhatsappConversationState.AwaitingFulfillment);
      expect(readMetadata(update).fulfillmentType).toBeUndefined();
      expect(readMetadata(update).deliveryAddress).toBeUndefined();
      expect(h.outboundMessageModel.mock.calls[0]?.[0]).toMatchObject({
        text: expect.stringContaining(wording) as unknown,
        content: {
          type: 'reply_buttons',
          buttons: [
            { id: action },
            { id: WhatsappCheckoutFlowActionKey.Cancel },
          ],
        },
      });
      expect(
        h.checkoutSessionsService.confirmCheckoutSessionForConversation,
      ).not.toHaveBeenCalled();
    },
  );

  it('asks storefront customers to choose and clears the previous order choice', async () => {
    const h = createService();
    h.conversationModel.findOne.mockReturnValue(
      createQuery(
        createConversationDocument({
          metadata: {
            fulfillmentType: OrderFulfillmentType.Pickup,
            deliveryAddress: { note: 'Old address' },
          },
        }),
      ),
    );
    await h.service.requestCheckoutOrderConfirmation('session-token', {});
    const update = getConversationUpdate(h.conversationModel);
    expect(update.state).toBe(WhatsappConversationState.AwaitingFulfillment);
    expect(readMetadata(update).fulfillmentType).toBeUndefined();
    expect(readMetadata(update).deliveryAddress).toBeUndefined();
    expect(h.outboundMessageModel.mock.calls[0]?.[0]).toMatchObject({
      content: {
        type: 'reply_buttons',
        buttons: [
          { id: WhatsappCheckoutFlowActionKey.Pickup },
          { id: WhatsappCheckoutFlowActionKey.Delivery },
          { id: WhatsappCheckoutFlowActionKey.Cancel },
        ],
      },
    });
    await h.service.processInboundTextForConversation(
      createConversationRecord({
        checkoutSessionId: CHECKOUT_SESSION_ID,
        state: WhatsappConversationState.AwaitingFulfillment,
        metadata: readMetadata(update),
      }),
      'confirm',
    );
    expect(
      h.checkoutSessionsService.prepareConversationPayment,
    ).not.toHaveBeenCalled();
    expect(
      h.checkoutSessionsService.confirmCheckoutSessionForConversation,
    ).not.toHaveBeenCalled();
  });

  it.each(['I go collect am', 'Actually pickup instead', 'No, pickup instead'])(
    'accepts an explicit pickup correction before confirmation: %s',
    async (text) => {
      const h = createService();
      await h.service.processInboundTextForConversation(
        createConversationRecord({
          checkoutSessionId: CHECKOUT_SESSION_ID,
          state: WhatsappConversationState.AwaitingConfirmation,
          metadata: {
            fulfillmentType: OrderFulfillmentType.Delivery,
            deliveryAddress: { note: 'Old address' },
          },
        }),
        text,
      );
      const updated = getConversationUpdate(h.conversationModel);
      expect(readMetadata(updated).fulfillmentType).toBe(
        OrderFulfillmentType.Pickup,
      );
      expect(readMetadata(updated).deliveryAddress).toBeUndefined();
      expect(
        h.checkoutSessionsService.confirmCheckoutSessionForConversation,
      ).not.toHaveBeenCalled();
    },
  );
  it.each([
    'Abeg deliver am',
    'Actually delivery instead',
    'No, delivery instead',
  ])(
    'asks for the address after an explicit delivery correction: %s',
    async (text) => {
      const h = createService();
      await h.service.processInboundTextForConversation(
        createConversationRecord({
          checkoutSessionId: CHECKOUT_SESSION_ID,
          state: WhatsappConversationState.AwaitingFulfillment,
          metadata: { deliveryAddress: { note: 'Old address' } },
        }),
        text,
      );
      expect(getConversationUpdate(h.conversationModel).state).toBe(
        WhatsappConversationState.AwaitingDeliveryAddress,
      );
      expect(
        readMetadata(getConversationUpdate(h.conversationModel))
          .deliveryAddress,
      ).toBeUndefined();
      expect(
        h.checkoutSessionsService.confirmCheckoutSessionForConversation,
      ).not.toHaveBeenCalled();
    },
  );
  it('chooses pickup, clears delivery address, and waits for confirmation', async () => {
    const { service, outboundMessageModel, conversationModel } =
      createService();

    await service.processInboundTextForConversation(
      createConversationRecord({
        checkoutSessionId: CHECKOUT_SESSION_ID,
        checkoutSessionCode: SESSION_CODE,
        state: WhatsappConversationState.AwaitingFulfillment,
        metadata: {
          deliveryAddress: {
            note: 'Old address',
          },
        },
      }),
      '  PICKUP  ',
    );

    const update = getConversationUpdate(conversationModel);
    const metadata = readMetadata(update);
    expect(update.state).toBe(WhatsappConversationState.AwaitingConfirmation);
    expect(metadata.fulfillmentType).toBe(OrderFulfillmentType.Pickup);
    expect(metadata.deliveryAddress).toBeUndefined();
    expect(outboundMessageModel).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Reply CONFIRM to place your pickup order or CANCEL to stop.',
      }),
    );
  });

  it('chooses delivery, captures address, and waits for confirmation', async () => {
    const { service, conversationModel, outboundMessageModel } =
      createService();
    const conversation = createConversationRecord({
      checkoutSessionId: CHECKOUT_SESSION_ID,
      checkoutSessionCode: SESSION_CODE,
      state: WhatsappConversationState.AwaitingFulfillment,
    });

    await service.processInboundTextForConversation(conversation, '2');
    expect(getConversationUpdate(conversationModel).state).toBe(
      WhatsappConversationState.AwaitingDeliveryAddress,
    );

    await service.processInboundTextForConversation(
      createConversationRecord({
        checkoutSessionId: CHECKOUT_SESSION_ID,
        checkoutSessionCode: SESSION_CODE,
        state: WhatsappConversationState.AwaitingDeliveryAddress,
        metadata: {
          fulfillmentType: OrderFulfillmentType.Delivery,
        },
      }),
      '12 Admiralty Way, Lekki',
    );

    const metadata = readMetadata(getConversationUpdate(conversationModel));
    expect(metadata.fulfillmentType).toBe(OrderFulfillmentType.Delivery);
    expect(metadata.deliveryAddress).toEqual(
      expect.objectContaining({
        note: '12 Admiralty Way, Lekki',
      }),
    );
    expect(outboundMessageModel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: 'Delivery address saved. Reply CONFIRM to place your order or CANCEL to stop.',
      }),
    );
  });

  it('queues a Pay now URL button and keeps the checkout pending until payment', async () => {
    const h = createService();
    const paymentUrl =
      'https://api.example.test/api/v1/public/payment-requests/test-token';
    h.checkoutSessionsService.prepareConversationPayment.mockResolvedValueOnce(
      paymentUrl,
    );
    await h.service.processInboundTextForConversation(
      createConversationRecord({
        checkoutSessionId: CHECKOUT_SESSION_ID,
        checkoutSessionCode: SESSION_CODE,
        state: WhatsappConversationState.AwaitingConfirmation,
        metadata: { fulfillmentType: OrderFulfillmentType.Pickup },
      }),
      'CONFIRM',
    );
    const message = h.outboundMessageModel.mock.calls.at(-1)?.[0];
    expect(message?.messageType).toBe(WhatsappOutboundMessageType.Interactive);
    expect(message?.text).not.toContain('https://');
    expect(message?.text).toContain(
      'submitted automatically when payment is confirmed',
    );
    expect(message?.content).toEqual({
      type: 'cta_url',
      body: message?.text,
      displayText: 'Pay now',
      url: paymentUrl,
    });
    expect(
      h.checkoutSessionsService.confirmCheckoutSessionForConversation,
    ).not.toHaveBeenCalled();
    expect(getConversationUpdate(h.conversationModel)).toMatchObject({
      state: WhatsappConversationState.AwaitingConfirmation,
      status: WhatsappConversationStatus.WaitingForCustomer,
    });
  });

  it('confirms a pickup checkout session through the checkout conversion service', async () => {
    const {
      service,
      checkoutSessionsService,
      conversationModel,
      outboundMessageModel,
      auditService,
      workspaceEventsService,
    } = createService();

    await service.processInboundTextForConversation(
      createConversationRecord({
        checkoutSessionId: CHECKOUT_SESSION_ID,
        checkoutSessionCode: SESSION_CODE,
        state: WhatsappConversationState.AwaitingConfirmation,
        metadata: {
          fulfillmentType: OrderFulfillmentType.Pickup,
        },
      }),
      'yes',
    );

    const confirmInput =
      checkoutSessionsService.confirmCheckoutSessionForConversation.mock
        .calls[0]?.[0];
    expect(confirmInput?.checkoutSessionId).toBe(CHECKOUT_SESSION_ID);
    expect(confirmInput?.customerPhoneNumber).toBe('+234 800 000 0000');
    expect(confirmInput?.dto.fulfillmentType).toBe(OrderFulfillmentType.Pickup);
    expect(confirmInput?.dto.customerNote).toBe('Confirmed via WhatsApp');
    expect(getConversationUpdate(conversationModel)).toEqual(
      expect.objectContaining({
        orderId: ORDER_ID,
        state: WhatsappConversationState.OrderCreated,
        status: WhatsappConversationStatus.Resolved,
      }),
    );
    expect(outboundMessageModel).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: ORDER_ID,
        text: 'Your order ORD-260607-ABC1234567 has been submitted successfully.',
      }),
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.WhatsappConversationOrderConfirmed,
      }),
    );
    expect(
      workspaceEventsService.publishWhatsappConversationUpdated,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: ORDER_ID,
        state: WhatsappConversationState.OrderCreated,
      }),
    );
  });

  it.each([
    [null, WhatsappCheckoutFlowActionKey.Confirm],
    ['Confirm', undefined],
    ['Please confirm', undefined],
    ['✅  CONFIRM ', undefined],
  ])(
    'confirms from button or matching label %s',
    async (text, interactionId) => {
      const { service, checkoutSessionsService } = createService();

      await service.processInboundTextForConversation(
        createConversationRecord({
          checkoutSessionId: CHECKOUT_SESSION_ID,
          checkoutSessionCode: SESSION_CODE,
          state: WhatsappConversationState.AwaitingConfirmation,
          metadata: {
            fulfillmentType: OrderFulfillmentType.Pickup,
          },
        }),
        text,
        interactionId,
      );

      const confirmInput =
        checkoutSessionsService.confirmCheckoutSessionForConversation.mock
          .calls[0]?.[0];
      expect(confirmInput?.checkoutSessionId).toBe(CHECKOUT_SESSION_ID);
      expect(confirmInput?.dto.fulfillmentType).toBe(
        OrderFulfillmentType.Pickup,
      );
    },
  );

  it.each(['Change', '✏️ CHANGE', 'edit'])(
    'accepts %s only at the confirmation step',
    async (text) => {
      const { service, conversationModel, checkoutSessionsService } =
        createService();
      await service.processInboundTextForConversation(
        createConversationRecord({
          checkoutSessionId: CHECKOUT_SESSION_ID,
          state: WhatsappConversationState.AwaitingConfirmation,
        }),
        text,
      );
      expect(getConversationUpdate(conversationModel).state).toBe(
        WhatsappConversationState.StorefrontHandoff,
      );
      expect(
        checkoutSessionsService.confirmCheckoutSessionForConversation,
      ).not.toHaveBeenCalled();
    },
  );

  it('preserves an address containing action words', async () => {
    const { service, conversationModel } = createService();
    const text = '12 Change Street, near me restaurant, Lekki';
    await service.processInboundTextForConversation(
      createConversationRecord({
        checkoutSessionId: CHECKOUT_SESSION_ID,
        state: WhatsappConversationState.AwaitingDeliveryAddress,
        metadata: { fulfillmentType: OrderFulfillmentType.Delivery },
      }),
      text,
    );
    expect(
      readMetadata(getConversationUpdate(conversationModel)).deliveryAddress,
    ).toMatchObject({ note: text });
  });

  it('queues a storefront WhatsApp order request with confirm buttons', async () => {
    const {
      service,
      checkoutSessionsService,
      outboundMessageModel,
      conversationModel,
      outboundDispatcherService,
    } = createService();

    const result = await service.requestCheckoutOrderConfirmation(
      'session-token',
      {
        fulfillmentType: OrderFulfillmentType.Pickup,
      },
    );

    expect(
      checkoutSessionsService.prepareWhatsappOrderRequest,
    ).toHaveBeenCalledWith('session-token', {
      fulfillmentType: OrderFulfillmentType.Pickup,
    });
    expect(result).toEqual(
      expect.objectContaining({
        queued: true,
        checkoutSessionId: CHECKOUT_SESSION_ID,
        sessionCode: SESSION_CODE,
        conversationId: CONVERSATION_ID,
        outboundMessageId: OUTBOUND_MESSAGE_ID,
        whatsappUrl: 'https://wa.me/15556329852',
      }),
    );
    expect(outboundMessageModel).toHaveBeenCalledTimes(1);
    const outboundInput = outboundMessageModel.mock.calls[0]?.[0];
    expect(outboundInput).toEqual(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        restaurantId: RESTAURANT_ID,
        branchId: BRANCH_ID,
        checkoutSessionId: CHECKOUT_SESSION_ID,
        messageType: WhatsappOutboundMessageType.Interactive,
      }),
    );
    expect(readString(outboundInput?.text)).toContain(
      `Order request ${SESSION_CODE}`,
    );
    expect(readString(outboundInput?.idempotencyKeyHash)).toHaveLength(64);

    const content = outboundInput?.content;
    expect(isRecord(content) ? content.type : null).toBe('reply_buttons');
    expect(isRecord(content) ? readString(content.headerImageUrl) : '').toBe(
      'https://cdn.ordira.test/items/jollof-rice.jpg',
    );
    expect(isRecord(content) ? readString(content.body) : '').toContain(
      'Ready to submit this pickup order?',
    );
    const buttons =
      isRecord(content) && Array.isArray(content.buttons)
        ? content.buttons.filter(isRecord)
        : [];
    expect(buttons).toEqual([
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
    ]);
    expect(
      outboundDispatcherService.enqueueOutboundMessage,
    ).toHaveBeenCalledTimes(1);
    expect(
      outboundDispatcherService.enqueueOutboundMessage,
    ).toHaveBeenCalledWith(OUTBOUND_MESSAGE_ID, {
      priority: WhatsappOutboundJobPriority.Transactional,
    });
    expect(getConversationUpdate(conversationModel)).toEqual(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        restaurantId: RESTAURANT_ID,
        branchId: BRANCH_ID,
        checkoutSessionId: CHECKOUT_SESSION_ID,
        state: WhatsappConversationState.AwaitingConfirmation,
        status: WhatsappConversationStatus.WaitingForCustomer,
      }),
    );
  });

  it('summarizes long WhatsApp order requests in one image-header card', async () => {
    const {
      service,
      checkoutSessionsService,
      outboundMessageModel,
      outboundDispatcherService,
    } = createService();
    checkoutSessionsService.prepareWhatsappOrderRequest.mockResolvedValueOnce(
      createPreparedCheckoutSessionRecord({
        items: [
          createPreparedCheckoutSessionItem({
            name: 'Jollof Rice',
            slug: 'jollof-rice',
            imageUrl: 'https://cdn.ordira.test/items/jollof-rice.jpg',
          }),
          createPreparedCheckoutSessionItem({
            name: 'Fried Rice',
            slug: 'fried-rice',
            imageUrl: 'https://cdn.ordira.test/items/fried-rice.jpg',
          }),
          createPreparedCheckoutSessionItem({
            name: 'Chicken',
            slug: 'chicken',
            imageUrl: 'https://cdn.ordira.test/items/chicken.jpg',
          }),
          createPreparedCheckoutSessionItem({
            name: 'Plantain',
            slug: 'plantain',
            imageUrl: 'https://cdn.ordira.test/items/plantain.jpg',
          }),
          createPreparedCheckoutSessionItem({
            name: 'Moi Moi',
            slug: 'moi-moi',
            imageUrl: 'https://cdn.ordira.test/items/moi-moi.jpg',
          }),
          createPreparedCheckoutSessionItem({
            name: 'Puff Puff',
            slug: 'puff-puff',
            imageUrl: 'https://cdn.ordira.test/items/puff-puff.jpg',
          }),
        ],
      }),
    );

    await service.requestCheckoutOrderConfirmation('session-token', {
      fulfillmentType: OrderFulfillmentType.Pickup,
    });

    expect(outboundMessageModel).toHaveBeenCalledTimes(1);
    const promptMessage = outboundMessageModel.mock.calls[0]?.[0];
    expect(promptMessage).toEqual(
      expect.objectContaining({
        messageType: WhatsappOutboundMessageType.Interactive,
      }),
    );
    const content = promptMessage?.content;
    expect(isRecord(content) ? readString(content.headerImageUrl) : '').toBe(
      'https://cdn.ordira.test/items/jollof-rice.jpg',
    );
    const body = isRecord(content) ? readString(content.body) : '';
    expect(body).toContain('Jollof Rice');
    expect(body).toContain('Moi Moi');
    expect(body).toContain('+1 more item(s)');
    expect(body).not.toContain('Puff Puff');
    expect(
      outboundDispatcherService.sendTypingIndicator,
    ).not.toHaveBeenCalled();
  });

  it('confirms a delivery checkout session with the stored address', async () => {
    const { service, checkoutSessionsService } = createService();

    await service.processInboundTextForConversation(
      createConversationRecord({
        checkoutSessionId: CHECKOUT_SESSION_ID,
        checkoutSessionCode: SESSION_CODE,
        state: WhatsappConversationState.AwaitingConfirmation,
        metadata: {
          fulfillmentType: OrderFulfillmentType.Delivery,
          deliveryAddress: {
            note: '12 Admiralty Way, Lekki',
          },
        },
      }),
      'confirm',
    );

    const confirmInput =
      checkoutSessionsService.confirmCheckoutSessionForConversation.mock
        .calls[0]?.[0];
    expect(confirmInput?.dto.fulfillmentType).toBe(
      OrderFulfillmentType.Delivery,
    );
    expect(confirmInput?.dto.deliveryAddress).toEqual({
      street: undefined,
      city: undefined,
      state: undefined,
      country: undefined,
      note: '12 Admiralty Way, Lekki',
    });
  });

  it('confirms a new checkout even when a reused conversation still references an older order', async () => {
    const { service, checkoutSessionsService } = createService();
    const result = await service.processInboundTextForConversation(
      createConversationRecord({
        checkoutSessionId: CHECKOUT_SESSION_ID,
        orderId: '507f1f77bcf86cd799439099',
        state: WhatsappConversationState.AwaitingConfirmation,
        metadata: { fulfillmentType: OrderFulfillmentType.Pickup },
      }),
      'confirm',
    );
    expect(
      checkoutSessionsService.confirmCheckoutSessionForConversation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ checkoutSessionId: CHECKOUT_SESSION_ID }),
    );
    expect(result.orderId).toBe(ORDER_ID);
    expect(result.state).toBe(WhatsappConversationState.OrderCreated);
  });

  it('uses the linked session result for repeat confirmations without duplicating the order', async () => {
    const { service, checkoutSessionsService, outboundMessageModel } =
      createService();
    checkoutSessionsService.confirmCheckoutSessionForConversation.mockResolvedValue(
      {
        order: createOrder(),
        created: false,
      },
    );
    await service.processInboundTextForConversation(
      createConversationRecord({
        checkoutSessionId: CHECKOUT_SESSION_ID,
        orderId: ORDER_ID,
        state: WhatsappConversationState.OrderCreated,
        metadata: { fulfillmentType: OrderFulfillmentType.Pickup },
      }),
      'confirm',
    );
    expect(
      checkoutSessionsService.confirmCheckoutSessionForConversation,
    ).toHaveBeenCalledTimes(1);
    expect(outboundMessageModel).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Your order ORD-260607-ABC1234567 has already been submitted.',
      }),
    );
  });

  it('clears the old order link when requesting confirmation for a fresh basket', async () => {
    const { service, conversationModel } = createService();
    conversationModel.findOne.mockReturnValue(
      createQuery(
        createConversationDocument({
          checkoutSessionId: CHECKOUT_SESSION_ID,
          orderId: ORDER_ID,
        }),
      ),
    );
    await service.requestCheckoutOrderConfirmation('session-token', {
      fulfillmentType: OrderFulfillmentType.Pickup,
      items: [{ menuItemId: MENU_ITEM_ID, quantity: 1 }],
    });
    expect(getConversationUpdate(conversationModel)).toEqual(
      expect.objectContaining({
        checkoutSessionId: CHECKOUT_SESSION_ID,
        orderId: null,
      }),
    );
  });

  it.each(['yes', 'y', 'yes please'])(
    'does not confirm checkout from %s outside the confirmation step',
    async (text) => {
      const { service, checkoutSessionsService } = createService();
      await service.processInboundTextForConversation(
        createConversationRecord({
          checkoutSessionId: CHECKOUT_SESSION_ID,
          state: WhatsappConversationState.OrderCreated,
          orderId: ORDER_ID,
        }),
        text,
      );
      expect(
        checkoutSessionsService.confirmCheckoutSessionForConversation,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    'confrim',
    'cancle',
    'please do not confirm',
    'could you not cancel please',
  ])(
    'does not turn uncertain wording %s into a checkout mutation',
    async (text) => {
      const { service, checkoutSessionsService, conversationModel } =
        createService();
      await service.processInboundTextForConversation(
        createConversationRecord({
          checkoutSessionId: CHECKOUT_SESSION_ID,
          state: WhatsappConversationState.AwaitingConfirmation,
          metadata: { fulfillmentType: OrderFulfillmentType.Pickup },
        }),
        text,
      );
      expect(
        checkoutSessionsService.confirmCheckoutSessionForConversation,
      ).not.toHaveBeenCalled();
      expect(getConversationUpdate(conversationModel).state).not.toBe(
        WhatsappConversationState.Closed,
      );
    },
  );

  it('ignores a stale cancel button after order submission', async () => {
    const { service, conversationModel, outboundMessageModel } =
      createService();
    await service.processInboundTextForConversation(
      createConversationRecord({
        checkoutSessionId: CHECKOUT_SESSION_ID,
        state: WhatsappConversationState.OrderCreated,
        orderId: ORDER_ID,
      }),
      null,
      WhatsappCheckoutFlowActionKey.Cancel,
    );
    expect(outboundMessageModel).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('No order has been cancelled') as unknown,
      }),
    );
    expect(getConversationUpdate(conversationModel).state).not.toBe(
      WhatsappConversationState.Closed,
    );
  });

  it('closes the conversation on cancel without confirming checkout', async () => {
    const { service, checkoutSessionsService, conversationModel } =
      createService();

    await service.processInboundTextForConversation(
      createConversationRecord({
        checkoutSessionId: CHECKOUT_SESSION_ID,
        state: WhatsappConversationState.AwaitingConfirmation,
      }),
      'stop',
    );

    expect(
      checkoutSessionsService.confirmCheckoutSessionForConversation,
    ).not.toHaveBeenCalled();
    expect(getConversationUpdate(conversationModel)).toEqual(
      expect.objectContaining({
        state: WhatsappConversationState.Closed,
        status: WhatsappConversationStatus.Resolved,
      }),
    );
  });

  it('handles unknown text without a linked checkout session safely', async () => {
    const { service, checkoutSessionsService, outboundMessageModel } =
      createService();

    await service.processInboundTextForConversation(
      createConversationRecord(),
      'hello there',
    );

    expect(
      checkoutSessionsService.confirmCheckoutSessionForConversation,
    ).not.toHaveBeenCalled();
    expect(outboundMessageModel).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Please open your Ordira checkout link or send your checkout code to continue.',
      }),
    );
  });

  it('marks expired checkout codes expired and does not link the conversation', async () => {
    const { service, checkoutSessionModel, conversationModel } =
      createService();
    checkoutSessionModel.findOne.mockReturnValueOnce(
      createQuery(
        createCheckoutSessionDocument({
          expiresAt: new Date('2026-06-07T08:59:59.000Z'),
        }),
      ),
    );

    await service.processInboundTextForConversation(
      createConversationRecord(),
      `Continue ${SESSION_CODE}`,
    );

    expect(checkoutSessionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: CHECKOUT_SESSION_ID },
      {
        $set: {
          status: CheckoutSessionStatus.Expired,
          lastTouchedAt: NOW,
        },
      },
    );
    expect(getConversationUpdate(conversationModel).checkoutSessionId).toBe(
      undefined,
    );
  });

  it('hands off to staff when checkout conversion rejects the session', async () => {
    const { service, checkoutSessionsService, conversationModel } =
      createService();
    checkoutSessionsService.confirmCheckoutSessionForConversation.mockRejectedValueOnce(
      AppError.badRequest({
        code: AppResponseCode.BranchMenuItemUnavailable,
      }),
    );

    await service.processInboundTextForConversation(
      createConversationRecord({
        checkoutSessionId: CHECKOUT_SESSION_ID,
        checkoutSessionCode: SESSION_CODE,
        state: WhatsappConversationState.AwaitingConfirmation,
        metadata: {
          fulfillmentType: OrderFulfillmentType.Pickup,
        },
      }),
      'confirm',
    );

    expect(getConversationUpdate(conversationModel)).toEqual(
      expect.objectContaining({
        state: WhatsappConversationState.HandoffToStaff,
        status: WhatsappConversationStatus.WaitingForStaff,
      }),
    );
  });
});

function createService(): {
  service: WhatsappCheckoutFlowService;
  conversationModel: ConversationModelMock;
  outboundMessageModel: OutboundMessageModelMock;
  checkoutSessionModel: CheckoutSessionModelMock;
  branchesRepository: jest.Mocked<Pick<BranchesRepository, 'findActiveById'>>;
  checkoutSessionsService: jest.Mocked<
    Pick<
      CheckoutSessionsService,
      | 'prepareConversationPayment'
      | 'confirmCheckoutSessionForConversation'
      | 'prepareWhatsappOrderRequest'
      | 'getWhatsappHandoff'
    >
  >;
  auditService: jest.Mocked<Pick<AuditService, 'record'>>;
  outboundDispatcherService: jest.Mocked<
    Pick<
      WhatsappOutboundDispatcherService,
      'enqueueOutboundMessage' | 'sendTypingIndicator'
    >
  >;
  workspaceEventsService: jest.Mocked<
    Pick<WorkspaceEventsService, 'publishWhatsappConversationUpdated'>
  >;
} {
  const conversationModel = {
    findOne: jest.fn(() => createQuery(createConversationDocument())),
    findOneAndUpdate: jest.fn((_filter, update) =>
      createQuery(
        createConversationDocument({
          ...getUpdateSet(update),
        }),
      ),
    ),
  } satisfies ConversationModelMock;
  const outboundMessageModel = Object.assign(
    jest.fn((input: Record<string, unknown>) =>
      createOutboundMessageDocument(input),
    ),
    {
      findOne: jest.fn(() => createQuery(null)),
    },
  ) as OutboundMessageModelMock;
  const checkoutSessionModel = {
    findOne: jest.fn(() => createQuery(createCheckoutSessionDocument())),
    findOneAndUpdate: jest.fn((_filter, update) =>
      createQuery(
        createCheckoutSessionDocument({
          ...getUpdateSet(update),
        }),
      ),
    ),
  } satisfies CheckoutSessionModelMock;
  const branchesRepository = {
    findActiveById: jest.fn().mockResolvedValue(createBranch()),
  } satisfies jest.Mocked<Pick<BranchesRepository, 'findActiveById'>>;
  const checkoutSessionsService = {
    prepareConversationPayment: jest.fn().mockResolvedValue(null),
    confirmCheckoutSessionForConversation: jest.fn().mockResolvedValue({
      order: createOrder(),
      created: true,
    }),
    prepareWhatsappOrderRequest: jest
      .fn()
      .mockResolvedValue(createPreparedCheckoutSessionRecord()),
    getWhatsappHandoff: jest.fn().mockResolvedValue({
      available: true,
      phoneNumber: '+1 555 632 9852',
      displayName: 'Ordira WhatsApp',
      message: 'Continue my Ordira order',
      url: 'https://wa.me/15556329852?text=Continue%20my%20Ordira%20order',
    }),
  } satisfies jest.Mocked<
    Pick<
      CheckoutSessionsService,
      | 'prepareConversationPayment'
      | 'confirmCheckoutSessionForConversation'
      | 'prepareWhatsappOrderRequest'
      | 'getWhatsappHandoff'
    >
  >;
  const auditService = {
    record: jest.fn().mockResolvedValue(undefined),
  } satisfies jest.Mocked<Pick<AuditService, 'record'>>;
  const outboundDispatcherService = {
    enqueueOutboundMessage: jest.fn().mockResolvedValue(true),
    sendTypingIndicator: jest.fn().mockResolvedValue(true),
  } satisfies jest.Mocked<
    Pick<
      WhatsappOutboundDispatcherService,
      'enqueueOutboundMessage' | 'sendTypingIndicator'
    >
  >;
  const workspaceEventsService = {
    publishWhatsappConversationUpdated: jest.fn().mockResolvedValue(undefined),
  } satisfies jest.Mocked<
    Pick<WorkspaceEventsService, 'publishWhatsappConversationUpdated'>
  >;
  const whatsappConversationsRepository = new WhatsappConversationsRepository(
    {} as unknown as Model<WhatsappInboundEvent>,
    conversationModel as unknown as Model<WhatsappConversation>,
    outboundMessageModel as unknown as Model<WhatsappOutboundMessage>,
    {} as unknown as Model<PlatformCustomerIdentity>,
    checkoutSessionModel as unknown as Model<CheckoutSession>,
    {} as unknown as Model<Order>,
  );
  const service = new WhatsappCheckoutFlowService(
    whatsappConversationsRepository,
    branchesRepository as unknown as BranchesRepository,
    checkoutSessionsService as unknown as CheckoutSessionsService,
    auditService as unknown as AuditService,
    outboundDispatcherService as unknown as WhatsappOutboundDispatcherService,
    workspaceEventsService as unknown as WorkspaceEventsService,
  );

  return {
    service,
    conversationModel,
    outboundMessageModel,
    checkoutSessionModel,
    branchesRepository,
    checkoutSessionsService,
    auditService,
    outboundDispatcherService,
    workspaceEventsService,
  };
}

function createQuery<TResult>(result: TResult): QueryMock<TResult> {
  return {
    sort: jest.fn(() => createQuery(result)),
    exec: jest.fn<Promise<TResult>, []>().mockResolvedValue(result),
  };
}

function createConversationRecord(
  input: Partial<WhatsappConversationDocument> = {},
): WhatsappConversationRecord {
  return toWhatsappConversationRecord(createConversationDocument(input));
}

function createConversationDocument(
  input: Partial<WhatsappConversationDocument> = {},
): WhatsappConversationDocument {
  return {
    _id: new Types.ObjectId(CONVERSATION_ID),
    workspaceId: WORKSPACE_ID,
    restaurantId: RESTAURANT_ID,
    branchId: BRANCH_ID,
    channelId: CHANNEL_ID,
    customerPhoneNumber: '+234 800 000 0000',
    customerPhoneNumberNormalized: '2348000000000',
    customerName: 'Ada Customer',
    status: WhatsappConversationStatus.WaitingForStaff,
    source: WhatsappConversationSource.Whatsapp,
    checkoutSessionId: null,
    checkoutSessionCode: null,
    orderId: null,
    lastMessageText: 'Hello',
    lastMessageAt: NOW,
    lastInboundAt: NOW,
    lastInboundProviderMessageId: 'wamid_last_inbound',
    lastOutboundAt: null,
    state: WhatsappConversationState.New,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
  } as unknown as WhatsappConversationDocument;
}

function createOutboundMessageDocument(
  input: Record<string, unknown> = {},
): WhatsappOutboundMessageDocument {
  return {
    _id: new Types.ObjectId(OUTBOUND_MESSAGE_ID),
    workspaceId: WORKSPACE_ID,
    restaurantId: RESTAURANT_ID,
    branchId: BRANCH_ID,
    channelId: CHANNEL_ID,
    conversationId: CONVERSATION_ID,
    checkoutSessionId: null,
    orderId: null,
    toPhoneNumber: '+234 800 000 0000',
    toPhoneNumberNormalized: '2348000000000',
    messageType: WhatsappOutboundMessageType.Text,
    text: null,
    payload: {},
    status: WhatsappOutboundMessageStatus.Queued,
    attemptCount: 0,
    maxAttempts: 3,
    nextAttemptAt: NOW,
    sentAt: null,
    failedAt: null,
    failureReason: null,
    idempotencyKeyHash: null,
    providerMessageId: null,
    createdByUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    save: jest.fn().mockResolvedValue(undefined),
    ...input,
  } as unknown as WhatsappOutboundMessageDocument;
}

function createCheckoutSessionDocument(
  input: Record<string, unknown> = {},
): CheckoutSessionDocument {
  return {
    _id: new Types.ObjectId(CHECKOUT_SESSION_ID),
    workspaceId: WORKSPACE_ID,
    restaurantId: RESTAURANT_ID,
    branchId: BRANCH_ID,
    sessionTokenHash: 'token_hash',
    sessionCode: SESSION_CODE,
    status: CheckoutSessionStatus.ReadyForWhatsapp,
    source: CheckoutSessionSource.Storefront,
    customer: {},
    items: [],
    subtotalMinorUnit: 3500,
    serviceChargeMinorUnit: 0,
    taxMinorUnit: 0,
    deliveryFeeMinorUnit: 0,
    discountMinorUnit: 0,
    totalMinorUnit: 3500,
    currency: 'NGN',
    customerNote: null,
    expiresAt: new Date('2026-06-07T10:00:00.000Z'),
    lastTouchedAt: NOW,
    convertedOrderId: null,
    confirmedAt: null,
    convertedAt: null,
    whatsappConnectionId: null,
    whatsappOpenedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    save: jest.fn().mockResolvedValue(undefined),
    ...input,
  } as unknown as CheckoutSessionDocument;
}

function createPreparedCheckoutSessionRecord(
  input: { items?: CheckoutSessionDocument['items'] } = {},
) {
  const items = input.items ?? [createPreparedCheckoutSessionItem()];

  return toCheckoutSessionRecord(
    createCheckoutSessionDocument({
      items,
      subtotalMinorUnit: 700000,
      totalMinorUnit: 700000,
      currency: 'NGN',
    }),
  );
}

function createPreparedCheckoutSessionItem(
  input: Partial<CheckoutSessionDocument['items'][number]> = {},
): CheckoutSessionDocument['items'][number] {
  return {
    menuItemId: MENU_ITEM_ID,
    categoryId: null,
    name: 'Jollof Rice',
    slug: 'jollof-rice',
    imageUrl: 'https://cdn.ordira.test/items/jollof-rice.jpg',
    quantity: 2,
    baseUnitPriceMinorUnit: 300000,
    modifierUnitTotalMinorUnit: 50000,
    unitPriceMinorUnit: 350000,
    lineTotalMinorUnit: 700000,
    currency: 'NGN',
    unitLabel: null,
    servingSizeLabel: null,
    minOrderQuantity: 1,
    quantityStep: 1,
    note: null,
    modifierSelections: [
      {
        modifierGroupId: '507f1f77bcf86cd799439030',
        groupName: 'Drinks',
        selectionMode: 'multiple',
        options: [
          {
            modifierOptionId: '507f1f77bcf86cd799439031',
            optionName: 'Water',
            quantity: 1,
            unitPriceDeltaMinorUnit: 50000,
            totalPriceDeltaMinorUnit: 50000,
          },
        ],
      },
    ],
    ...input,
  };
}

function createBranch(input: Partial<BranchRecord> = {}): BranchRecord {
  return {
    id: BRANCH_ID,
    workspaceId: WORKSPACE_ID,
    restaurantId: RESTAURANT_ID,
    name: 'Lekki Branch',
    slug: 'lekki-branch',
    publicEnabled: true,
    seoTitle: null,
    seoDescription: null,
    coverImageUrl: null,
    searchKeywords: [],
    phoneNumber: null,
    email: null,
    address: {},
    location: null,
    openingHours: createDefaultOpeningHours(),
    pickupEnabled: true,
    deliveryEnabled: true,
    status: BranchStatus.Active,
    settings: {},
    createdByUserId: USER_ID,
    disabledAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
  };
}

function createOrder(input: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: ORDER_ID,
    workspaceId: WORKSPACE_ID,
    restaurantId: RESTAURANT_ID,
    branchId: BRANCH_ID,
    customerId: CUSTOMER_ID,
    publicCode: 'ORD-260607-ABC1234567',
    idempotencyKey: null,
    idempotencyKeyHash: null,
    idempotencyRequestHash: null,
    status: OrderStatus.Submitted,
    paymentStatus: PaymentStatus.Unpaid,
    fulfillmentType: OrderFulfillmentType.Pickup,
    orderTiming: OrderTimingType.Immediate,
    requestedFulfillmentAt: null,
    source: OrderSourceType.Whatsapp,
    branchSnapshot: {
      name: 'Lekki Branch',
      slug: 'lekki-branch',
    },
    customerSnapshot: {
      firstName: 'Ada',
      lastName: 'Customer',
      fullName: 'Ada Customer',
      phoneNumber: '+2348000000000',
      email: null,
    },
    deliveryAddress: null,
    items: [
      {
        menuItemId: MENU_ITEM_ID,
        categoryId: null,
        name: 'Jollof Rice',
        slug: 'jollof-rice',
        quantity: 1,
        unitPriceMinorUnit: 3500,
        lineTotalMinorUnit: 3500,
        currency: 'NGN',
        note: null,
      },
    ],
    subtotalMinorUnit: 3500,
    serviceChargeMinorUnit: 0,
    taxMinorUnit: 0,
    deliveryFeeMinorUnit: 0,
    discountMinorUnit: 0,
    totalMinorUnit: 3500,
    currency: 'NGN',
    totals: {
      subtotalMinorUnit: 3500,
      serviceChargeMinorUnit: 0,
      taxMinorUnit: 0,
      deliveryFeeMinorUnit: 0,
      discountMinorUnit: 0,
      totalMinorUnit: 3500,
      currency: 'NGN',
    },
    customerNote: null,
    timeline: [
      {
        status: OrderStatus.Submitted,
        actorType: OrderActorType.Customer,
        actorUserId: null,
        note: null,
        createdAt: NOW,
      },
    ],
    submittedAt: NOW,
    statusUpdatedAt: null,
    statusUpdatedByUserId: null,
    cancelledAt: null,
    cancelledByUserId: null,
    cancelReason: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
  };
}

function getConversationUpdate(
  model: ConversationModelMock,
): Record<string, unknown> {
  return getUpdateSet(model.findOneAndUpdate.mock.calls.at(-1)?.[1] ?? {});
}

function getUpdateSet(
  update: Record<string, unknown>,
): Record<string, unknown> {
  const set = update.$set;

  return isRecord(set) ? set : {};
}

function readMetadata(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const metadata = source.metadata;

  return isRecord(metadata) ? metadata : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
