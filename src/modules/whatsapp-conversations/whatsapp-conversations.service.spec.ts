import { AppResponseCode } from '@common/constants/response-codes.constants';
import type { AppError } from '@common/errors/app.error';
import type { AuditService } from '@modules/audit/audit.service';
import { AuditAction } from '@modules/audit/audit.types';
import type { AuthenticatedUserContext } from '@modules/auth/types/auth.types';
import type { CampaignsService } from '@modules/campaigns/campaigns.service';
import type { CustomerAiShadowService } from '@modules/customer-ai/customer-ai-shadow.service';
import type { CustomerAiIntentService } from '@modules/customer-ai/customer-ai-intent.service';
import {
  CheckoutSession,
  CheckoutSessionSchema,
  CheckoutSessionSource,
  CheckoutSessionStatus,
  type CheckoutSessionDocument,
} from '@modules/checkout-sessions/schemas/checkout-session.schema';
import {
  PlatformCustomerIdentity,
  PlatformCustomerIdentityStatus,
  type PlatformCustomerIdentityDocument,
} from '@modules/customers/schemas/platform-customer-identity.schema';
import { Order } from '@modules/orders/schemas/order.schema';
import {
  WhatsappChannelMode,
  type WhatsappChannelRecord,
} from '@modules/whatsapp-connections/schemas/whatsapp-channel.schema';
import {
  WhatsappChannelBindingStatus,
  type WhatsappChannelBindingRecord,
} from '@modules/whatsapp-connections/schemas/whatsapp-channel-binding.schema';
import {
  WhatsappConnectionProvider,
  WhatsappConnectionScope,
  WhatsappConnectionStatus,
} from '@modules/whatsapp-connections/types/whatsapp-connection.type';
import type { WhatsappChannelsService } from '@modules/whatsapp-connections/whatsapp-channels.service';
import type { WorkspaceEventsService } from '@modules/workspace-events/workspace-events.service';
import { Types, type Model } from 'mongoose';
import {
  WhatsappConversation,
  WhatsappConversationSchema,
  WhatsappConversationSource,
  WhatsappConversationState,
  WhatsappConversationStatus,
  type WhatsappConversationDocument,
} from './schemas/whatsapp-conversation.schema';
import {
  WhatsappInboundEvent,
  WhatsappInboundEventSchema,
  WhatsappInboundEventStatus,
  type WhatsappInboundEventDocument,
} from './schemas/whatsapp-inbound-event.schema';
import {
  WhatsappOutboundMessage,
  WhatsappOutboundMessageSchema,
  WhatsappOutboundMessageStatus,
  WhatsappOutboundMessageType,
  type WhatsappOutboundMessageDocument,
} from './schemas/whatsapp-outbound-message.schema';
import {
  extractCheckoutSessionCode,
  WhatsappConversationsService,
} from './whatsapp-conversations.service';
import { WhatsappConversationsRepository } from './whatsapp-conversations.repository';
import type { WhatsappCheckoutFlowService } from './whatsapp-checkout-flow.service';
import type { WhatsappInboundQueueService } from './whatsapp-inbound-queue.service';
import type { WhatsappOutboundDispatcherService } from './whatsapp-outbound-dispatcher.service';
import type { WhatsappStandardFlowService } from './whatsapp-standard-flow.service';

type QueryMock<TResult> = {
  sort: jest.Mock<QueryMock<TResult>, [Record<string, 1 | -1>]>;
  skip: jest.Mock<QueryMock<TResult>, [number]>;
  limit: jest.Mock<QueryMock<TResult>, [number]>;
  exec: jest.Mock<Promise<TResult>, []>;
};

type InboundEventModelMock = jest.Mock<
  WhatsappInboundEventDocument,
  [Record<string, unknown>]
> & {
  findOneAndUpdate: jest.Mock<
    QueryMock<WhatsappInboundEventDocument | null>,
    [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown> | undefined,
    ]
  >;
  find: jest.Mock<
    QueryMock<WhatsappInboundEventDocument[]>,
    [Record<string, unknown>]
  >;
};

type ConversationModelMock = jest.Mock<
  WhatsappConversationDocument,
  [Record<string, unknown>]
> & {
  countDocuments: jest.Mock<QueryMock<number>, [Record<string, unknown>]>;
  find: jest.Mock<
    QueryMock<WhatsappConversationDocument[]>,
    [Record<string, unknown>]
  >;
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

type PlatformCustomerIdentityModelMock = {
  findOneAndUpdate: jest.Mock<
    QueryMock<PlatformCustomerIdentityDocument | null>,
    [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown> | undefined,
    ]
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
const OTHER_WORKSPACE_ID = '507f1f77bcf86cd799439099';
const RESTAURANT_ID = '507f1f77bcf86cd799439011';
const BRANCH_ID = '507f1f77bcf86cd799439012';
const CHANNEL_ID = '507f1f77bcf86cd799439013';
const BINDING_ID = '507f1f77bcf86cd799439017';
const PLATFORM_IDENTITY_ID = '507f1f77bcf86cd799439018';
const CONVERSATION_ID = '507f1f77bcf86cd799439014';
const INBOUND_EVENT_ID = '507f1f77bcf86cd799439015';
const OUTBOUND_MESSAGE_ID = '507f1f77bcf86cd799439016';
const CHECKOUT_SESSION_ID = '507f1f77bcf86cd799439017';
const USER_ID = '507f1f77bcf86cd799439018';
const NOW = new Date('2026-06-07T09:00:00.000Z');
const SESSION_CODE = 'CHK-260607-ABC1234567';

describe('WhatsappConversationsService', () => {
  it('wires inference feedback to the inbound WhatsApp message and channel', async () => {
    const h = createService();
    h.customerAiIntentService.interpret.mockImplementation(async (input) => {
      await input.onInferenceStart?.();
      return { status: 'interpreted', actionId: 'home.my_orders' };
    });
    await h.service.processInboundEventJob(INBOUND_EVENT_ID);
    expect(
      h.outboundDispatcherService.sendTypingIndicator,
    ).toHaveBeenCalledTimes(1);
    expect(
      h.outboundDispatcherService.sendTypingIndicator,
    ).toHaveBeenCalledWith({
      conversation: expect.objectContaining({
        id: CONVERSATION_ID,
        channelId: CHANNEL_ID,
      }) as unknown,
      providerMessageId: 'wamid_1',
      reason: 'customer-ai-intent',
    });
    expect(h.standardFlowService.processInbound).toHaveBeenCalledTimes(1);
  });

  it('does not send AI typing feedback when interpretation is skipped', async () => {
    const h = createService();
    await h.service.processInboundEventJob(INBOUND_EVENT_ID);
    expect(
      h.outboundDispatcherService.sendTypingIndicator,
    ).not.toHaveBeenCalled();
  });

  it('dispatches one validated AI action without also sending the unknown-message response or shadow run', async () => {
    const h = createService();
    h.customerAiIntentService.interpret.mockResolvedValue({
      status: 'interpreted',
      actionId: 'order_entry.search',
      restaurantSearch: { q: 'Mama Tee', city: 'Lekki' },
    });
    await h.service.processInboundEventJob(INBOUND_EVENT_ID);
    expect(h.standardFlowService.processInbound).toHaveBeenCalledTimes(1);
    expect(h.standardFlowService.processInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionId: 'order_entry.search',
        restaurantSearch: { q: 'Mama Tee', city: 'Lekki' },
      }),
    );
    expect(
      h.checkoutFlowService.processInboundTextForConversation,
    ).not.toHaveBeenCalled();
    expect(h.customerAiShadowService.observeInbound).not.toHaveBeenCalled();
  });
  it('does not send an AI reply or a fallback for a superseded message', async () => {
    const h = createService();
    h.customerAiIntentService.interpret.mockResolvedValue({ status: 'stale' });
    await h.service.processInboundEventJob(INBOUND_EVENT_ID);
    expect(h.standardFlowService.processInbound).not.toHaveBeenCalled();
    expect(
      h.checkoutFlowService.processInboundTextForConversation,
    ).not.toHaveBeenCalled();
    expect(h.customerAiShadowService.observeInbound).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stores inbound webhook events and enqueues async processing', async () => {
    const { service, inboundEventModel, inboundQueueService } = createService();

    const response = await service.receiveWebhook(
      WhatsappConnectionProvider.ManualWhatsapp,
      {
        providerEventId: 'manual_event_1',
        fromPhoneNumber: '+234 800 000 0000',
        toPhoneNumber: '+234 801 234 5678',
        text: 'Hello',
        rawPayload: { id: 'manual_event_1' },
      },
    );

    expect(response).toEqual({
      received: true,
      duplicate: false,
      processed: false,
    });
    expect(inboundEventModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: WhatsappConnectionProvider.ManualWhatsapp,
        providerEventId: 'manual_event_1',
        text: 'Hello',
        status: WhatsappInboundEventStatus.Received,
        receivedAt: NOW,
      }),
    );
    expect(inboundQueueService.enqueueProcessJob).toHaveBeenCalledWith(
      INBOUND_EVENT_ID,
    );
    expect(inboundEventModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('re-enqueues stale received inbound events for recovery', async () => {
    const staleBefore = new Date('2026-06-07T08:59:45.000Z');
    const staleEventId = '507f1f77bcf86cd799439020';
    const { service, inboundEventModel, inboundQueueService } = createService({
      receivedInboundEvents: [
        createInboundEventDocument({
          _id: new Types.ObjectId(staleEventId),
          receivedAt: new Date('2026-06-07T08:59:00.000Z'),
        }),
      ],
    });

    const result = await service.enqueueStaleReceivedInboundEvents({
      staleBefore,
      limit: 25,
    });

    expect(result).toEqual({
      processed: 1,
      enqueued: 1,
      skipped: 0,
    });
    expect(inboundEventModel.find).toHaveBeenCalledWith({
      status: WhatsappInboundEventStatus.Received,
      receivedAt: {
        $lte: staleBefore,
      },
    });
    expect(inboundQueueService.enqueueProcessJob).toHaveBeenCalledWith(
      staleEventId,
    );
  });

  it('inbound worker safely ignores unresolved channels', async () => {
    const { service, inboundEventModel, whatsappChannelsService } =
      createService();
    whatsappChannelsService.resolveInboundChannel.mockResolvedValue(null);

    const processed = await service.processInboundEventJob(INBOUND_EVENT_ID);

    expect(processed).toBe(false);
    expect(inboundEventModel.findOneAndUpdate.mock.calls[0]?.[0]).toEqual({
      _id: INBOUND_EVENT_ID,
      status: WhatsappInboundEventStatus.Received,
    });
    expect(
      getUpdateSet(inboundEventModel.findOneAndUpdate.mock.calls[0]?.[1] ?? {}),
    ).toEqual(
      expect.objectContaining({
        status: WhatsappInboundEventStatus.Processing,
      }),
    );
    const ignoredUpdateCall = inboundEventModel.findOneAndUpdate.mock.calls[1];
    expect(getUpdateSet(ignoredUpdateCall?.[1] ?? {})).toEqual(
      expect.objectContaining({
        status: WhatsappInboundEventStatus.Ignored,
        failureReason: 'No matching WhatsApp channel',
      }),
    );
  });

  it('ignores duplicate provider events before processing', async () => {
    const { service, inboundEventModel, whatsappChannelsService } =
      createService();
    const duplicateError = { code: 11000 };
    inboundEventModel.mockImplementationOnce((input) =>
      createInboundEventDocument(input, {
        saveError: duplicateError,
      }),
    );

    const response = await service.receiveWebhook(
      WhatsappConnectionProvider.ManualWhatsapp,
      {
        providerEventId: 'manual_event_1',
        fromPhoneNumber: '+234 800 000 0000',
        toPhoneNumber: '+234 801 234 5678',
        rawPayload: { id: 'manual_event_1' },
      },
    );

    expect(response).toEqual({
      received: true,
      duplicate: true,
      processed: false,
    });
    expect(
      whatsappChannelsService.resolveInboundChannel,
    ).not.toHaveBeenCalled();
    expect(inboundEventModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('inbound worker upserts a conversation when a webhook resolves to a dedicated channel', async () => {
    const {
      service,
      inboundEventModel,
      conversationModel,
      standardFlowService,
    } = createService();

    const processed = await service.processInboundEventJob(INBOUND_EVENT_ID);

    expect(processed).toBe(true);
    expect(conversationModel.findOneAndUpdate.mock.calls[0]?.[0]).toEqual({
      channelId: CHANNEL_ID,
      platformCustomerIdentityId: PLATFORM_IDENTITY_ID,
      customerPhoneNumberNormalized: '2348000000000',
    });
    const conversationUpsertUpdate =
      conversationModel.findOneAndUpdate.mock.calls[0]?.[1] ?? {};
    expect(getUpdateSet(conversationUpsertUpdate)).toEqual(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        restaurantId: RESTAURANT_ID,
        branchId: BRANCH_ID,
      }),
    );
    const conversationSetOnInsert = getUpdateSetOnInsert(
      conversationUpsertUpdate,
    );
    expect(conversationSetOnInsert).not.toHaveProperty('workspaceId');
    expect(conversationSetOnInsert).not.toHaveProperty('restaurantId');
    expect(conversationSetOnInsert).not.toHaveProperty('branchId');
    expect(standardFlowService.processInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          id: CONVERSATION_ID,
          workspaceId: WORKSPACE_ID,
          restaurantId: RESTAURANT_ID,
          branchId: BRANCH_ID,
        }) as unknown,
        text: 'I need help',
      }),
    );
    const processedUpdateCall =
      inboundEventModel.findOneAndUpdate.mock.calls[3];
    expect(getUpdateSet(processedUpdateCall?.[1] ?? {})).toEqual(
      expect.objectContaining({
        status: WhatsappInboundEventStatus.Processed,
        processedAt: NOW,
      }),
    );
  });

  it('inbound worker ignores events that are no longer received', async () => {
    const { service, inboundEventModel, checkoutFlowService } = createService({
      claimInboundEvent: null,
    });

    const processed = await service.processInboundEventJob(INBOUND_EVENT_ID);

    expect(processed).toBe(false);
    expect(inboundEventModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(
      checkoutFlowService.processInboundTextForConversation,
    ).not.toHaveBeenCalled();
  });

  it('inbound worker delegates checkout session text without creating an order directly', async () => {
    const { service, checkoutSessionModel, checkoutFlowService } =
      createService({
        claimInboundEvent: createInboundEventDocument({
          provider: WhatsappConnectionProvider.MetaCloud,
          providerEventId: 'wamid_2',
          providerMessageId: 'wamid_2',
          fromPhoneNumber: '+234 800 000 0000',
          toPhoneNumber: '+234 801 234 5678',
          providerPhoneNumberId: 'phone_number_id_1',
          messageType: 'text',
          text: `Continue my Ordira order ${SESSION_CODE}`,
          rawPayload: createMetaPayload({
            id: 'wamid_2',
            text: `Continue my Ordira order ${SESSION_CODE}`,
          }),
        }),
      });
    const handoffText = `Continue my Ordira order ${SESSION_CODE}`;
    const processed = await service.processInboundEventJob(INBOUND_EVENT_ID);

    expect(processed).toBe(true);
    expect(
      checkoutFlowService.processInboundTextForConversation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: CONVERSATION_ID,
      }),
      handoffText,
      null,
    );
    expect(checkoutSessionModel.findOne).not.toHaveBeenCalled();
  });

  it('routes unscoped shared-platform greetings into the standard flow', async () => {
    const {
      service,
      checkoutFlowService,
      conversationModel,
      standardFlowService,
    } = createService({
      inboundChannel: createWhatsappChannel({
        mode: WhatsappChannelMode.SharedPlatform,
        isDefaultForMarket: true,
      }),
      inboundBinding: null,
      claimInboundEvent: createInboundEventDocument({
        provider: WhatsappConnectionProvider.MetaCloud,
        providerEventId: 'wamid_hello',
        providerMessageId: 'wamid_hello',
        fromPhoneNumber: '+234 800 000 0000',
        toPhoneNumber: '+234 801 234 5678',
        providerPhoneNumberId: 'phone_number_id_1',
        messageType: 'text',
        text: 'hello',
        customerName: 'Ada Customer',
        rawPayload: createMetaPayload({
          id: 'wamid_hello',
          text: 'hello',
        }),
      }),
    });
    conversationModel.findOneAndUpdate.mockReturnValueOnce(
      createQuery(
        createConversationDocument({
          channelMode: WhatsappChannelMode.SharedPlatform,
          workspaceId: null,
          restaurantId: null,
          branchId: null,
        }),
      ),
    );

    const processed = await service.processInboundEventJob(INBOUND_EVENT_ID);

    expect(processed).toBe(true);
    const conversationUpsertUpdate =
      conversationModel.findOneAndUpdate.mock.calls[0]?.[1] ?? {};
    const conversationSet = getUpdateSet(conversationUpsertUpdate);
    expect(conversationSet).not.toHaveProperty('workspaceId');
    expect(conversationSet).not.toHaveProperty('restaurantId');
    expect(conversationSet).not.toHaveProperty('branchId');
    const conversationSetOnInsert = getUpdateSetOnInsert(
      conversationUpsertUpdate,
    );
    expect(conversationSetOnInsert).not.toHaveProperty('workspaceId');
    expect(conversationSetOnInsert).not.toHaveProperty('restaurantId');
    expect(conversationSetOnInsert).not.toHaveProperty('branchId');
    expect(standardFlowService.processInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        inboundEventId: INBOUND_EVENT_ID,
        providerMessageId: 'wamid_hello',
        text: 'hello',
        interactionId: null,
      }),
    );
    expect(
      checkoutFlowService.processInboundTextForConversation,
    ).not.toHaveBeenCalled();
  });

  it.each([
    ['HOME', WhatsappConversationState.AwaitingConfirmation],
    ['find', WhatsappConversationState.PlatformHome],
    [
      'Could you please show me my oders?',
      WhatsappConversationState.OrderCreated,
    ],
    ['Find Madam Love in Lekki', WhatsappConversationState.PlatformHome],
    ['show', WhatsappConversationState.OrderCreated],
    ['find a restaurant', WhatsappConversationState.PlatformHome],
    ['show my orders', WhatsappConversationState.OrderCreated],
    ['Order', WhatsappConversationState.AwaitingConfirmation],
    ['ORDERS', WhatsappConversationState.OrderCreated],
    ['hi', WhatsappConversationState.AwaitingConfirmation],
    ['Hey', WhatsappConversationState.AwaitingConfirmation],
    ['👋 HI!', WhatsappConversationState.AwaitingConfirmation],
    ['Hello there', WhatsappConversationState.AwaitingConfirmation],
    ['Good morning!', WhatsappConversationState.AwaitingConfirmation],
    ['  GOOD   AFTERNOON  ', WhatsappConversationState.AwaitingConfirmation],
    ['good evening', WhatsappConversationState.AwaitingConfirmation],
    ['Place an order', WhatsappConversationState.PlatformHome],
    ['🧾 MY ORDERS', WhatsappConversationState.OrderCreated],
    ['near me', WhatsappConversationState.AwaitingOrderEntryChoice],
    ['Mama Tee', WhatsappConversationState.AwaitingRestaurantSearch],
  ])(
    'routes tenant-context %s messages into the standard flow instead of checkout help',
    async (text, state) => {
      const providerMessageId = `wamid_${text.toLowerCase()}`;
      const {
        service,
        checkoutFlowService,
        conversationModel,
        standardFlowService,
      } = createService({
        inboundChannel: createWhatsappChannel({
          mode: WhatsappChannelMode.SharedPlatform,
          isDefaultForMarket: true,
        }),
        inboundBinding: null,
        claimInboundEvent: createInboundEventDocument({
          provider: WhatsappConnectionProvider.MetaCloud,
          providerEventId: providerMessageId,
          providerMessageId,
          fromPhoneNumber: '+234 800 000 0000',
          toPhoneNumber: '+234 801 234 5678',
          providerPhoneNumberId: 'phone_number_id_1',
          messageType: 'text',
          text,
          customerName: 'Ada Customer',
          rawPayload: createMetaPayload({
            id: providerMessageId,
            text,
          }),
        }),
      });
      conversationModel.findOneAndUpdate.mockReturnValueOnce(
        createQuery(
          createConversationDocument({
            channelMode: WhatsappChannelMode.SharedPlatform,
            workspaceId: WORKSPACE_ID,
            restaurantId: RESTAURANT_ID,
            branchId: BRANCH_ID,
            checkoutSessionId: CHECKOUT_SESSION_ID,
            state,
          }),
        ),
      );

      const processed = await service.processInboundEventJob(INBOUND_EVENT_ID);

      expect(processed).toBe(true);
      const conversationUpsertUpdate =
        conversationModel.findOneAndUpdate.mock.calls[0]?.[1] ?? {};
      const conversationSet = getUpdateSet(conversationUpsertUpdate);
      expect(conversationSet).not.toHaveProperty('workspaceId');
      expect(conversationSet).not.toHaveProperty('restaurantId');
      expect(conversationSet).not.toHaveProperty('branchId');
      const conversationSetOnInsert = getUpdateSetOnInsert(
        conversationUpsertUpdate,
      );
      expect(conversationSetOnInsert).not.toHaveProperty('workspaceId');
      expect(conversationSetOnInsert).not.toHaveProperty('restaurantId');
      expect(conversationSetOnInsert).not.toHaveProperty('branchId');
      expect(standardFlowService.processInbound).toHaveBeenCalledWith(
        expect.objectContaining({
          inboundEventId: INBOUND_EVENT_ID,
          providerMessageId,
          text,
        }),
      );
      expect(
        checkoutFlowService.processInboundTextForConversation,
      ).not.toHaveBeenCalled();
    },
  );

  it('observes natural shared discovery in shadow without replacing the standard flow', async () => {
    const {
      service,
      conversationModel,
      standardFlowService,
      customerAiShadowService,
    } = createService({
      inboundChannel: createWhatsappChannel({
        mode: WhatsappChannelMode.SharedPlatform,
        isDefaultForMarket: true,
      }),
      inboundBinding: null,
      claimInboundEvent: createInboundEventDocument({
        provider: WhatsappConnectionProvider.MetaCloud,
        providerEventId: 'wamid_discovery',
        providerMessageId: 'wamid_discovery',
        fromPhoneNumber: '+234 800 000 0000',
        toPhoneNumber: '+234 801 234 5678',
        providerPhoneNumberId: 'phone_number_id_1',
        messageType: 'text',
        text: 'spicy chicken in Lekki',
        rawPayload: createMetaPayload({
          id: 'wamid_discovery',
          text: 'spicy chicken in Lekki',
        }),
      }),
    });
    conversationModel.findOneAndUpdate.mockReturnValueOnce(
      createQuery(
        createConversationDocument({
          channelMode: WhatsappChannelMode.SharedPlatform,
          workspaceId: null,
          restaurantId: null,
          branchId: null,
          state: WhatsappConversationState.New,
          inputVersion: 1,
          stateVersion: 0,
        }),
      ),
    );

    await expect(
      service.processInboundEventJob(INBOUND_EVENT_ID),
    ).resolves.toBe(true);

    expect(customerAiShadowService.observeInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        inboundEventId: INBOUND_EVENT_ID,
        customerMessage: 'spicy chicken in Lekki',
        deterministicInput: false,
      }),
    );
    const observation =
      customerAiShadowService.observeInbound.mock.calls[0]?.[0];
    expect(observation?.conversation).toEqual(
      expect.objectContaining({
        id: CONVERSATION_ID,
        inputVersion: 1,
        stateVersion: 0,
      }),
    );
    expect(standardFlowService.processInbound).toHaveBeenCalledTimes(1);
  });

  it('routes tenant-context location replies into the standard flow while awaiting location', async () => {
    const {
      service,
      checkoutFlowService,
      conversationModel,
      standardFlowService,
    } = createService({
      inboundChannel: createWhatsappChannel({
        mode: WhatsappChannelMode.SharedPlatform,
        isDefaultForMarket: true,
      }),
      inboundBinding: null,
      claimInboundEvent: createInboundEventDocument({
        provider: WhatsappConnectionProvider.MetaCloud,
        providerEventId: 'wamid_location',
        providerMessageId: 'wamid_location',
        fromPhoneNumber: '+234 800 000 0000',
        toPhoneNumber: '+234 801 234 5678',
        providerPhoneNumberId: 'phone_number_id_1',
        messageType: 'location',
        location: {
          latitude: 6.45,
          longitude: 3.39,
          name: 'Lekki Phase 1',
          address: 'Lekki, Lagos',
        },
        customerName: 'Ada Customer',
        rawPayload: createMetaPayload({
          id: 'wamid_location',
          messageType: 'location',
        }),
      }),
    });
    conversationModel.findOneAndUpdate.mockReturnValueOnce(
      createQuery(
        createConversationDocument({
          channelMode: WhatsappChannelMode.SharedPlatform,
          workspaceId: WORKSPACE_ID,
          restaurantId: RESTAURANT_ID,
          branchId: BRANCH_ID,
          state: WhatsappConversationState.AwaitingLocation,
        }),
      ),
    );

    const processed = await service.processInboundEventJob(INBOUND_EVENT_ID);

    expect(processed).toBe(true);
    expect(standardFlowService.processInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        inboundEventId: INBOUND_EVENT_ID,
        providerMessageId: 'wamid_location',
        text: null,
        interactionId: null,
        location: {
          latitude: 6.45,
          longitude: 3.39,
          name: 'Lekki Phase 1',
          address: 'Lekki, Lagos',
        },
      }),
    );
    expect(
      checkoutFlowService.processInboundTextForConversation,
    ).not.toHaveBeenCalled();
  });

  it('does not process duplicate inbound events through the checkout flow', async () => {
    const {
      service,
      inboundEventModel,
      checkoutFlowService,
      inboundQueueService,
    } = createService();
    inboundEventModel.mockImplementationOnce((input) =>
      createInboundEventDocument(input, {
        saveError: { code: 11000 },
      }),
    );
    const response = await service.receiveWebhook(
      WhatsappConnectionProvider.MetaCloud,
      {
        rawPayload: createMetaPayload({
          id: 'wamid_3',
          text: `Continue my Ordira order ${SESSION_CODE}`,
        }),
      },
    );

    expect(response).toEqual({
      received: true,
      duplicate: true,
      processed: false,
    });
    expect(
      checkoutFlowService.processInboundTextForConversation,
    ).not.toHaveBeenCalled();
    expect(inboundQueueService.enqueueProcessJob).not.toHaveBeenCalled();
  });

  it('extracts text, metadata, customer, and timestamp from Meta payloads', async () => {
    const { service, inboundEventModel } = createService();

    await service.receiveWebhook(WhatsappConnectionProvider.MetaCloud, {
      rawPayload: createMetaPayload({
        id: 'wamid_4',
        text: 'Continue my Ordira order',
        timestamp: '1780822800',
      }),
    });

    expect(inboundEventModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: WhatsappConnectionProvider.MetaCloud,
        providerEventId: 'wamid_4',
        providerMessageId: 'wamid_4',
        providerPhoneNumberId: 'phone_number_id_1',
        fromPhoneNumber: '2348000000000',
        toPhoneNumber: '+234 801 234 5678',
        customerName: 'Ada Customer',
        messageType: 'text',
        text: 'Continue my Ordira order',
        providerTimestamp: new Date('2026-06-07T09:00:00.000Z'),
      }),
    );
  });

  it('handles Meta payloads without messages without crashing', async () => {
    const { service, inboundEventModel } = createService();

    const response = await service.receiveWebhook(
      WhatsappConnectionProvider.MetaCloud,
      {
        rawPayload: {
          object: 'whatsapp_business_account',
          entry: [
            {
              id: 'business_account_1',
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: {
                      display_phone_number: '+234 801 234 5678',
                      phone_number_id: 'phone_number_id_1',
                    },
                    contacts: [
                      {
                        wa_id: '2348000000000',
                        profile: {
                          name: 'Ada Customer',
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    );

    expect(response).toEqual({
      received: true,
      duplicate: false,
      processed: false,
    });
    const savedEvent = inboundEventModel.mock.calls[0]?.[0] ?? {};
    expect(savedEvent.providerEventId).toEqual(expect.stringMatching(/^hash_/));
    expect(savedEvent.providerPhoneNumberId).toBe('phone_number_id_1');
    expect(savedEvent.customerName).toBe('Ada Customer');
  });

  it('reconciles Meta status webhooks without running checkout text flow', async () => {
    const {
      service,
      campaignsService,
      checkoutFlowService,
      conversationModel,
      inboundEventModel,
    } = createService({
      claimInboundEvent: createInboundEventDocument({
        provider: WhatsappConnectionProvider.MetaCloud,
        providerEventId: 'wamid_status_1:1780822800:2348000000000',
        providerMessageId: null,
        fromPhoneNumber: null,
        toPhoneNumber: '+234 801 234 5678',
        providerPhoneNumberId: 'phone_number_id_1',
        messageType: 'status',
        text: null,
        rawPayload: createMetaStatusPayload({
          id: 'wamid_status_1',
          status: 'delivered',
          timestamp: '1780822800',
        }),
      }),
    });

    const processed = await service.processInboundEventJob(INBOUND_EVENT_ID);

    expect(processed).toBe(true);
    expect(campaignsService.recordWhatsappProviderStatus).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      providerMessageId: 'wamid_status_1',
      providerStatus: 'delivered',
      providerTimestamp: new Date('2026-06-07T09:00:00.000Z'),
      failureReason: null,
    });
    expect(conversationModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(
      checkoutFlowService.processInboundTextForConversation,
    ).not.toHaveBeenCalled();
    const processedUpdateCall =
      inboundEventModel.findOneAndUpdate.mock.calls[2];
    expect(getUpdateSet(processedUpdateCall?.[1] ?? {})).toEqual(
      expect.objectContaining({
        status: WhatsappInboundEventStatus.Processed,
        processedAt: NOW,
        failureReason: null,
      }),
    );
  });

  it('stores unsupported Meta message types without sending them to checkout flow', async () => {
    const {
      service,
      inboundEventModel,
      checkoutFlowService,
      conversationModel,
    } = createService({
      claimInboundEvent: createInboundEventDocument({
        provider: WhatsappConnectionProvider.MetaCloud,
        providerEventId: 'wamid_image_1',
        providerMessageId: 'wamid_image_1',
        fromPhoneNumber: '+234 800 000 0000',
        toPhoneNumber: '+234 801 234 5678',
        providerPhoneNumberId: 'phone_number_id_1',
        messageType: 'image',
        text: null,
        rawPayload: createMetaPayload({
          id: 'wamid_image_1',
          messageType: 'image',
        }),
      }),
    });

    const processed = await service.processInboundEventJob(INBOUND_EVENT_ID);

    expect(processed).toBe(false);
    expect(conversationModel.findOneAndUpdate).toHaveBeenCalled();
    expect(
      checkoutFlowService.processInboundTextForConversation,
    ).not.toHaveBeenCalled();
    const ignoredUpdateCall = inboundEventModel.findOneAndUpdate.mock.calls[3];
    expect(getUpdateSet(ignoredUpdateCall?.[1] ?? {})).toEqual(
      expect.objectContaining({
        status: WhatsappInboundEventStatus.Ignored,
        failureReason: 'Unsupported WhatsApp message type',
      }),
    );
  });

  it('lists conversations only inside the current workspace', async () => {
    const { service, conversationModel } = createService();
    conversationModel.countDocuments.mockReturnValue(createQuery(1));
    conversationModel.find.mockReturnValue(
      createQuery([
        createConversationDocument({
          lastMessageText: 'Order question',
        }),
      ]),
    );

    const response = await service.listConversations(createAuth(), {
      restaurantId: RESTAURANT_ID,
      page: 2,
      limit: 10,
      customerPhoneNumber: '+234 800 000 0000',
    });

    expect(conversationModel.countDocuments).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      restaurantId: RESTAURANT_ID,
      customerPhoneNumberNormalized: '2348000000000',
      channelMode: {
        $ne: 'shared_platform',
      },
    });
    expect(response).toEqual({
      conversations: [
        expect.objectContaining({
          id: CONVERSATION_ID,
          workspaceId: WORKSPACE_ID,
          lastMessageText: 'Order question',
        }),
      ],
      meta: {
        page: 2,
        limit: 10,
        total: 1,
        totalPages: 1,
      },
    });
  });

  it('manually links a checkout session and audits the action', async () => {
    const { service, conversationModel, auditService, workspaceEventsService } =
      createService();
    conversationModel.findOneAndUpdate.mockReturnValueOnce(
      createQuery(
        createConversationDocument({
          checkoutSessionId: CHECKOUT_SESSION_ID,
          checkoutSessionCode: SESSION_CODE,
          state: WhatsappConversationState.CheckoutLinked,
        }),
      ),
    );

    const response = await service.linkCheckoutSession(
      createAuth(),
      CONVERSATION_ID,
      {
        checkoutSessionCode: SESSION_CODE,
      },
    );

    expect(response.checkoutSessionId).toBe(CHECKOUT_SESSION_ID);
    expect(conversationModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({ orderId: null }) as Record<
          string,
          unknown
        >,
      }),
      expect.anything(),
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.WhatsappConversationCheckoutLinked,
        resource: 'whatsapp_conversation',
        resourceId: CONVERSATION_ID,
      }),
    );
    expect(
      workspaceEventsService.publishWhatsappConversationUpdated,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        checkoutSessionCode: SESSION_CODE,
      }),
    );
  });

  it('rejects manual checkout links across workspaces', async () => {
    const { service, conversationModel, checkoutSessionModel } =
      createService();
    conversationModel.findOne.mockReturnValueOnce(
      createQuery(createConversationDocument({ workspaceId: WORKSPACE_ID })),
    );
    checkoutSessionModel.findOne.mockReturnValueOnce(
      createQuery(
        createCheckoutSessionDocument({
          workspaceId: OTHER_WORKSPACE_ID,
        }),
      ),
    );

    await expect(
      service.linkCheckoutSession(createAuth(), CONVERSATION_ID, {
        checkoutSessionCode: SESSION_CODE,
      }),
    ).rejects.toMatchObject<AppError>({
      code: AppResponseCode.CheckoutSessionNotFound,
    });
    expect(conversationModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('queues outbound messages without calling an external provider', async () => {
    const {
      service,
      outboundMessageModel,
      conversationModel,
      auditService,
      outboundDispatcherService,
      workspaceEventsService,
    } = createService();

    const response = await service.queueOutboundMessage(
      createAuth(),
      CONVERSATION_ID,
      {
        text: 'Thanks, we are checking this now.',
      },
    );

    expect(response).toEqual(
      expect.objectContaining({
        id: OUTBOUND_MESSAGE_ID,
        status: WhatsappOutboundMessageStatus.Queued,
        messageType: WhatsappOutboundMessageType.Text,
        text: 'Thanks, we are checking this now.',
      }),
    );
    expect(outboundMessageModel).toHaveBeenCalledWith(
      expect.objectContaining({
        status: WhatsappOutboundMessageStatus.Queued,
        text: 'Thanks, we are checking this now.',
        nextAttemptAt: NOW,
      }),
    );
    const conversationUpdateCall =
      conversationModel.findOneAndUpdate.mock.calls[0];
    expect(conversationUpdateCall?.[0]).toEqual({ _id: CONVERSATION_ID });
    expect(getUpdateSet(conversationUpdateCall?.[1] ?? {})).toEqual(
      expect.objectContaining({
        status: WhatsappConversationStatus.WaitingForCustomer,
        lastOutboundAt: NOW,
      }),
    );
    expect(conversationUpdateCall?.[2]).toEqual(
      expect.objectContaining({ returnDocument: 'after' }),
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.WhatsappMessageQueued,
        resource: 'whatsapp_outbound_message',
      }),
    );
    expect(
      outboundDispatcherService.enqueueOutboundMessage,
    ).toHaveBeenCalledWith(OUTBOUND_MESSAGE_ID);
    expect(
      workspaceEventsService.publishWhatsappConversationUpdated,
    ).toHaveBeenCalled();
  });

  it('returns an existing queued message for outbound idempotency keys', async () => {
    const { service, outboundMessageModel, outboundDispatcherService } =
      createService({
        existingOutboundMessage: createOutboundMessageDocument({
          text: 'Already queued',
        }),
      });

    const response = await service.queueOutboundMessage(
      createAuth(),
      CONVERSATION_ID,
      {
        text: 'Already queued',
        idempotencyKey: 'message-key-1',
      },
    );

    expect(response.id).toBe(OUTBOUND_MESSAGE_ID);
    expect(response.text).toBe('Already queued');
    expect(
      outboundDispatcherService.enqueueOutboundMessage,
    ).toHaveBeenCalledWith(OUTBOUND_MESSAGE_ID);
    expect(outboundMessageModel).not.toHaveBeenCalled();
  });

  it('defines safe webhook, conversation, and outbound indexes', () => {
    expect(
      hasSchemaIndex(WhatsappInboundEventSchema, {
        provider: 1,
        providerEventId: 1,
      }),
    ).toBe(true);
    expect(
      hasSchemaIndex(WhatsappConversationSchema, {
        workspaceId: 1,
        restaurantId: 1,
        branchId: 1,
        status: 1,
        lastMessageAt: -1,
      }),
    ).toBe(true);
    expect(
      hasSchemaIndex(
        WhatsappOutboundMessageSchema,
        { idempotencyKeyHash: 1 },
        (options) => Boolean(options.unique),
      ),
    ).toBe(true);
    expect(CheckoutSessionSchema.path('sessionTokenHash')?.options).toEqual(
      expect.objectContaining({ select: false }),
    );
  });

  it('extracts checkout session codes from handoff text', () => {
    expect(
      extractCheckoutSessionCode(
        'Continue my Ordira order chk-260607-abc1234567',
      ),
    ).toBe(SESSION_CODE);
    expect(extractCheckoutSessionCode('No code here')).toBeUndefined();
  });
});

function createService(
  options: {
    existingOutboundMessage?: WhatsappOutboundMessageDocument | null;
    claimInboundEvent?: WhatsappInboundEventDocument | null;
    receivedInboundEvents?: WhatsappInboundEventDocument[];
    inboundChannel?: WhatsappChannelRecord;
    inboundBinding?: WhatsappChannelBindingRecord | null;
  } = {},
): {
  service: WhatsappConversationsService;
  inboundEventModel: InboundEventModelMock;
  conversationModel: ConversationModelMock;
  outboundMessageModel: OutboundMessageModelMock;
  platformCustomerIdentityModel: PlatformCustomerIdentityModelMock;
  checkoutSessionModel: CheckoutSessionModelMock;
  checkoutFlowService: jest.Mocked<
    Pick<WhatsappCheckoutFlowService, 'processInboundTextForConversation'>
  >;
  inboundQueueService: jest.Mocked<
    Pick<WhatsappInboundQueueService, 'enqueueProcessJob'>
  >;
  outboundDispatcherService: jest.Mocked<
    Pick<
      WhatsappOutboundDispatcherService,
      'enqueueOutboundMessage' | 'sendTypingIndicator'
    >
  >;
  standardFlowService: jest.Mocked<
    Pick<WhatsappStandardFlowService, 'processInbound'>
  >;
  auditService: jest.Mocked<Pick<AuditService, 'record'>>;
  whatsappChannelsService: jest.Mocked<
    Pick<
      WhatsappChannelsService,
      'resolveInboundChannel' | 'findActiveBindingForChannel'
    >
  >;
  workspaceEventsService: jest.Mocked<
    Pick<WorkspaceEventsService, 'publishWhatsappConversationUpdated'>
  >;
  campaignsService: jest.Mocked<
    Pick<CampaignsService, 'recordWhatsappProviderStatus'>
  >;
  customerAiShadowService: jest.Mocked<
    Pick<CustomerAiShadowService, 'observeInbound'>
  >;
  customerAiIntentService: jest.Mocked<
    Pick<CustomerAiIntentService, 'interpret'>
  >;
} {
  const inboundEventModel = jest.fn((input: Record<string, unknown>) =>
    createInboundEventDocument(input),
  ) as InboundEventModelMock;
  const claimInboundEvent =
    options.claimInboundEvent === undefined
      ? createInboundEventDocument({
          provider: WhatsappConnectionProvider.MetaCloud,
          providerEventId: 'wamid_1',
          providerMessageId: 'wamid_1',
          fromPhoneNumber: '+234 800 000 0000',
          toPhoneNumber: '+234 801 234 5678',
          providerPhoneNumberId: 'phone_number_id_1',
          messageType: 'text',
          text: 'I need help',
          customerName: 'Ada Customer',
          rawPayload: createMetaPayload({
            id: 'wamid_1',
            text: 'I need help',
          }),
        })
      : options.claimInboundEvent;
  inboundEventModel.findOneAndUpdate = jest.fn((_filter, update) => {
    const set = getUpdateSet(update);
    if (set.status === WhatsappInboundEventStatus.Processing) {
      return createQuery(claimInboundEvent);
    }

    return createQuery(
      createInboundEventDocument({
        ...(claimInboundEvent ?? {}),
        ...set,
      }),
    );
  });
  inboundEventModel.find = jest.fn(() =>
    createQuery(options.receivedInboundEvents ?? []),
  );

  const conversationModel = jest.fn() as ConversationModelMock;
  conversationModel.countDocuments = jest.fn(() => createQuery(0));
  conversationModel.find = jest.fn(() => createQuery([]));
  conversationModel.findOne = jest.fn(() =>
    createQuery(createConversationDocument()),
  );
  conversationModel.findOneAndUpdate = jest.fn(() =>
    createQuery(createConversationDocument()),
  );

  const outboundMessageModel = jest.fn((input: Record<string, unknown>) =>
    createOutboundMessageDocument(input),
  ) as OutboundMessageModelMock;
  outboundMessageModel.findOne = jest.fn(() =>
    createQuery(options.existingOutboundMessage ?? null),
  );

  const platformCustomerIdentityModel = {
    findOneAndUpdate: jest.fn((_filter, update) =>
      createQuery(
        createPlatformCustomerIdentityDocument({
          ...getUpdateSet(update),
        }),
      ),
    ),
  } satisfies PlatformCustomerIdentityModelMock;

  const checkoutSessionModel = {
    findOne: jest.fn(() => createQuery(createCheckoutSessionDocument())),
    findOneAndUpdate: jest.fn(() =>
      createQuery(createCheckoutSessionDocument()),
    ),
  };

  const auditService = {
    record: jest.fn().mockResolvedValue(undefined),
  };
  const checkoutFlowService = {
    processInboundTextForConversation: jest.fn((conversation) =>
      Promise.resolve(conversation),
    ),
  } satisfies jest.Mocked<
    Pick<WhatsappCheckoutFlowService, 'processInboundTextForConversation'>
  >;
  const inboundQueueService = {
    enqueueProcessJob: jest.fn().mockResolvedValue(true),
  } satisfies jest.Mocked<
    Pick<WhatsappInboundQueueService, 'enqueueProcessJob'>
  >;
  const outboundDispatcherService = {
    sendTypingIndicator: jest.fn().mockResolvedValue(true),
    enqueueOutboundMessage: jest.fn().mockResolvedValue(true),
  } satisfies jest.Mocked<
    Pick<
      WhatsappOutboundDispatcherService,
      'enqueueOutboundMessage' | 'sendTypingIndicator'
    >
  >;
  const standardFlowService = {
    processInbound: jest.fn().mockResolvedValue(undefined),
  } satisfies jest.Mocked<Pick<WhatsappStandardFlowService, 'processInbound'>>;
  const workspaceEventsService = {
    publishWhatsappConversationUpdated: jest.fn().mockResolvedValue(undefined),
  };
  const campaignsService = {
    recordWhatsappProviderStatus: jest.fn().mockResolvedValue(true),
  } satisfies jest.Mocked<
    Pick<CampaignsService, 'recordWhatsappProviderStatus'>
  >;
  const customerAiShadowService = {
    observeInbound: jest.fn().mockResolvedValue(false),
  } satisfies jest.Mocked<Pick<CustomerAiShadowService, 'observeInbound'>>;
  const customerAiIntentService = {
    interpret: jest.fn().mockResolvedValue({ status: 'skipped' }),
  } satisfies jest.Mocked<Pick<CustomerAiIntentService, 'interpret'>>;
  const whatsappChannelsService = {
    resolveInboundChannel: jest
      .fn()
      .mockResolvedValue(options.inboundChannel ?? createWhatsappChannel()),
    findActiveBindingForChannel: jest
      .fn()
      .mockResolvedValue(
        options.inboundBinding === undefined
          ? createWhatsappChannelBinding()
          : options.inboundBinding,
      ),
  } satisfies jest.Mocked<
    Pick<
      WhatsappChannelsService,
      'resolveInboundChannel' | 'findActiveBindingForChannel'
    >
  >;
  const whatsappConversationsRepository = new WhatsappConversationsRepository(
    inboundEventModel as unknown as Model<WhatsappInboundEvent>,
    conversationModel as unknown as Model<WhatsappConversation>,
    outboundMessageModel as unknown as Model<WhatsappOutboundMessage>,
    platformCustomerIdentityModel as unknown as Model<PlatformCustomerIdentity>,
    checkoutSessionModel as unknown as Model<CheckoutSession>,
    {} as unknown as Model<Order>,
  );
  const service = new WhatsappConversationsService(
    whatsappConversationsRepository,
    auditService as unknown as AuditService,
    checkoutFlowService as unknown as WhatsappCheckoutFlowService,
    whatsappChannelsService as unknown as WhatsappChannelsService,
    inboundQueueService as unknown as WhatsappInboundQueueService,
    outboundDispatcherService as unknown as WhatsappOutboundDispatcherService,
    standardFlowService as unknown as WhatsappStandardFlowService,
    workspaceEventsService as unknown as WorkspaceEventsService,
    campaignsService as unknown as CampaignsService,
    customerAiShadowService as unknown as CustomerAiShadowService,
    customerAiIntentService as unknown as CustomerAiIntentService,
  );

  return {
    service,
    inboundEventModel,
    conversationModel,
    outboundMessageModel,
    platformCustomerIdentityModel,
    checkoutSessionModel,
    checkoutFlowService,
    inboundQueueService,
    outboundDispatcherService,
    standardFlowService,
    auditService,
    whatsappChannelsService,
    workspaceEventsService,
    campaignsService,
    customerAiShadowService,
    customerAiIntentService,
  };
}

function createQuery<TResult>(result: TResult): QueryMock<TResult> {
  const query: QueryMock<TResult> = {
    sort: jest.fn<QueryMock<TResult>, [Record<string, 1 | -1>]>(),
    skip: jest.fn<QueryMock<TResult>, [number]>(),
    limit: jest.fn<QueryMock<TResult>, [number]>(),
    exec: jest.fn<Promise<TResult>, []>().mockResolvedValue(result),
  };
  query.sort.mockReturnValue(query);
  query.skip.mockReturnValue(query);
  query.limit.mockReturnValue(query);

  return query;
}

function createInboundEventDocument(
  overrides: Record<string, unknown> = {},
  options: {
    saveError?: unknown;
  } = {},
): WhatsappInboundEventDocument {
  const save = options.saveError
    ? jest.fn().mockRejectedValue(options.saveError)
    : jest.fn().mockResolvedValue(undefined);

  return {
    _id: new Types.ObjectId(INBOUND_EVENT_ID),
    provider: WhatsappConnectionProvider.ManualWhatsapp,
    providerEventId: 'manual_event_1',
    providerMessageId: null,
    fromPhoneNumber: null,
    toPhoneNumber: null,
    providerPhoneNumberId: null,
    messageType: null,
    text: null,
    customerName: null,
    rawPayload: {},
    status: WhatsappInboundEventStatus.Received,
    receivedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    save,
    ...overrides,
  } as unknown as WhatsappInboundEventDocument;
}

function createWhatsappChannel(
  overrides: Partial<WhatsappChannelRecord> = {},
): WhatsappChannelRecord {
  return {
    id: CHANNEL_ID,
    mode: WhatsappChannelMode.DedicatedTenant,
    marketCode: 'NG',
    provider: WhatsappConnectionProvider.MetaCloud,
    status: WhatsappConnectionStatus.Connected,
    displayName: 'Lekki WhatsApp',
    phoneNumber: '+234 801 234 5678',
    phoneNumberNormalized: '2348012345678',
    providerPhoneNumberId: 'phone_number_id_1',
    providerBusinessAccountId: 'business_account_id_1',
    verifiedAt: NOW,
    lastConnectedAt: NOW,
    lastDisconnectedAt: null,
    lastStatusChangedAt: NOW,
    isDefaultForMarket: false,
    settings: {},
    createdByUserId: USER_ID,
    updatedByUserId: USER_ID,
    disabledAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createWhatsappChannelBinding(
  overrides: Partial<WhatsappChannelBindingRecord> = {},
): WhatsappChannelBindingRecord {
  return {
    id: BINDING_ID,
    channelId: CHANNEL_ID,
    workspaceId: WORKSPACE_ID,
    restaurantId: RESTAURANT_ID,
    branchId: BRANCH_ID,
    scope: WhatsappConnectionScope.Branch,
    status: WhatsappChannelBindingStatus.Active,
    createdByUserId: USER_ID,
    updatedByUserId: USER_ID,
    disabledAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createPlatformCustomerIdentityDocument(
  overrides: Partial<PlatformCustomerIdentityDocument> = {},
): PlatformCustomerIdentityDocument {
  return {
    _id: new Types.ObjectId(PLATFORM_IDENTITY_ID),
    phoneNumber: '+234 800 000 0000',
    phoneNumberNormalized: '2348000000000',
    whatsappProfileName: 'Ada Customer',
    email: null,
    emailNormalized: null,
    emailVerifiedAt: null,
    status: PlatformCustomerIdentityStatus.Active,
    locale: null,
    marketCode: 'NG',
    communicationPreferences: {
      whatsappTransactional: true,
      emailTransactional: true,
      whatsappMarketing: true,
      emailMarketing: true,
    },
    lastSeenAt: NOW,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as PlatformCustomerIdentityDocument;
}

function createConversationDocument(
  overrides: Partial<WhatsappConversationDocument> = {},
): WhatsappConversationDocument {
  return {
    _id: new Types.ObjectId(CONVERSATION_ID),
    channelId: CHANNEL_ID,
    channelMode: WhatsappChannelMode.DedicatedTenant,
    platformCustomerIdentityId: PLATFORM_IDENTITY_ID,
    workspaceId: WORKSPACE_ID,
    restaurantId: RESTAURANT_ID,
    branchId: BRANCH_ID,
    customerPhoneNumber: '+234 800 000 0000',
    customerPhoneNumberNormalized: '2348000000000',
    customerName: 'Ada Customer',
    status: WhatsappConversationStatus.WaitingForStaff,
    source: WhatsappConversationSource.Whatsapp,
    checkoutSessionId: null,
    checkoutSessionCode: null,
    orderId: null,
    lastMessageText: 'I need help',
    lastMessageAt: NOW,
    lastInboundAt: NOW,
    lastOutboundAt: null,
    state: WhatsappConversationState.New,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as WhatsappConversationDocument;
}

function createCheckoutSessionDocument(
  overrides: Partial<CheckoutSessionDocument> = {},
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
    subtotalMinorUnit: 0,
    serviceChargeMinorUnit: 0,
    taxMinorUnit: 0,
    deliveryFeeMinorUnit: 0,
    discountMinorUnit: 0,
    totalMinorUnit: 0,
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
    ...overrides,
  } as unknown as CheckoutSessionDocument;
}

function createOutboundMessageDocument(
  overrides:
    | Partial<WhatsappOutboundMessageDocument>
    | Record<string, unknown> = {},
): WhatsappOutboundMessageDocument {
  return {
    _id: new Types.ObjectId(OUTBOUND_MESSAGE_ID),
    workspaceId: WORKSPACE_ID,
    restaurantId: RESTAURANT_ID,
    branchId: BRANCH_ID,
    conversationId: CONVERSATION_ID,
    checkoutSessionId: null,
    orderId: null,
    toPhoneNumber: '+234 800 000 0000',
    toPhoneNumberNormalized: '2348000000000',
    messageType: WhatsappOutboundMessageType.Text,
    text: 'Thanks, we are checking this now.',
    payload: {},
    status: WhatsappOutboundMessageStatus.Queued,
    attemptCount: 0,
    maxAttempts: 3,
    nextAttemptAt: NOW,
    sentAt: null,
    failedAt: null,
    failureReason: null,
    idempotencyKeyHash: 'idempotency_hash',
    providerMessageId: null,
    createdByUserId: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as WhatsappOutboundMessageDocument;
}

function createAuth(): AuthenticatedUserContext {
  return {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRole: 'owner',
    permissions: [],
    sessionId: 'session_123',
    tokenId: 'token_123',
    requestId: 'request_123',
    ipAddress: '127.0.0.1',
    userAgent: 'jest',
    user: {
      id: USER_ID,
    },
  } as unknown as AuthenticatedUserContext;
}

function createMetaPayload(input: {
  id: string;
  text?: string;
  timestamp?: string;
  messageType?: string;
}): Record<string, unknown> {
  const messageType = input.messageType ?? 'text';
  const message: Record<string, unknown> = {
    id: input.id,
    from: '2348000000000',
    type: messageType,
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
  };
  if (messageType === 'text') {
    message.text = {
      body: input.text ?? '',
    };
  }

  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'business_account_1',
        changes: [
          {
            value: {
              metadata: {
                display_phone_number: '+234 801 234 5678',
                phone_number_id: 'phone_number_id_1',
              },
              contacts: [
                {
                  wa_id: '2348000000000',
                  profile: {
                    name: 'Ada Customer',
                  },
                },
              ],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

function createMetaStatusPayload(input: {
  id: string;
  status: string;
  timestamp?: string;
  recipientId?: string;
  errorMessage?: string;
}): Record<string, unknown> {
  const status: Record<string, unknown> = {
    id: input.id,
    status: input.status,
    recipient_id: input.recipientId ?? '2348000000000',
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
  };
  if (input.errorMessage) {
    status.errors = [
      {
        code: '131000',
        title: 'Provider error',
        message: input.errorMessage,
      },
    ];
  }

  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'business_account_1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: {
                display_phone_number: '+234 801 234 5678',
                phone_number_id: 'phone_number_id_1',
              },
              statuses: [status],
            },
          },
        ],
      },
    ],
  };
}

function hasSchemaIndex(
  schema: {
    indexes(): Array<[Record<string, unknown>, Record<string, unknown>]>;
  },
  fields: Record<string, unknown>,
  optionsPredicate: (options: Record<string, unknown>) => boolean = () => true,
): boolean {
  return schema.indexes().some(([indexFields, indexOptions]) => {
    return (
      JSON.stringify(indexFields) === JSON.stringify(fields) &&
      optionsPredicate(indexOptions)
    );
  });
}

function getUpdateSet(
  update: Record<string, unknown>,
): Record<string, unknown> {
  const set = update.$set;

  return isRecord(set) ? set : {};
}

function getUpdateSetOnInsert(
  update: Record<string, unknown>,
): Record<string, unknown> {
  const setOnInsert = update.$setOnInsert;

  return isRecord(setOnInsert) ? setOnInsert : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
