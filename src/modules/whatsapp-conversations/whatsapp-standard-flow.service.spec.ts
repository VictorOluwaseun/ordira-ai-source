import type { BranchOperationsService } from '@modules/branch-operations/branch-operations.service';
import { buildWhatsappBudgetCombinations } from './whatsapp-budget-combinations.util';
import type { WhatsappBudgetSuggestionsService } from './whatsapp-budget-suggestions.service';
import { createBudgetMenuItem } from './testing/budget-menu-item.fixture';
import type { WhatsappBudgetQuoteService } from './whatsapp-budget-quote.service';
import { NotFoundException } from '@nestjs/common';
import type { StorefrontMenuItemSearchService } from '@modules/storefront-search/storefront-menu-item-search.service';
import { Types, type Model } from 'mongoose';
import { CheckoutSession } from '@modules/checkout-sessions/schemas/checkout-session.schema';
import { PlatformCustomerIdentity } from '@modules/customers/schemas/platform-customer-identity.schema';
import {
  Order,
  type OrderItemSnapshot,
} from '@modules/orders/schemas/order.schema';
import type { CheckoutSessionsService } from '@modules/checkout-sessions/checkout-sessions.service';
import type { OrderAccessService } from '@modules/order-access/order-access.service';
import type { PublicStorefrontService } from '@modules/public-storefront/public-storefront.service';
import { WhatsappChannelMode } from '@modules/whatsapp-connections/schemas/whatsapp-channel.schema';
import {
  WhatsappConversation,
  WhatsappConversationSource,
  WhatsappConversationState,
  WhatsappConversationStatus,
  type WhatsappConversationRecord,
} from './schemas/whatsapp-conversation.schema';
import { WhatsappInboundEvent } from './schemas/whatsapp-inbound-event.schema';
import {
  WhatsappOutboundMessage,
  WhatsappOutboundMessageStatus,
} from './schemas/whatsapp-outbound-message.schema';
import type { WhatsappOutboundContent } from './types/whatsapp-outbound-content.type';
import { WhatsappConversationsRepository } from './whatsapp-conversations.repository';
import {
  WhatsappStandardFlowActionKey,
  createBranchSelectActionId,
  createOrderSelectActionId,
  createMealSelectActionId,
  parseWhatsappStandardFlowActionId,
} from './whatsapp-standard-flow-action-registry';
import { WhatsappStandardFlowService } from './whatsapp-standard-flow.service';

describe('WhatsappStandardFlowService', () => {
  it('asks whether a group budget is total or per person before searching', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    await h.service.processInbound({
      conversation: createConversation(),
      inboundEventId: 'group',
      text: '₦5,000 for two people',
    });
    expect(messages[0]?.content).toMatchObject({
      type: 'reply_buttons',
      buttons: [
        { id: WhatsappStandardFlowActionKey.BudgetTotal },
        { id: WhatsappStandardFlowActionKey.BudgetPerPerson },
      ],
    });
    expect(h.publicStorefrontService.search).not.toHaveBeenCalled();
    await h.service.processInbound({
      conversation: createConversation({
        metadata: {
          standardFlow: {
            pendingAssist: {
              kind: 'group_budget',
              amount: 500000,
              people: 2,
              expiresAt: Date.now() + 10000,
            },
          },
        },
      }),
      inboundEventId: 'person',
      text: 'per person',
    });
    expect(JSON.stringify(messages)).toContain('10,000.00');
    expect(JSON.stringify(messages)).toContain('not a guarantee');
  });

  it.each(['the second one', 'that looks good'])(
    'resolves or clarifies the meal reference %s without placing an order',
    async (text) => {
      const messages: SavedOutboundMessage[] = [];
      const h = createService(messages);
      await h.service.processInbound({
        conversation: createConversation({
          state: WhatsappConversationState.StorefrontHandoff,
          metadata: {
            standardFlow: {
              discovery: {
                expiresAt: Date.now() + 10000,
                menuUrl: 'https://store.ordira.test/menu',
                suggestions: [
                  {
                    label: 'Rice + Chicken — NGN 4,000',
                    totalMinorUnit: 400000,
                  },
                  { label: 'Yam + Fish — NGN 3,500', totalMinorUnit: 350000 },
                ],
              },
            },
          },
        }),
        inboundEventId: 'select-meal',
        text,
      });
      expect(messages[0]?.content).toMatchObject(
        text === 'the second one'
          ? {
              type: 'cta_url',
              body: expect.stringContaining('Yam + Fish') as unknown,
            }
          : {
              type: 'reply_buttons',
              body: expect.stringContaining('Which meal') as unknown,
            },
      );
      expect(
        h.checkoutSessionsService.createWhatsappStandardDraftCheckoutSession,
      ).not.toHaveBeenCalled();
      expect(
        h.checkoutSessionsService.createWhatsappReorderDraft,
      ).not.toHaveBeenCalled();
    },
  );

  it('rejects expired suggestions instead of acting on an old meal', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    await h.service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.StorefrontHandoff,
        metadata: {
          standardFlow: {
            discovery: { expiresAt: 0, suggestions: [{ label: 'Old meal' }] },
          },
        },
      }),
      inboundEventId: 'expired-meal',
      text: 'the first one',
    });
    expect(JSON.stringify(messages)).toContain('expired');
  });

  it.each([2, 5])(
    'answers a generated %i-meal question with a direct menu link',
    async (count) => {
      const messages: SavedOutboundMessage[] = [];
      const h = createService(messages);
      const discovery = {
        expiresAt: Date.now() + 60_000,
        menuUrl: 'https://store.ordira.test/menu',
        suggestions: Array.from({ length: count }, (_, index) => ({
          label: `Meal ${index + 1} — ₦4,000`,
        })),
      };
      await h.service.processInbound({
        conversation: createConversation({
          state: WhatsappConversationState.StorefrontHandoff,
          metadata: { standardFlow: { discovery } },
        }),
        inboundEventId: 'ask-meal',
        text: 'that one',
      });
      const question = messages[0]?.content;
      const choices =
        question?.type === 'reply_buttons'
          ? question.buttons
          : question?.type === 'list'
            ? question.sections.flatMap((section) => section.rows)
            : [];
      expect(choices).toHaveLength(count);
      expect(question?.type).toBe(count <= 3 ? 'reply_buttons' : 'list');
      const stored = h.conversationModel.findOneAndUpdate.mock.calls
        .map(
          ([, update]) =>
            getUpdateSet(update)['metadata.standardFlow.mealQuestion'],
        )
        .find(isRecord);
      expect(stored?.expiresAt).toBe(discovery.expiresAt);
      expect(
        parseWhatsappStandardFlowActionId(choices[count - 1].id),
      ).toMatchObject({
        type: 'meal_select',
        questionId: stored?.id,
        index: count - 1,
      });
      await h.service.processInbound({
        conversation: createConversation({
          state: WhatsappConversationState.StorefrontHandoff,
          metadata: { standardFlow: { discovery, mealQuestion: stored } },
        }),
        inboundEventId: 'answer-meal',
        interactionId: choices[count - 1].id,
      });
      expect(messages.at(-1)?.content).toMatchObject({
        type: 'cta_url',
        url: discovery.menuUrl,
        body: expect.stringContaining(`Meal ${count}`) as unknown,
      });
      expect(
        h.checkoutSessionsService.createWhatsappStandardDraftCheckoutSession,
      ).not.toHaveBeenCalled();
      expect(
        h.checkoutSessionsService.createWhatsappReorderDraft,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    'expired',
    'another-question',
    'new-discovery',
    'wrong-state',
    'missing-question',
  ])(
    'rejects a %s meal button without selecting or changing a basket',
    async (reason) => {
      const messages: SavedOutboundMessage[] = [];
      const h = createService(messages);
      const id = '00000000-0000-4000-8000-000000000001';
      const expiresAt = Date.now() + 60_000;
      await h.service.processInbound({
        conversation: createConversation({
          state:
            reason === 'wrong-state'
              ? WhatsappConversationState.PlatformHome
              : WhatsappConversationState.StorefrontHandoff,
          metadata: {
            standardFlow: {
              discovery: {
                expiresAt,
                menuUrl: 'https://store.ordira.test/menu',
                suggestions: [{ label: 'Rice' }],
              },
              mealQuestion:
                reason === 'missing-question'
                  ? null
                  : {
                      id: reason === 'another-question' ? 'different' : id,
                      expiresAt: reason === 'expired' ? 0 : expiresAt,
                      discoveryExpiresAt:
                        reason === 'new-discovery' ? expiresAt - 1 : expiresAt,
                    },
            },
          },
        }),
        inboundEventId: 'old-button',
        interactionId: createMealSelectActionId(id, 0),
      });
      expect(messages[0]?.content).toMatchObject({
        type: 'text',
        text: expect.stringContaining('no longer current') as unknown,
      });
      expect(
        JSON.stringify(h.conversationModel.findOneAndUpdate.mock.calls),
      ).not.toContain('discovery.selectedIndex');
      expect(
        h.checkoutSessionsService.createWhatsappStandardDraftCheckoutSession,
      ).not.toHaveBeenCalled();
    },
  );

  it('keeps the restaurant and food when looking for cheaper options', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    h.publicStorefrontService.findBranchProfile.mockResolvedValue({
      branch: createBranchCard(),
    } as never);
    h.budgetQuoteService.resolve.mockResolvedValue({
      maxPriceMinorUnit: 349999,
      minPriceMinorUnit: 0,
      deliveryFeeMinorUnit: 0,
      settings: { currency: 'NGN' },
    });
    h.menuItemSearchService.search.mockResolvedValue({
      data: [],
      meta: {},
    } as never);
    h.checkoutSessionsService.createWhatsappStandardDraftCheckoutSession.mockResolvedValue(
      createCheckoutSessionResponse(),
    );
    await h.service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.StorefrontHandoff,
        metadata: {
          standardFlow: {
            discovery: {
              expiresAt: Date.now() + 10000,
              branch: createBranchCandidate(),
              itemQuery: 'rice',
              currency: 'NGN',
              suggestions: [{ label: 'Rice', totalMinorUnit: 350000 }],
            },
          },
        },
      }),
      inboundEventId: 'cheaper',
      text: 'something cheaper',
    });
    expect(h.menuItemSearchService.search).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'rice', maxPriceMinorUnit: 349999 }),
      expect.objectContaining({ branchId: 'branch_123' }),
    );
    expect(JSON.stringify(messages)).toContain("couldn't build a meal");
  });

  it('substitutes a discovery preference without changing an order', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    await h.service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.AwaitingOrderEntryChoice,
        metadata: { standardFlow: { itemQuery: 'rice and chicken' } },
      }),
      inboundEventId: 'substitution',
      text: 'No chicken—fish instead',
    });
    expect(JSON.stringify(messages)).toContain('rice and fish');
    expect(
      h.checkoutSessionsService.createWhatsappReorderDraft,
    ).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'checks the current checkout before historical orders (paid=%s)',
    async (paid) => {
      const messages: SavedOutboundMessage[] = [];
      const h = createService(messages);
      h.checkoutSessionsService.getConversationCheckoutPaymentStatus.mockResolvedValue(
        { paid, orderId: null },
      );
      await h.service.processInbound({
        conversation: createConversation({
          state: WhatsappConversationState.StorefrontHandoff,
          checkoutSessionId: '66f000000000000000000099',
        }),
        inboundEventId: 'checkout-paid-assist',
        text: 'I paid already',
      });
      expect(JSON.stringify(messages)).toContain(
        paid ? 'payment is recorded' : 'current checkout is not confirmed',
      );
      expect(h.orderModel.find).not.toHaveBeenCalled();
      expect(
        h.checkoutSessionsService.createWhatsappReorderDraft,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['I paid already', 'not confirmed'],
    ['How long will it take?', 'no confirmed live arrival'],
    ['Add another chicken to my order', 'restaurant approval'],
  ])('reads the owned selected order for %s', async (text, expected) => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    h.orderModel.findOne.mockReturnValue(createQuery(createOrderDocument()));
    await h.service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.ViewingOrder,
        metadata: { standardFlow: { selectedOrder: createOrderCandidate() } },
      }),
      inboundEventId: 'order-assist',
      text,
    });
    expect(JSON.stringify(messages)).toContain(expected);
    expect(h.orderModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        'customerSnapshot.phoneNumber': expect.objectContaining({
          $in: expect.arrayContaining(['2348000000000']) as unknown,
        }) as unknown,
      }),
    );
    expect(
      h.orderAccessService.createWhatsappMagicLinkForVerifiedOrder,
    ).not.toHaveBeenCalled();
  });

  it('asks which active order instead of guessing when there are several', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    h.orderModel.find.mockImplementation(() =>
      createOrderFindQuery([
        createOrderDocument(),
        {
          ...createOrderDocument(),
          _id: new Types.ObjectId('66f000000000000000000102'),
          publicCode: 'ORD-SECOND',
        },
      ]),
    );
    await h.service.processInbound({
      conversation: createConversation(),
      inboundEventId: 'multiple',
      text: 'Where is my food?',
    });
    expect(messages[0]?.content.type).toBe('list');
    expect(
      JSON.stringify(h.conversationModel.findOneAndUpdate.mock.calls),
    ).toContain('pendingAssist');
  });

  it.each(["I'm allergic to peanuts", 'Not spicy'])(
    'does not claim a dietary preference was applied: %s',
    async (text) => {
      const messages: SavedOutboundMessage[] = [];
      const h = createService(messages);
      await h.service.processInbound({
        conversation: createConversation(),
        inboundEventId: 'dietary',
        text,
      });
      expect(JSON.stringify(messages)).toContain(
        text.includes('allergic') ? 'cross-contact' : 'not been applied',
      );
      expect(
        h.checkoutSessionsService.createWhatsappStandardDraftCheckoutSession,
      ).not.toHaveBeenCalled();
    },
  );

  it('continues a preference clarification against the selected meal’s current options', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    h.findPreferenceChoices.mockResolvedValue(['Spice level: Mild']);
    await h.service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.StorefrontHandoff,
        metadata: {
          standardFlow: {
            foodPreference: {
              text: 'not spicy',
              awaitingMeal: true,
              allergy: false,
              expiresAt: Date.now() + 10000,
            },
            discovery: {
              branch: createBranchCandidate(),
              menuUrl: 'https://store.ordira.test/menu',
              expiresAt: Date.now() + 10000,
              suggestions: [
                { label: 'Rice', menuItemId: 'rice' },
                { label: 'Yam', menuItemId: 'yam' },
              ],
            },
          },
        },
      }),
      inboundEventId: 'preference-choice',
      text: 'the second one',
    });
    expect(h.findPreferenceChoices).toHaveBeenCalledWith(
      createBranchCandidate(),
      'yam',
      'not spicy',
    );
    expect(messages[0]?.content).toMatchObject({
      type: 'cta_url',
      body: expect.stringContaining('Spice level: Mild') as unknown,
    });
    expect(JSON.stringify(messages)).toContain('not been applied');
  });

  it('asks for a precise pin for the selected branch without selecting delivery', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    await h.service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.StorefrontHandoff,
        metadata: {
          standardFlow: {
            discovery: {
              branch: createBranchCandidate(),
              expiresAt: Date.now() + 10000,
            },
          },
        },
      }),
      inboundEventId: 'coverage',
      text: 'Can they deliver to Lekki?',
    });
    expect(messages[0]?.content).toMatchObject({
      type: 'location_request',
      body: expect.stringContaining('lekki') as unknown,
    });
    expect(
      h.branchOperationsService.getPublicBranchAvailability,
    ).not.toHaveBeenCalled();
    expect(
      h.checkoutSessionsService.createWhatsappStandardDraftCheckoutSession,
    ).not.toHaveBeenCalled();
  });
  it.each([
    ['below_minimum_order', 'Minimum order'],
    ['outside_delivery_zone', 'outside this branch'],
    ['delivery_disabled', 'does not offer delivery'],
    ['branch_closed', 'cannot accept a delivery'],
  ])(
    'uses current delivery rules after the location pin (%s)',
    async (reason, text) => {
      const messages: SavedOutboundMessage[] = [];
      const h = createService(messages);
      h.branchOperationsService.getPublicBranchAvailability.mockResolvedValue({
        delivery: {
          available: false,
          reason,
          zone:
            reason === 'below_minimum_order'
              ? {
                  currency: 'NGN',
                  deliveryFeeMinorUnit: 50000,
                  minimumOrderMinorUnit: 200000,
                }
              : null,
        },
      } as Awaited<
        ReturnType<BranchOperationsService['getPublicBranchAvailability']>
      >);
      const branch = createBranchCandidate();
      await h.service.processInbound({
        conversation: createConversation({
          state: WhatsappConversationState.AwaitingLocation,
          metadata: {
            standardFlow: {
              deliveryCheck: {
                branch,
                area: 'Lekki',
                expiresAt: Date.now() + 10000,
              },
            },
          },
        }),
        inboundEventId: 'pin',
        location: { latitude: 6.4, longitude: 3.5 },
      });
      expect(
        h.branchOperationsService.getPublicBranchAvailability,
      ).toHaveBeenCalledWith(
        branch.workspaceSlug,
        branch.restaurantSlug,
        branch.branchSlug,
        expect.objectContaining({
          latitude: 6.4,
          longitude: 3.5,
          orderValueMinorUnit: 0,
        }),
      );
      expect(JSON.stringify(messages)).toContain(text);
      expect(
        h.checkoutSessionsService.createWhatsappStandardDraftCheckoutSession,
      ).not.toHaveBeenCalled();
    },
  );
  it('asks which restaurant when a delivery enquiry has no current branch', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    await h.service.processInbound({
      conversation: createConversation(),
      inboundEventId: 'coverage-no-branch',
      text: 'Dem fit deliver to Lekki?',
    });
    expect(JSON.stringify(messages)).toContain('Which restaurant');
    expect(
      JSON.stringify(h.conversationModel.findOneAndUpdate.mock.calls),
    ).toContain('deliveryCheck');
  });

  it('keeps a delivery enquiry through branch selection instead of opening a new basket', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    const branch = createBranchCandidate();
    await h.service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.AwaitingBranchSelection,
        metadata: {
          standardFlow: {
            branchCandidates: [branch],
            deliveryCheck: { area: 'Lekki', expiresAt: Date.now() + 10000 },
          },
        },
      }),
      inboundEventId: 'delivery-branch',
      interactionId: `branch.select:${branch.branchId}`,
    });
    expect(messages[0]?.content).toMatchObject({ type: 'location_request' });
    expect(
      h.checkoutSessionsService.createWhatsappStandardDraftCheckoutSession,
    ).not.toHaveBeenCalled();
  });
  it('does not reuse a delivery enquiry after its question expires', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    await h.service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.AwaitingLocation,
        metadata: {
          standardFlow: {
            deliveryCheck: { branch: createBranchCandidate(), expiresAt: 0 },
          },
        },
      }),
      inboundEventId: 'expired-pin',
      location: { latitude: 6.4, longitude: 3.5 },
    });
    expect(JSON.stringify(messages)).toContain('expired');
    expect(
      h.branchOperationsService.getPublicBranchAvailability,
    ).not.toHaveBeenCalled();
  });
  it('records a request for staff review without promising an agent response time', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    await h.service.processInbound({
      conversation: createConversation(),
      inboundEventId: 'staff',
      text: 'Someone should help me',
    });
    expect(
      JSON.stringify(h.conversationModel.findOneAndUpdate.mock.calls),
    ).toContain('waiting_for_staff');
    expect(JSON.stringify(messages)).toContain(
      'don’t have a confirmed response time',
    );
    expect(h.orderModel.find).not.toHaveBeenCalled();
  });

  it('requires review intent before creating a new reorder draft', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    h.orderModel.find.mockReturnValue(
      createOrderFindQuery([{ ...createOrderDocument(), status: 'completed' }]),
    );
    await h.service.processInbound({
      conversation: createConversation(),
      inboundEventId: 'repeat',
      text: 'Same as last time',
    });
    expect(messages[0]?.content).toMatchObject({
      type: 'reply_buttons',
      buttons: [
        { id: WhatsappStandardFlowActionKey.RepeatDraft },
        { id: WhatsappStandardFlowActionKey.NavigationHome },
      ],
    });
    expect(
      h.checkoutSessionsService.createWhatsappReorderDraft,
    ).not.toHaveBeenCalled();
    h.orderModel.findOne.mockReturnValue(createQuery(createOrderDocument()));
    h.checkoutSessionsService.createWhatsappReorderDraft.mockResolvedValue(
      createCheckoutSessionResponse(),
    );
    await h.service.processInbound({
      conversation: createConversation({
        metadata: {
          standardFlow: {
            pendingAssist: {
              kind: 'reorder',
              orderId: createOrderCandidate().orderId,
              expiresAt: Date.now() + 10000,
            },
          },
        },
      }),
      inboundEventId: 'repeat-draft',
      interactionId: WhatsappStandardFlowActionKey.RepeatDraft,
    });
    expect(
      h.checkoutSessionsService.createWhatsappReorderDraft,
    ).toHaveBeenCalledTimes(1);
    expect(messages.at(-1)?.content).toMatchObject({
      type: 'cta_url',
      displayText: 'Review new order',
    });
  });

  it('does not copy another customer’s order from a pending action', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    h.orderModel.findOne.mockReturnValue(createQuery(null));
    await h.service.processInbound({
      conversation: createConversation({
        metadata: {
          standardFlow: {
            pendingAssist: {
              kind: 'reorder',
              orderId: '66f000000000000000000999',
              expiresAt: Date.now() + 10000,
            },
          },
        },
      }),
      inboundEventId: 'foreign-repeat',
      interactionId: WhatsappStandardFlowActionKey.RepeatDraft,
    });
    expect(
      h.checkoutSessionsService.createWhatsappReorderDraft,
    ).not.toHaveBeenCalled();
    expect(JSON.stringify(messages)).toContain('couldn’t find');
  });

  it.each(['restaurant', 'nearby'])(
    'keeps the food request through the %s path',
    async (route) => {
      const messages: SavedOutboundMessage[] = [];
      const h = createService(messages);
      let conversation = createConversation({
        state: WhatsappConversationState.PlatformHome,
      });
      const advance = (state: WhatsappConversationState) => {
        const set = getUpdateSetByState(
          h.conversationModel.findOneAndUpdate,
          state,
        );
        const standardFlow = {
          ...((conversation.metadata.standardFlow as Record<string, unknown>) ??
            {}),
        };
        for (const [key, value] of Object.entries(set)) {
          if (key.startsWith('metadata.standardFlow.'))
            standardFlow[key.slice('metadata.standardFlow.'.length)] = value;
        }
        conversation = {
          ...conversation,
          state,
          metadata: { ...conversation.metadata, standardFlow },
        };
      };
      await h.service.processInbound({
        conversation,
        inboundEventId: 'craving',
        text: 'I want some rice and chicken',
      });
      expect(messages[0]?.content).toMatchObject({
        type: 'reply_buttons',
        body: expect.stringContaining('restaurant in mind') as unknown,
        buttons: [
          {
            id: WhatsappStandardFlowActionKey.OrderEntryNearby,
            title: '📍 Choose location',
          },
          {
            id: WhatsappStandardFlowActionKey.OrderEntrySearch,
            title: 'I have one in mind',
          },
        ],
      });
      advance(WhatsappConversationState.AwaitingOrderEntryChoice);
      expect(conversation.metadata.standardFlow).toMatchObject({
        itemQuery: 'rice and chicken',
      });
      await h.service.processInbound({
        conversation,
        inboundEventId: 'scope',
        text: route === 'restaurant' ? 'I have one in mind' : 'Choose location',
      });
      advance(
        route === 'restaurant'
          ? WhatsappConversationState.AwaitingRestaurantSearch
          : WhatsappConversationState.AwaitingLocation,
      );
      expect(conversation.metadata.standardFlow).toMatchObject({
        itemQuery: 'rice and chicken',
      });
      if (route === 'restaurant') {
        h.publicStorefrontService.search.mockResolvedValue({
          data: [
            {
              restaurantId: 'restaurant_123',
              workspaceSlug: 'ordira',
              restaurantSlug: 'mama-tee',
            },
          ],
          meta: {},
        } as never);
        h.publicStorefrontService.findRestaurantProfile.mockResolvedValue({
          branches: [createBranchCard()],
        } as never);
        await h.service.processInbound({
          conversation,
          inboundEventId: 'restaurant',
          text: 'Mama Tee',
        });
        expect(h.publicStorefrontService.search).toHaveBeenCalledWith(
          expect.objectContaining({ q: 'Mama Tee' }),
        );
      } else {
        h.publicStorefrontService.nearbyBranches.mockResolvedValue({
          data: [createBranchCard()],
        } as never);
        await h.service.processInbound({
          conversation,
          inboundEventId: 'location',
          location: { latitude: 6.4, longitude: 3.4 },
        });
        expect(messages.at(-1)?.content).toHaveProperty(
          'body',
          expect.stringContaining('rice and chicken'),
        );
      }
      advance(WhatsappConversationState.AwaitingBranchSelection);
      expect(conversation.metadata.standardFlow).toMatchObject({
        itemQuery: 'rice and chicken',
      });
      h.publicStorefrontService.findBranchProfile.mockResolvedValue({
        branch: createBranchCard(),
      } as never);
      h.menuItemSearchService.search.mockResolvedValue({
        data: [],
        meta: {},
      } as never);
      h.checkoutSessionsService.createWhatsappStandardDraftCheckoutSession.mockResolvedValue(
        createCheckoutSessionResponse(),
      );
      await h.service.processInbound({
        conversation,
        inboundEventId: 'branch',
        interactionId: 'branch.select:branch_123',
      });
      expect(h.menuItemSearchService.search).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'rice and chicken' }),
        expect.objectContaining({ branchId: 'branch_123' }),
      );
      expect(messages.at(-1)?.content).toMatchObject({
        type: 'cta_url',
        displayText: 'Open menu',
      });
    },
  );

  it('offers restaurant or location choices for an AI-interpreted food request', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    await h.service.processInbound({
      conversation: createConversation(),
      inboundEventId: 'ai-food',
      interactionId: WhatsappStandardFlowActionKey.OrderEntrySearch,
      restaurantSearch: { itemQuery: 'rice and chicken' },
    });
    expect(messages[0]?.content).toMatchObject({
      type: 'reply_buttons',
      body: expect.stringContaining('rice and chicken') as unknown,
    });
  });

  const budget = {
    maxPriceMinorUnit: 500000,
    currency: 'NGN' as const,
    includesDelivery: false,
  };
  it('asks where to search when a budget has no selected branch', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    await h.service.processInbound({
      conversation: createConversation(),
      inboundEventId: 'budget-new',
      text: 'What food can I get for N5000?',
    });
    expect(messages[0]?.content).toMatchObject({
      type: 'reply_buttons',
      body: expect.stringContaining('5,000.00') as unknown,
      buttons: [{ id: WhatsappStandardFlowActionKey.OrderEntryNearby }],
    });
    expect(
      getUpdateSetByState(
        h.conversationModel.findOneAndUpdate,
        WhatsappConversationState.AwaitingRestaurantSearch,
      ),
    ).toMatchObject({ 'metadata.standardFlow.budgetSearch': { budget } });
    expect(h.menuItemSearchService.search).not.toHaveBeenCalled();
  });

  it('asks for a restaurant even when a previous menu branch was selected', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    await h.service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.StorefrontHandoff,
        metadata: { standardFlow: { storefront: createBranchCandidate() } },
      }),
      inboundEventId: 'budget-selected',
      text: 'What can I get for 5,000?',
    });
    expect(messages[0]?.content).toMatchObject({
      type: 'reply_buttons',
      body: expect.stringContaining('Which restaurant') as unknown,
    });
    expect(h.menuItemSearchService.search).not.toHaveBeenCalled();
  });

  it('suggests real food and drink combinations after selecting a restaurant branch', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    h.publicStorefrontService.findBranchProfile.mockResolvedValue({
      branch: createBranchCard(),
    } as never);
    h.budgetQuoteService.resolve.mockResolvedValue({
      maxPriceMinorUnit: 500000,
      minPriceMinorUnit: 0,
      deliveryFeeMinorUnit: 0,
      settings: { currency: 'NGN' },
    });
    h.menuItemSearchService.search
      .mockResolvedValueOnce({
        data: [createBudgetMenuItem('Rice', 350000)],
        meta: {},
      } as never)
      .mockResolvedValueOnce({
        data: [createBudgetMenuItem('Orange juice', 100000, true)],
        meta: {},
      } as never);
    h.checkoutSessionsService.createWhatsappStandardDraftCheckoutSession.mockResolvedValue(
      createCheckoutSessionResponse(),
    );
    await h.service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.AwaitingBranchSelection,
        metadata: {
          standardFlow: {
            branchCandidates: [createBranchCandidate()],
            itemQuery: 'rice',
            budgetSearch: { budget, itemQuery: 'rice' },
          },
        },
      }),
      inboundEventId: 'budget-branch',
      interactionId: 'branch.select:branch_123',
    });
    expect(h.menuItemSearchService.search).toHaveBeenCalledWith(
      {
        q: 'rice',
        maxPriceMinorUnit: 500000,
        limit: 50,
        includeUnavailable: false,
        sort: 'price_asc',
      },
      {
        branchId: 'branch_123',
        restaurantId: 'restaurant_123',
        currency: 'NGN',
        itemKind: 'food',
      },
    );
    expect(h.menuItemSearchService.search).toHaveBeenCalledWith(
      {
        maxPriceMinorUnit: 500000,
        limit: 50,
        includeUnavailable: false,
        sort: 'price_asc',
      },
      {
        branchId: 'branch_123',
        restaurantId: 'restaurant_123',
        currency: 'NGN',
        itemKind: 'drink',
      },
    );
    expect(messages[0]?.content).toMatchObject({
      type: 'cta_url',
      displayText: 'Open menu',
      body: expect.stringContaining('1 × Rice\n1 × Orange juice') as unknown,
    });
    expect(messages[0]?.content).toHaveProperty(
      'body',
      expect.stringContaining('₦4,500.00 total'),
    );
  });

  it.each([
    WhatsappStandardFlowActionKey.OrderEntrySearch,
    WhatsappStandardFlowActionKey.OrderEntryNearby,
  ])('keeps the budget through scope button %s', async (action) => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    await h.service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.AwaitingOrderEntryChoice,
        metadata: { standardFlow: { budgetSearch: { budget } } },
      }),
      inboundEventId: 'budget-scope-button',
      interactionId: action,
    });
    expect(
      getUpdateSetByState(
        h.conversationModel.findOneAndUpdate,
        action === WhatsappStandardFlowActionKey.OrderEntrySearch
          ? WhatsappConversationState.AwaitingRestaurantSearch
          : WhatsappConversationState.AwaitingLocation,
      ),
    ).toMatchObject({ 'metadata.standardFlow.budgetSearch': { budget } });
  });

  it('carries a budget and customer location through nearby branch selection', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    h.publicStorefrontService.nearbyBranches.mockResolvedValue({
      data: [createBranchCard()],
    } as never);
    await h.service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.AwaitingLocation,
        metadata: {
          standardFlow: {
            budgetSearch: { budget: { ...budget, includesDelivery: true } },
          },
        },
      }),
      inboundEventId: 'budget-nearby',
      location: { latitude: 6.4, longitude: 3.4 },
    });
    expect(
      getUpdateSetByState(
        h.conversationModel.findOneAndUpdate,
        WhatsappConversationState.AwaitingBranchSelection,
      ),
    ).toMatchObject({
      'metadata.standardFlow.budgetSearch': {
        budget: { ...budget, includesDelivery: true },
      },
      'metadata.standardFlow.budgetLocation': { latitude: 6.4, longitude: 3.4 },
    });
  });

  it('retains the budget when a restaurant name answers the search prompt', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    h.publicStorefrontService.search.mockResolvedValue({
      data: [
        {
          restaurantId: 'restaurant_123',
          workspaceSlug: 'ordira',
          restaurantSlug: 'mama-tee',
        },
      ],
      meta: {},
    } as never);
    h.publicStorefrontService.findRestaurantProfile.mockResolvedValue({
      branches: [createBranchCard()],
    } as never);
    await h.service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.AwaitingRestaurantSearch,
        metadata: { standardFlow: { budgetSearch: { budget } } },
      }),
      inboundEventId: 'budget-name',
      text: 'Mama Tee',
    });
    expect(
      getUpdateSetByState(
        h.conversationModel.findOneAndUpdate,
        WhatsappConversationState.AwaitingBranchSelection,
      ),
    ).toMatchObject({
      'metadata.standardFlow.budgetSearch': expect.objectContaining({
        budget,
      }) as unknown,
    });
  });

  it('asks for a delivery location before offering delivered budget estimates', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    h.publicStorefrontService.findBranchProfile.mockResolvedValue({
      branch: createBranchCard(),
    } as never);
    await h.service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.AwaitingBranchSelection,
        metadata: {
          standardFlow: {
            branchCandidates: [createBranchCandidate()],
            budgetSearch: { budget: { ...budget, includesDelivery: true } },
          },
        },
      }),
      inboundEventId: 'budget-location',
      interactionId: 'branch.select:branch_123',
    });
    expect(messages[0]?.content).toMatchObject({ type: 'location_request' });
    expect(h.menuItemSearchService.search).not.toHaveBeenCalled();
    expect(
      h.checkoutSessionsService.createWhatsappStandardDraftCheckoutSession,
    ).not.toHaveBeenCalled();
    expect(
      getUpdateSetByState(
        h.conversationModel.findOneAndUpdate,
        WhatsappConversationState.AwaitingLocation,
      ),
    ).toMatchObject({
      'metadata.standardFlow.budgetBranch': expect.objectContaining({
        branchId: 'branch_123',
      }) as unknown,
    });
  });

  it('resumes a selected branch after location and includes fees in displayed estimates', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    h.publicStorefrontService.findBranchProfile.mockResolvedValue({
      branch: createBranchCard(),
    } as never);
    h.budgetQuoteService.resolve.mockResolvedValue({
      maxPriceMinorUnit: 350000,
      minPriceMinorUnit: 100000,
      deliveryFeeMinorUnit: 100000,
      settings: {
        currency: 'NGN',
        serviceChargeEnabled: true,
        serviceChargePercent: 10,
      },
    } as never);
    h.menuItemSearchService.search
      .mockResolvedValueOnce({
        data: [createBudgetMenuItem('Rice', 300000)],
        meta: {},
      } as never)
      .mockResolvedValueOnce({
        data: [createBudgetMenuItem('Water', 50000, true)],
        meta: {},
      } as never);
    h.checkoutSessionsService.createWhatsappStandardDraftCheckoutSession.mockResolvedValue(
      createCheckoutSessionResponse(),
    );
    await h.service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.AwaitingLocation,
        metadata: {
          standardFlow: {
            budgetBranch: createBranchCandidate(),
            budgetSearch: { budget: { ...budget, includesDelivery: true } },
          },
        },
      }),
      inboundEventId: 'budget-delivered',
      location: { latitude: 6.4, longitude: 3.4 },
    });
    expect(h.budgetQuoteService.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        latitude: 6.4,
        longitude: 3.4,
        branchId: 'branch_123',
      }),
    );
    expect(h.menuItemSearchService.search).toHaveBeenCalledWith(
      {
        maxPriceMinorUnit: 350000,
        limit: 50,
        sort: 'price_asc',
        includeUnavailable: false,
      },
      {
        branchId: 'branch_123',
        restaurantId: 'restaurant_123',
        currency: 'NGN',
        itemKind: 'food',
      },
    );
    expect(messages[0]?.content).toMatchObject({
      type: 'cta_url',
      body: expect.stringContaining('₦4,850.00 total') as unknown,
    });
    expect(h.publicStorefrontService.nearbyBranches).not.toHaveBeenCalled();
  });

  it('clears the pending budget when returning home', async () => {
    const messages: SavedOutboundMessage[] = [];
    const h = createService(messages);
    await h.service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.AwaitingOrderEntryChoice,
        metadata: { standardFlow: { budgetSearch: { budget } } },
      }),
      inboundEventId: 'budget-reset',
      text: 'home',
    });
    expect(
      JSON.stringify(h.conversationModel.findOneAndUpdate.mock.calls),
    ).toContain('"metadata.standardFlow.budgetSearch":null');
  });

  it('retains the requested city when expanding a restaurant to its branches', async () => {
    const messages: SavedOutboundMessage[] = [];
    const { service, publicStorefrontService } = createService(messages);
    publicStorefrontService.search.mockResolvedValue({
      data: [
        {
          restaurantId: 'restaurant_123',
          workspaceSlug: 'ordira',
          restaurantSlug: 'mama-tee',
        },
      ],
      meta: {},
    } as never);
    publicStorefrontService.findRestaurantProfile.mockResolvedValue({
      branches: [
        createBranchCard(),
        {
          ...createBranchCard(),
          branchId: 'outside_city',
          address: { city: 'Abuja' },
        },
      ],
    } as never);
    await service.processInbound({
      conversation: createConversation(),
      inboundEventId: 'dish-city',
      interactionId: WhatsappStandardFlowActionKey.OrderEntrySearch,
      restaurantSearch: { q: 'Mama Tee', itemQuery: 'rice', city: 'Lekki' },
    });
    expect(messages[0]?.content).toMatchObject({
      type: 'list',
      sections: [{ rows: [{ id: 'branch.select:branch_123' }] }],
    });
  });

  it('keeps long menu content inside the WhatsApp URL-button body limit', async () => {
    const messages: SavedOutboundMessage[] = [];
    const {
      service,
      publicStorefrontService,
      menuItemSearchService,
      checkoutSessionsService,
    } = createService(messages);
    publicStorefrontService.findBranchProfile.mockResolvedValue({
      branch: {
        ...createBranchCard(),
        restaurantName: 'R'.repeat(160),
        branchName: 'B'.repeat(160),
      },
    } as never);
    menuItemSearchService.search.mockResolvedValue({
      data: Array.from({ length: 5 }, () => ({
        name: 'D'.repeat(160),
        basePriceMinorUnit: Number.MAX_SAFE_INTEGER,
        currency: 'NGN',
      })),
      meta: { hasNextPage: true },
    } as never);
    checkoutSessionsService.createWhatsappStandardDraftCheckoutSession.mockResolvedValue(
      createCheckoutSessionResponse(),
    );
    await service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.AwaitingBranchSelection,
        metadata: {
          standardFlow: {
            branchCandidates: [createBranchCandidate()],
            itemQuery: 'r'.repeat(120),
          },
        },
      }),
      inboundEventId: 'long-menu',
      interactionId: 'branch.select:branch_123',
    });
    const content = messages[0]?.content;
    if (content?.type !== 'cta_url') throw new Error('Expected URL button');
    expect(content.body.length).toBeLessThanOrEqual(1024);
    expect(content.body).toContain('More options');
  });

  it('keeps the dish while asking which real restaurant/branch the customer means', async () => {
    const messages: SavedOutboundMessage[] = [];
    const {
      service,
      publicStorefrontService,
      checkoutSessionsService,
      conversationModel,
    } = createService(messages);
    publicStorefrontService.search.mockResolvedValue({
      data: [
        {
          restaurantId: 'restaurant_123',
          workspaceSlug: 'ordira',
          restaurantSlug: 'mama-tee',
        },
        {
          restaurantId: 'restaurant_456',
          workspaceSlug: 'other',
          restaurantSlug: 'mama-tee',
        },
      ],
      meta: { hasNextPage: false },
    } as never);
    publicStorefrontService.findRestaurantProfile
      .mockResolvedValueOnce({ branches: [createBranchCard()] } as never)
      .mockResolvedValueOnce({
        branches: [
          {
            ...createBranchCard(),
            branchId: 'branch_456',
            workspaceSlug: 'other',
            restaurantId: 'restaurant_456',
          },
        ],
      } as never);
    await service.processInbound({
      conversation: createConversation(),
      inboundEventId: 'dish-search',
      text: 'I want to get rice from Mama Tee restaurant',
    });
    expect(publicStorefrontService.search).toHaveBeenCalledWith({
      q: 'mama tee',
      city: undefined,
      limit: 10,
    });
    expect(messages[0]?.content).toMatchObject({
      type: 'list',
      body: expect.stringContaining('rice') as unknown,
      sections: [
        {
          rows: [
            { id: 'branch.select:branch_123' },
            { id: 'branch.select:branch_456' },
          ],
        },
      ],
    });
    expect(
      checkoutSessionsService.createWhatsappStandardDraftCheckoutSession,
    ).not.toHaveBeenCalled();
    expect(
      getUpdateSetByState(
        conversationModel.findOneAndUpdate,
        WhatsappConversationState.AwaitingBranchSelection,
      ),
    ).toMatchObject({ 'metadata.standardFlow.itemQuery': 'rice' });
  });

  it.each([true, false])(
    'shows real scoped dish matches and a session URL button (matches=%s)',
    async (hasMatches) => {
      const messages: SavedOutboundMessage[] = [];
      const {
        service,
        publicStorefrontService,
        menuItemSearchService,
        checkoutSessionsService,
        conversationModel,
      } = createService(messages);
      publicStorefrontService.findBranchProfile.mockResolvedValue({
        branch: createBranchCard(),
      } as never);
      menuItemSearchService.search.mockResolvedValue({
        data: hasMatches
          ? [
              {
                name: 'Jollof Rice',
                basePriceMinorUnit: 300000,
                currency: 'NGN',
              },
              {
                name: 'Fried Rice',
                basePriceMinorUnit: 350000,
                currency: 'NGN',
              },
            ]
          : [],
        meta: { hasNextPage: false },
      } as never);
      checkoutSessionsService.createWhatsappStandardDraftCheckoutSession.mockResolvedValue(
        createCheckoutSessionResponse(),
      );
      await service.processInbound({
        conversation: createConversation({
          state: WhatsappConversationState.AwaitingBranchSelection,
          metadata: {
            standardFlow: {
              branchCandidates: [createBranchCandidate()],
              itemQuery: 'rice',
            },
          },
        }),
        inboundEventId: 'dish-selection',
        text: 'first',
      });
      expect(publicStorefrontService.findBranchProfile).toHaveBeenCalledWith(
        'ordira',
        'mama-tee',
        'lekki',
      );
      expect(menuItemSearchService.search).toHaveBeenCalledWith(
        { q: 'rice', limit: 5, includeUnavailable: false },
        { branchId: 'branch_123', restaurantId: 'restaurant_123' },
      );
      const content = messages[0]?.content;
      expect(content).toMatchObject({
        type: 'cta_url',
        displayText: 'Open menu',
        url: 'https://store.ordira.test/checkout/session_token',
      });
      if (content?.type !== 'cta_url') throw new Error('Expected a URL button');
      expect(content.body).toContain(
        hasMatches
          ? 'Jollof Rice — NGN 3,000.00'
          : "couldn't find an available menu match",
      );
      if (hasMatches)
        expect(content.body).toContain('Fried Rice — NGN 3,500.00');
      expect(content.body).not.toContain('https://');
      expect(content.body.length).toBeLessThanOrEqual(1024);
      expect(
        getUpdateSetByState(
          conversationModel.findOneAndUpdate,
          WhatsappConversationState.StorefrontHandoff,
        ),
      ).toMatchObject({ 'metadata.standardFlow.itemQuery': null });
    },
  );

  it('does not open a branch that became unavailable after search', async () => {
    const messages: SavedOutboundMessage[] = [];
    const {
      service,
      publicStorefrontService,
      menuItemSearchService,
      checkoutSessionsService,
    } = createService(messages);
    publicStorefrontService.findBranchProfile.mockRejectedValue(
      new NotFoundException(),
    );
    await service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.AwaitingBranchSelection,
        metadata: {
          standardFlow: {
            branchCandidates: [createBranchCandidate()],
            itemQuery: 'rice',
          },
        },
      }),
      inboundEventId: 'gone-branch',
      interactionId: 'branch.select:branch_123',
    });
    expect(messages[0]?.content).toMatchObject({
      type: 'text',
      text: expect.stringContaining('no longer available') as unknown,
    });
    expect(menuItemSearchService.search).not.toHaveBeenCalled();
    expect(
      checkoutSessionsService.createWhatsappStandardDraftCheckoutSession,
    ).not.toHaveBeenCalled();
  });

  it('clears a previous dish when the customer starts an ordinary restaurant search', async () => {
    const messages: SavedOutboundMessage[] = [];
    const { service, publicStorefrontService, conversationModel } =
      createService(messages);
    publicStorefrontService.search.mockResolvedValue({ data: [] } as never);
    await service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.AwaitingBranchSelection,
        metadata: {
          standardFlow: {
            branchCandidates: [createBranchCandidate()],
            itemQuery: 'rice',
          },
        },
      }),
      inboundEventId: 'new-search',
      text: 'Find another kitchen',
    });
    expect(
      getUpdateSetByState(
        conversationModel.findOneAndUpdate,
        WhatsappConversationState.AwaitingOrderEntryChoice,
      ),
    ).toMatchObject({ 'metadata.standardFlow.itemQuery': null });
  });

  it('returns complete paid delivery details from the authorized order without another lookup', async () => {
    const messages: SavedOutboundMessage[] = [];
    const { service, orderModel } = createService(messages);
    const item: OrderItemSnapshot = {
      menuItemId: 'rice',
      name: 'Jollof rice',
      slug: 'jollof-rice',
      quantity: 2,
      currency: 'NGN',
      unitLabel: 'One plate',
      servingSizeLabel: 'Large',
      note: 'Mild pepper',
      baseUnitPriceMinorUnit: 200000,
      modifierUnitTotalMinorUnit: 25000,
      modifierLineTotalMinorUnit: 100000,
      unitPriceMinorUnit: 225000,
      lineTotalMinorUnit: 500000,
      modifierSelections: [
        {
          modifierGroupId: 'protein',
          groupName: 'Protein',
          selectionMode: 'single',
          quantityBehavior: 'per_item',
          options: [
            {
              modifierOptionId: 'egg',
              optionName: 'Egg',
              quantity: 1,
              unitPriceDeltaMinorUnit: 25000,
              totalPriceDeltaMinorUnit: 50000,
            },
          ],
        },
        {
          modifierGroupId: 'packaging',
          groupName: 'Packaging',
          selectionMode: 'multiple',
          quantityBehavior: 'per_line',
          options: [
            {
              modifierOptionId: 'box',
              optionName: 'Box',
              quantity: 2,
              unitPriceDeltaMinorUnit: 25000,
              totalPriceDeltaMinorUnit: 50000,
            },
          ],
        },
      ],
    };
    orderModel.findOne.mockReturnValue(
      createQuery({
        ...createOrderDocument(),
        paymentStatus: 'paid',
        fulfillmentType: 'delivery',
        orderTiming: 'scheduled',
        requestedFulfillmentAt: new Date('2026-06-22T14:00:00Z'),
        deliveryAddress: {
          street: '12 Palm Street',
          city: 'Lekki',
          note: 'Call at gate',
        },
        items: [item],
        subtotalMinorUnit: 500000,
        serviceChargeMinorUnit: 20000,
        taxMinorUnit: 25000,
        deliveryFeeMinorUnit: 50000,
        discountMinorUnit: 10000,
        totalMinorUnit: 585000,
        customerNote: 'Pack separately',
      }),
    );
    await service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.ViewingOrders,
      }),
      inboundEventId: 'full-order',
      interactionId: createOrderSelectActionId('66f000000000000000000101'),
    });
    const text = messages
      .map((message) => {
        const content = message.content;
        return content?.type === 'text'
          ? content.text
          : content && 'body' in content
            ? content.body
            : '';
      })
      .join('\n');
    for (const detail of [
      'Payment: Paid',
      'Ada Customer',
      'Branch: Lekki',
      'Delivery',
      '12 Palm Street, Lekki',
      'Call at gate',
      'Scheduled for: 22 Jun 2026, 14:00 UTC',
      '21 Jun 2026, 12:00 UTC',
      '2 × Jollof rice',
      '₦5,000.00',
      'One plate · Large',
      'Base price: ₦2,000.00 each',
      'Protein: 1 × Egg (per item)',
      'Packaging: 2 × Box (for this line)',
      'Extras included: ₦1,000.00',
      'Mild pepper',
      'Subtotal: ₦5,000.00',
      'Service charge: ₦200.00',
      'Tax: ₦250.00',
      'Delivery fee: ₦500.00',
      'Discount: −₦100.00',
      'Total: ₦5,850.00',
      'Pack separately',
    ])
      expect(text).toContain(detail);
    expect(orderModel.findOne).toHaveBeenCalledTimes(1);
    expect(orderModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        'customerSnapshot.phoneNumber': {
          $in: expect.arrayContaining(['2348000000000']) as unknown,
        },
      }),
    );
    expect(messages.at(-1)?.content).toMatchObject({
      type: 'reply_buttons',
      buttons: [
        { id: WhatsappStandardFlowActionKey.OrdersTrack },
        { id: WhatsappStandardFlowActionKey.OrdersReceipt },
        { id: WhatsappStandardFlowActionKey.NavigationHome },
      ],
    });
  });

  it('keeps pickup details in one reply and omits delivery instructions and zero charges', async () => {
    const messages: SavedOutboundMessage[] = [];
    const { service, orderModel } = createService(messages);
    orderModel.findOne.mockReturnValue(
      createQuery({
        ...createOrderDocument(),
        branchSnapshot: {
          name: 'Lekki',
          slug: 'lekki',
          phoneNumber: '+2348111111111',
          address: { street: '10 Market Road' },
        },
      }),
    );
    await service.processInbound({
      conversation: createConversation(),
      inboundEventId: 'pickup-details',
      interactionId: createOrderSelectActionId('66f000000000000000000101'),
    });
    expect(messages).toHaveLength(1);
    const content = messages[0]?.content;
    expect(content).toMatchObject({
      type: 'reply_buttons',
      body: expect.stringContaining('🛍️ *Pickup*') as unknown,
    });
    if (content?.type !== 'reply_buttons') throw new Error('Expected buttons');
    expect(content.body).toContain('Address: 10 Market Road');
    expect(content.body).toContain('Branch phone: +2348111111111');
    expect(content.body).toContain('Timing: Immediate');
    expect(content.body).not.toMatch(/Delivery|Tax:|Discount:|Service charge:/);
    expect(content.buttons[1].id).toBe(WhatsappStandardFlowActionKey.OrdersPay);
  });

  it('preserves long order notes in bounded parts with distinct retry keys and final actions', async () => {
    const messages: SavedOutboundMessage[] = [];
    const { service, orderModel } = createService(messages);
    const note = '🥘'.repeat(4100) + 'END OF NOTE';
    orderModel.findOne.mockReturnValue(
      createQuery({ ...createOrderDocument(), customerNote: note }),
    );
    await service.processInbound({
      conversation: createConversation(),
      inboundEventId: 'long-details',
      interactionId: createOrderSelectActionId('66f000000000000000000101'),
    });
    const textParts = messages.flatMap(({ content }) =>
      content?.type === 'text' ? [content.text] : [],
    );
    expect(textParts.length).toBeGreaterThan(1);
    for (const part of textParts) {
      expect(part.length).toBeLessThanOrEqual(4096);
      expect(part).not.toMatch(/\p{Surrogate}/u);
    }
    const details = textParts
      .map((text) =>
        text.replace(/^🧾 \*Order details — part \d+ of \d+\*\n\n/, ''),
      )
      .join('');
    expect(details).toContain(note);
    expect(
      new Set(messages.map((message) => message.idempotencyKeyHash)).size,
    ).toBe(messages.length);
    const actions = messages.at(-1)?.content;
    expect(actions).toMatchObject({ type: 'reply_buttons' });
    if (actions?.type === 'reply_buttons')
      expect(actions.body.length).toBeLessThanOrEqual(1024);
  });

  it('does not reveal order details when the ownership lookup fails', async () => {
    const messages: SavedOutboundMessage[] = [];
    const { service, orderModel } = createService(messages);
    orderModel.findOne.mockReturnValue(createQuery(null));
    await service.processInbound({
      conversation: createConversation(),
      inboundEventId: 'other-order',
      interactionId: createOrderSelectActionId('66f000000000000000000101'),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toMatchObject({
      type: 'text',
      text: expect.stringContaining('could not find that order') as unknown,
    });
  });

  it('executes a validated AI search through the normal public storefront handler', async () => {
    const messages: SavedOutboundMessage[] = [];
    const { service, publicStorefrontService } = createService(messages);
    publicStorefrontService.search.mockResolvedValue({ data: [] } as never);
    await service.processInbound({
      conversation: createConversation(),
      inboundEventId: 'ai-search',
      interactionId: WhatsappStandardFlowActionKey.OrderEntrySearch,
      restaurantSearch: { q: 'Mama Tee', city: 'Lekki' },
    });
    expect(publicStorefrontService.search).toHaveBeenCalledWith({
      q: 'Mama Tee',
      city: 'Lekki',
      limit: 10,
    });
    expect(messages).toHaveLength(1);
  });
  it('searches the extracted restaurant and city without a second prompt', async () => {
    const messages: SavedOutboundMessage[] = [];
    const { service, publicStorefrontService } = createService(messages);
    publicStorefrontService.search.mockResolvedValue({ data: [] } as never);
    await service.processInbound({
      conversation: createConversation(),
      inboundEventId: 'natural-search',
      text: 'Could you please find Madam Love in Lekki?',
    });
    expect(publicStorefrontService.search).toHaveBeenCalledWith({
      q: 'madam love',
      city: 'lekki',
      limit: 10,
    });
    expect(messages[0]?.content).toMatchObject({
      type: 'text',
      text: expect.stringContaining('No matching branches') as unknown,
    });
  });

  it('opens the newest listed order and rechecks ownership for a contextual selection', async () => {
    const messages: SavedOutboundMessage[] = [];
    const { service, orderModel } = createService(messages);
    orderModel.findOne.mockReturnValue(createQuery(createOrderDocument()));
    await service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.ViewingOrders,
        metadata: {
          standardFlow: { orderCandidates: [createOrderCandidate()] },
        },
      }),
      inboundEventId: 'latest',
      text: 'The latest one please',
    });
    expect(orderModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: '66f000000000000000000101',
        'customerSnapshot.phoneNumber': {
          $in: expect.arrayContaining(['2348000000000']) as unknown,
        },
      }),
    );
    expect(messages[0]?.content).toMatchObject({
      type: 'reply_buttons',
      body: expect.stringContaining('ORD-260621-ABC1234567') as unknown,
    });
  });

  it('asks for clarification without guessing when several orders match a vague reference', async () => {
    const messages: SavedOutboundMessage[] = [];
    const { service, orderModel } = createService(messages);
    await service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.ViewingOrders,
        metadata: {
          standardFlow: {
            orderCandidates: [
              createOrderCandidate(),
              { ...createOrderCandidate(), orderId: 'other_order' },
            ],
          },
        },
      }),
      inboundEventId: 'vague',
      text: 'that one',
    });
    expect(orderModel.findOne).not.toHaveBeenCalled();
    expect(messages[0]?.content).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Which option') as unknown,
    });
  });
  it.each(['find', 'show'])(
    'asks what the customer means by %s and supports a typed restaurant choice',
    async (text) => {
      const messages: SavedOutboundMessage[] = [];
      const { service, conversationModel } = createService(messages);
      await service.processInbound({
        conversation: createConversation(),
        inboundEventId: 'discover',
        text,
      });
      expect(messages[0]?.content).toMatchObject({
        type: 'reply_buttons',
        body:
          text === 'find'
            ? '🔎 What would you like to find?'
            : '🔎 What would you like me to show you?',
        buttons: [
          {
            id: WhatsappStandardFlowActionKey.OrderEntrySearch,
            title: '🍽️ Restaurants',
          },
          {
            id: WhatsappStandardFlowActionKey.OrdersCurrent,
            title: '📋 Current order',
          },
          {
            id: WhatsappStandardFlowActionKey.HomeMyOrders,
            title: '🧾 Order history',
          },
        ],
      });
      expect(
        getUpdateSetByState(
          conversationModel.findOneAndUpdate,
          WhatsappConversationState.AwaitingHomeAction,
        ),
      ).toMatchObject({ 'metadata.standardFlow.discoveryPrompt': true });
      await service.processInbound({
        conversation: createConversation({
          state: WhatsappConversationState.AwaitingHomeAction,
          metadata: { standardFlow: { discoveryPrompt: true } },
        }),
        inboundEventId: 'restaurant-choice',
        text: 'Restaurants',
      });
      expect(
        getUpdateSetByState(
          conversationModel.findOneAndUpdate,
          WhatsappConversationState.AwaitingRestaurantSearch,
        ),
      ).toMatchObject({
        state: WhatsappConversationState.AwaitingRestaurantSearch,
      });
    },
  );
  it.each([
    ['payment link', 'payment', 'single_order_status'],
    ['my receipt', 'receipt', 'single_order_receipt'],
    ['payment receipt', 'payment_receipt', 'single_payment_receipt'],
  ])(
    'asks for an order then continues %s using the chosen order',
    async (text, pending, purpose) => {
      const messages: SavedOutboundMessage[] = [];
      const { service, orderModel, conversationModel, orderAccessService } =
        createService(messages);
      orderModel.find.mockReturnValue(
        createOrderFindQuery([
          createOrderDocument(),
          {
            ...createOrderDocument(),
            _id: new Types.ObjectId(),
            publicCode: 'ORD-OTHER',
          },
        ]),
      );
      // A previous selection must not be reused after returning home.
      await service.processInbound({
        conversation: createConversation({
          state: WhatsappConversationState.PlatformHome,
          metadata: { standardFlow: { selectedOrder: createOrderCandidate() } },
        }),
        inboundEventId: 'request',
        text,
      });
      expect(messages[0]?.content).toMatchObject({
        type: 'list',
        body: expect.stringContaining('Which order') as unknown,
      });
      expect(
        orderAccessService.createWhatsappMagicLinkForVerifiedOrder,
      ).not.toHaveBeenCalled();
      expect(
        getUpdateSetByState(
          conversationModel.findOneAndUpdate,
          WhatsappConversationState.ViewingOrders,
        ),
      ).toMatchObject({ 'metadata.standardFlow.pendingOrderAction': pending });

      orderModel.findOne.mockReturnValue(createQuery(createOrderDocument()));
      orderAccessService.createWhatsappMagicLinkForVerifiedOrder.mockResolvedValue(
        {
          urls: { redirectUrl: 'https://store.ordira.test/secure-receipt' },
        } as never,
      );
      await service.processInbound({
        conversation: createConversation({
          state: WhatsappConversationState.ViewingOrders,
          metadata: {
            standardFlow: {
              pendingOrderAction: pending,
              orderCandidates: [createOrderCandidate()],
            },
          },
        }),
        inboundEventId: 'select',
        interactionId: createOrderSelectActionId('66f000000000000000000101'),
      });
      expect(
        orderAccessService.createWhatsappMagicLinkForVerifiedOrder,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ id: '66f000000000000000000101' }),
        purpose,
        expect.anything(),
      );
      expect(orderModel.findOne).toHaveBeenCalledTimes(1);
      expect(messages[1]?.content).toMatchObject({
        type: 'cta_url',
        url: 'https://store.ordira.test/secure-receipt',
      });
      expect(
        getUpdateSetByState(
          conversationModel.findOneAndUpdate,
          WhatsappConversationState.ViewingOrder,
        ),
      ).toMatchObject({ 'metadata.standardFlow.pendingOrderAction': null });
    },
  );

  it('does not cancel a submitted order when the customer types cancel', async () => {
    const messages: SavedOutboundMessage[] = [];
    const { service, conversationModel } = createService(messages);
    await service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.OrderCreated,
      }),
      inboundEventId: 'cancel',
      text: 'cancel',
    });
    expect(messages[0]?.content).toMatchObject({
      type: 'reply_buttons',
      body: expect.stringContaining('No order has been cancelled') as unknown,
    });
    expect(
      getUpdateSetByState(
        conversationModel.findOneAndUpdate,
        WhatsappConversationState.Closed,
      ),
    ).toEqual({});
  });
  it.each(['Place an order', '🍽️ Place an order', '  PLACE   AN ORDER  '])(
    'accepts the typed home label %s',
    async (text) => {
      const messages: SavedOutboundMessage[] = [];
      const { service } = createService(messages);
      await service.processInbound({
        conversation: createConversation({
          state: WhatsappConversationState.PlatformHome,
        }),
        inboundEventId: 'typed',
        text,
      });
      expect(messages[0]?.content).toMatchObject({
        type: 'reply_buttons',
        buttons: [
          { id: WhatsappStandardFlowActionKey.OrderEntryNearby },
          { id: WhatsappStandardFlowActionKey.OrderEntrySearch },
          { id: WhatsappStandardFlowActionKey.OrderEntryRecent },
        ],
      });
    },
  );

  it('accepts a typed discovery choice and requests location', async () => {
    const messages: SavedOutboundMessage[] = [];
    const { service } = createService(messages);
    await service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.AwaitingOrderEntryChoice,
      }),
      inboundEventId: 'typed',
      text: 'near me',
    });
    expect(messages[0]?.content).toMatchObject({ type: 'location_request' });
  });

  it('starts optional email collection when the customer replies EMAIL after a receipt', async () => {
    const savedMessages: SavedOutboundMessage[] = [];
    const { service, conversationModel } = createService(savedMessages);
    await service.processInbound({
      conversation: createConversation(),
      inboundEventId: 'inbound_email',
      text: 'EMAIL',
      interactionId: null,
      interactionTitle: null,
    });
    expect(savedMessages[0]?.content).toMatchObject({
      type: 'text',
      text: expect.stringContaining('email address') as unknown,
    });
    expect(conversationModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: WhatsappConversationState.AwaitingEmail,
        }) as unknown,
      }),
      expect.anything(),
    );
  });

  it.each([
    'hi',
    'Hey',
    '👋 HI!',
    'Hello there',
    'Good morning!',
    '  GOOD   AFTERNOON  ',
    'good evening',
  ])(
    'queues the home menu for greeting %s even while collecting email',
    async (text) => {
      const savedMessages: SavedOutboundMessage[] = [];
      const { service, conversationModel, outboundDispatcherService } =
        createService(savedMessages);

      await service.processInbound({
        conversation: createConversation({
          state: WhatsappConversationState.AwaitingEmail,
        }),
        inboundEventId: 'inbound_123',
        text,
        interactionId: null,
        interactionTitle: null,
      });

      expect(conversationModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'conversation_123' },
        expect.objectContaining({
          $set: expect.objectContaining({
            state: WhatsappConversationState.PlatformHome,
            status: WhatsappConversationStatus.WaitingForCustomer,
          }) as Record<string, unknown>,
        }),
        expect.objectContaining({
          returnDocument: 'after',
          runValidators: true,
        }),
      );
      expect(savedMessages).toHaveLength(1);
      expect(savedMessages[0]?.status).toBe(
        WhatsappOutboundMessageStatus.Queued,
      );
      expect(savedMessages[0]?.content).toEqual({
        type: 'reply_buttons',
        body: '👋 Hi Ada, welcome to Ordira.\nWhat would you like to do?',
        buttons: [
          {
            id: WhatsappStandardFlowActionKey.HomePlaceOrder,
            title: '🍽️ Place an order',
          },
          {
            id: WhatsappStandardFlowActionKey.HomeMyOrders,
            title: '🧾 My orders',
          },
          {
            id: WhatsappStandardFlowActionKey.HomeAccountHelp,
            title: '⚙️ Account & help',
          },
        ],
      });
      expect(savedMessages[0]?.idempotencyKeyHash).toMatch(/^[a-f0-9]{64}$/);
      expect(
        outboundDispatcherService.enqueueOutboundMessage,
      ).toHaveBeenCalledWith(expect.any(String));
      expect(
        outboundDispatcherService.sendTypingIndicator,
      ).not.toHaveBeenCalled();
      expect(
        outboundDispatcherService.enqueueOutboundMessage.mock
          .invocationCallOrder[0],
      ).toBeLessThan(
        getStateUpdateInvocationOrder(
          conversationModel.findOneAndUpdate,
          WhatsappConversationState.PlatformHome,
        ),
      );
    },
  );

  it('debounces duplicate standard-flow prompts at the conversation level', async () => {
    const savedMessages: SavedOutboundMessage[] = [];
    const { service, conversationModel, outboundDispatcherService } =
      createService(savedMessages);
    conversationModel.updateOne.mockReturnValueOnce(
      createUpdateResultQuery({ modifiedCount: 0 }),
    );

    await service.processInbound({
      conversation: createConversation(),
      inboundEventId: 'inbound_duplicate_home',
      text: 'home',
      interactionId: null,
      interactionTitle: null,
    });

    expect(savedMessages).toHaveLength(0);
    expect(
      outboundDispatcherService.enqueueOutboundMessage,
    ).not.toHaveBeenCalled();
    expect(
      getUpdateSetByState(
        conversationModel.findOneAndUpdate,
        WhatsappConversationState.PlatformHome,
      ),
    ).toEqual({});
    expect(conversationModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'conversation_123' },
      expect.objectContaining({
        $set: expect.objectContaining({
          lastCustomerMessageAt: expect.any(Date) as Date,
          serviceWindowExpiresAt: expect.any(Date) as Date,
        }) as Record<string, unknown>,
      }),
      expect.objectContaining({
        returnDocument: 'after',
        runValidators: true,
      }),
    );
  });

  it('shows nearby branch choices from a shared location message', async () => {
    const savedMessages: SavedOutboundMessage[] = [];
    const {
      service,
      conversationModel,
      outboundDispatcherService,
      publicStorefrontService,
    } = createService(savedMessages);
    publicStorefrontService.nearbyBranches.mockResolvedValue({
      data: [createBranchCard()],
      meta: createPaginationMeta(1),
    });

    await service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.AwaitingLocation,
      }),
      inboundEventId: 'inbound_location',
      providerMessageId: 'wamid.location',
      text: null,
      interactionId: null,
      interactionTitle: null,
      location: {
        latitude: 6.45,
        longitude: 3.39,
      },
    });

    expect(publicStorefrontService.nearbyBranches).toHaveBeenCalledWith({
      lat: 6.45,
      lng: 3.39,
      limit: 10,
    });
    expect(outboundDispatcherService.sendTypingIndicator).toHaveBeenCalledWith({
      conversation: expect.objectContaining({
        id: 'conversation_123',
      }) as Record<string, unknown>,
      providerMessageId: 'wamid.location',
      reason: 'nearby-branches',
    });
    expect(
      getUpdateSetByState(
        conversationModel.findOneAndUpdate,
        WhatsappConversationState.AwaitingBranchSelection,
      ),
    ).toMatchObject({
      state: WhatsappConversationState.AwaitingBranchSelection,
      'metadata.standardFlow.branchCandidates': [
        expect.objectContaining({
          branchId: 'branch_123',
          workspaceSlug: 'ordira',
          restaurantSlug: 'mama-tee',
          branchSlug: 'lekki',
        }) as Record<string, unknown>,
      ],
    });
    expect(savedMessages[0]?.content).toMatchObject({
      type: 'list',
      body: '📍 Choose a nearby branch to continue.',
      buttonText: 'Branches',
      sections: [
        {
          title: 'Nearby branches',
          rows: [
            {
              id: createBranchSelectActionId('branch_123'),
              title: 'Mama Tee - Lekki',
              description: '2.4 km away',
            },
          ],
        },
      ],
    });
  });

  it('shows notification preferences without reading platform identity first', async () => {
    const savedMessages: SavedOutboundMessage[] = [];
    const {
      service,
      conversationModel,
      outboundDispatcherService,
      platformIdentityModel,
    } = createService(savedMessages);

    await service.processInbound({
      conversation: createConversation({
        metadata: {
          standardFlow: {
            notificationPreferences: {
              whatsappTransactional: true,
              emailTransactional: false,
              whatsappMarketing: false,
              emailMarketing: true,
            },
          },
        },
      }),
      inboundEventId: 'inbound_preferences',
      text: null,
      interactionId: WhatsappStandardFlowActionKey.AccountNotifications,
      interactionTitle: 'Preferences',
    });

    expect(platformIdentityModel.findOne).not.toHaveBeenCalled();
    expect(savedMessages[0]?.content).toMatchObject({
      type: 'list',
      body: [
        '🔔 Notification preferences',
        'WhatsApp alerts: on',
        'Email alerts: off',
        'WhatsApp promos: off',
        'Email promos: on',
      ].join('\n'),
      buttonText: 'Preferences',
    });
    expect(
      outboundDispatcherService.enqueueOutboundMessage.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      getStateUpdateInvocationOrder(
        conversationModel.findOneAndUpdate,
        WhatsappConversationState.NotificationPreferences,
      ),
    );
  });

  it('caches updated notification preferences on the conversation', async () => {
    const savedMessages: SavedOutboundMessage[] = [];
    const { service, conversationModel, platformIdentityModel } =
      createService(savedMessages);

    await service.processInbound({
      conversation: createConversation({
        state: WhatsappConversationState.NotificationPreferences,
        metadata: {
          standardFlow: {
            notificationPreferences: {
              whatsappTransactional: true,
              emailTransactional: true,
              whatsappMarketing: true,
              emailMarketing: true,
            },
          },
        },
      }),
      inboundEventId: 'inbound_preference_update',
      text: null,
      interactionId:
        WhatsappStandardFlowActionKey.NotificationsWhatsappMarketingOff,
      interactionTitle: 'WhatsApp promos off',
    });

    expect(platformIdentityModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'identity_123',
      }),
      {
        $set: {
          'communicationPreferences.whatsappMarketing': false,
        },
      },
      expect.objectContaining({
        returnDocument: 'after',
        runValidators: true,
      }),
    );
    expect(savedMessages[0]?.content).toMatchObject({
      type: 'text',
      text: expect.stringContaining('WhatsApp promos: off') as string,
    });
    expect(
      getUpdateSetByState(
        conversationModel.findOneAndUpdate,
        WhatsappConversationState.NotificationPreferences,
      ),
    ).toMatchObject({
      'metadata.standardFlow.notificationPreferences': {
        whatsappTransactional: true,
        emailTransactional: true,
        whatsappMarketing: false,
        emailMarketing: true,
      },
    });
  });

  it('creates a draft checkout session and queues an absolute storefront CTA after branch selection', async () => {
    const savedMessages: SavedOutboundMessage[] = [];
    const { service, conversationModel, checkoutSessionsService } =
      createService(savedMessages);
    checkoutSessionsService.createWhatsappStandardDraftCheckoutSession.mockResolvedValue(
      createCheckoutSessionResponse(),
    );

    await service.processInbound({
      conversation: createConversation({
        metadata: {
          standardFlow: {
            branchCandidates: [createBranchCandidate()],
          },
        },
      }),
      inboundEventId: 'inbound_branch',
      text: null,
      interactionId: createBranchSelectActionId('branch_123'),
      interactionTitle: 'Mama Tee - Lekki',
    });

    expect(
      checkoutSessionsService.createWhatsappStandardDraftCheckoutSession,
    ).toHaveBeenCalledWith({
      workspaceSlug: 'ordira',
      restaurantSlug: 'mama-tee',
      branchSlug: 'lekki',
      customer: {
        firstName: 'Ada',
        phoneNumber: '2348000000000',
      },
    });
    const storefrontUpdate = getUpdateSetByState(
      conversationModel.findOneAndUpdate,
      WhatsappConversationState.StorefrontHandoff,
    );
    const storefrontUpdateCall = getUpdateCallByState(
      conversationModel.findOneAndUpdate,
      WhatsappConversationState.StorefrontHandoff,
    );
    expect(storefrontUpdateCall?.[0]).toEqual({
      _id: 'conversation_123',
    });
    expect(storefrontUpdate).toMatchObject({
      checkoutSessionId: 'session_123',
      orderId: null,
      checkoutSessionCode: 'CHK-260621-ABC1234567',
      state: WhatsappConversationState.StorefrontHandoff,
    });
    expect(storefrontUpdate['metadata.standardFlow.storefront']).toMatchObject({
      workspaceId: 'workspace_123',
      restaurantId: 'restaurant_123',
      branchId: 'branch_123',
      workspaceSlug: 'ordira',
      restaurantSlug: 'mama-tee',
      branchSlug: 'lekki',
    });
    expect(savedMessages[0]?.workspaceId).toBeNull();
    expect(savedMessages[0]?.restaurantId).toBeNull();
    expect(savedMessages[0]?.branchId).toBeNull();
    expect(savedMessages[0]?.content).toMatchObject({
      type: 'cta_url',
      body: '🍽️ Continue with Mama Tee - Lekki.',
      displayText: 'Open menu',
      url: 'https://store.ordira.test/checkout/session_token',
    });
  });

  it('does not queue a malformed storefront CTA when the public storefront base URL is missing', async () => {
    const savedMessages: SavedOutboundMessage[] = [];
    const { service, checkoutSessionsService } = createService(savedMessages, {
      storefrontBaseUrl: null,
    });
    checkoutSessionsService.createWhatsappStandardDraftCheckoutSession.mockResolvedValue(
      createCheckoutSessionResponse(),
    );

    await service.processInbound({
      conversation: createConversation({
        metadata: {
          standardFlow: {
            branchCandidates: [createBranchCandidate()],
          },
        },
      }),
      inboundEventId: 'inbound_branch',
      text: null,
      interactionId: createBranchSelectActionId('branch_123'),
      interactionTitle: 'Mama Tee - Lekki',
    });

    expect(savedMessages[0]?.content).toEqual({
      type: 'text',
      text: '🍽️ Your menu is almost ready, but we could not open the storefront link right now. Please try again shortly.',
    });
  });

  it.each([null, 'Orders', ' 🧾 ORDERS '])(
    'lists recent customer orders for the verified WhatsApp identity: %s',
    async (text) => {
      const savedMessages: SavedOutboundMessage[] = [];
      const { service, conversationModel, orderModel } =
        createService(savedMessages);
      orderModel.find.mockReturnValue(
        createOrderFindQuery([createOrderDocument()]),
      );

      await service.processInbound({
        conversation: createConversation(),
        inboundEventId: 'inbound_orders',
        text,
        interactionId: text ? null : WhatsappStandardFlowActionKey.HomeMyOrders,
        interactionTitle: 'My orders',
      });

      const orderFindFilter = orderModel.find.mock.calls[0]?.[0] as
        | OrderFindFilter
        | undefined;

      expect(orderFindFilter?.['customerSnapshot.phoneNumber']?.$in).toEqual(
        expect.arrayContaining(['+2348000000000', '2348000000000']),
      );
      expect(orderFindFilter).not.toHaveProperty('status');
      expect(
        getUpdateSetByState(
          conversationModel.findOneAndUpdate,
          WhatsappConversationState.ViewingOrders,
        ),
      ).toMatchObject({
        state: WhatsappConversationState.ViewingOrders,
        'metadata.standardFlow.orderCandidates': [
          expect.objectContaining({
            orderId: '66f000000000000000000101',
            publicCode: 'ORD-260621-ABC1234567',
          }) as Record<string, unknown>,
        ],
      });
      expect(savedMessages[0]?.content).toMatchObject({
        type: 'list',
        body: '🧾 Choose an order to view status, payment, or receipt options.',
        buttonText: 'Orders',
        sections: [
          {
            rows: [
              {
                id: createOrderSelectActionId('66f000000000000000000101'),
                title: '✅ ORD-260621-ABC1234567',
              },
            ],
          },
        ],
      });
    },
  );

  it.each(['Order', ' 📋 ORDER '])(
    'shows the latest active order for %s without a second read',
    async (text) => {
      const messages: SavedOutboundMessage[] = [];
      const { service, orderModel, conversationModel } =
        createService(messages);
      const query = createOrderFindQuery([createOrderDocument()]);
      orderModel.find.mockReturnValue(query);
      await service.processInbound({
        conversation: createConversation({
          state: WhatsappConversationState.AwaitingConfirmation,
          workspaceId: 'workspace_123',
          restaurantId: 'restaurant_123',
        }),
        inboundEventId: 'current-order',
        text,
      });
      expect(orderModel.find).toHaveBeenCalledWith({
        workspaceId: 'workspace_123',
        restaurantId: 'restaurant_123',
        'customerSnapshot.phoneNumber': {
          $in: expect.arrayContaining([
            '+2348000000000',
            '2348000000000',
          ]) as unknown,
        },
        status: {
          $in: [
            'submitted',
            'accepted',
            'preparing',
            'ready',
            'out_for_delivery',
          ],
        },
      });
      expect(query.sort).toHaveBeenCalledWith({ createdAt: -1 });
      const sortedQuery = query.sort.mock.results[0]?.value as ReturnType<
        OrderFindQuery['sort']
      >;
      expect(sortedQuery.limit).toHaveBeenCalledWith(1);
      expect(orderModel.findOne).not.toHaveBeenCalled();
      expect(messages[0]?.content).toMatchObject({
        type: 'reply_buttons',
        body: expect.stringContaining('ORD-260621-ABC1234567') as unknown,
      });
      expect(
        getUpdateSetByState(
          conversationModel.findOneAndUpdate,
          WhatsappConversationState.ViewingOrder,
        ),
      ).toMatchObject({
        orderId: '66f000000000000000000101',
      });
    },
  );

  it('explains when there is no active order without selecting a completed order', async () => {
    const messages: SavedOutboundMessage[] = [];
    const { service, orderModel, conversationModel } = createService(messages);
    await service.processInbound({
      conversation: createConversation({ orderId: 'old-completed-order' }),
      inboundEventId: 'current-order-empty',
      text: 'order',
    });
    expect(messages[0]?.content).toMatchObject({
      type: 'reply_buttons',
      body: expect.stringContaining('no active orders') as unknown,
      buttons: [
        { id: WhatsappStandardFlowActionKey.NavigationHome, title: '🏠 Home' },
        {
          id: WhatsappStandardFlowActionKey.HomeMyOrders,
          title: '🧾 My orders',
        },
        {
          id: WhatsappStandardFlowActionKey.HomePlaceOrder,
          title: '🍽️ Place my order',
        },
      ],
    });
    expect(
      getUpdateSetByState(
        conversationModel.findOneAndUpdate,
        WhatsappConversationState.PlatformHome,
      ),
    ).toMatchObject({ state: WhatsappConversationState.PlatformHome });
    expect(orderModel.findOne).not.toHaveBeenCalled();
    expect(
      getUpdateSetByState(
        conversationModel.findOneAndUpdate,
        WhatsappConversationState.ViewingOrder,
      ),
    ).toEqual({});
  });

  it('keeps shared conversations platform-scoped when a customer selects an order', async () => {
    const savedMessages: SavedOutboundMessage[] = [];
    const { service, conversationModel, orderModel } =
      createService(savedMessages);
    orderModel.findOne.mockReturnValue(createQuery(createOrderDocument()));

    await service.processInbound({
      conversation: createConversation({
        metadata: {
          standardFlow: {
            orderCandidates: [createOrderCandidate()],
          },
        },
      }),
      inboundEventId: 'inbound_order_select',
      text: null,
      interactionId: createOrderSelectActionId('66f000000000000000000101'),
      interactionTitle: 'ORD-260621-ABC1234567',
    });

    const viewingOrderSet = conversationModel.findOneAndUpdate.mock.calls
      .map((call) => getUpdateSet(call[1]))
      .find((set) => set.state === WhatsappConversationState.ViewingOrder);
    expect(viewingOrderSet).toMatchObject({
      state: WhatsappConversationState.ViewingOrder,
      orderId: '66f000000000000000000101',
      'metadata.standardFlow.selectedOrder': expect.objectContaining({
        workspaceId: 'workspace_123',
        restaurantId: 'restaurant_123',
        branchId: 'branch_123',
      }) as Record<string, unknown>,
    });
    expect(viewingOrderSet).not.toHaveProperty('workspaceId');
    expect(viewingOrderSet).not.toHaveProperty('restaurantId');
    expect(viewingOrderSet).not.toHaveProperty('branchId');
    expect(savedMessages[0]?.workspaceId).toBe('workspace_123');
    expect(savedMessages[0]?.restaurantId).toBe('restaurant_123');
    expect(savedMessages[0]?.branchId).toBe('branch_123');
    expect(savedMessages[0]?.content).toMatchObject({
      type: 'reply_buttons',
      body: expect.stringContaining('ORD-260621-ABC1234567') as string,
    });
  });

  it.each([null, 'Has it been accepted?', 'Is it ready?'])(
    'returns fresh order status in chat for %s without creating a tracking link',
    async (text) => {
      const savedMessages: SavedOutboundMessage[] = [];
      const { service, orderModel, orderAccessService } =
        createService(savedMessages);
      orderModel.findOne.mockReturnValue(createQuery(createOrderDocument()));

      await service.processInbound({
        conversation: createConversation({
          metadata: { standardFlow: { selectedOrder: createOrderCandidate() } },
          state: WhatsappConversationState.ViewingOrder,
        }),
        inboundEventId: 'inbound_status',
        text,
        interactionId: text ? null : WhatsappStandardFlowActionKey.OrdersTrack,
        interactionTitle: 'Order status',
      });

      expect(
        orderAccessService.createWhatsappMagicLinkForVerifiedOrder,
      ).not.toHaveBeenCalled();
      expect(savedMessages[0]?.content).toMatchObject({
        type: 'text',
        text: expect.stringContaining('🧾 *Order received*') as string,
      });
      expect(JSON.stringify(savedMessages[0]?.content)).toContain(
        'Order: *ORD-260621-ABC1234567*',
      );
      expect(JSON.stringify(savedMessages[0]?.content)).not.toContain(
        'https://',
      );
    },
  );

  it('sends a secure receipt link instead of the bare receipt URL', async () => {
    const savedMessages: SavedOutboundMessage[] = [];
    const { service, orderModel, orderAccessService } =
      createService(savedMessages);
    orderModel.findOne.mockReturnValue(createQuery(createOrderDocument()));
    orderAccessService.createWhatsappMagicLinkForVerifiedOrder.mockResolvedValue(
      {
        challengeId: 'challenge_123',
        expiresAt: '2026-06-21T12:30:00.000Z',
        urls: {
          redirectUrl: '/ordira/mama-tee/order-access/magic/order_magic_token',
          historyUrl: '/ordira/mama-tee/orders',
          statusUrl: '/ordira/mama-tee/orders/ORD-260621-ABC1234567',
          receiptUrl: '/ordira/mama-tee/orders/ORD-260621-ABC1234567/receipt',
        },
      },
    );

    await service.processInbound({
      conversation: createConversation({
        metadata: {
          standardFlow: {
            selectedOrder: createOrderCandidate(),
          },
        },
        state: WhatsappConversationState.ViewingOrder,
      }),
      inboundEventId: 'inbound_track',
      text: null,
      interactionId: WhatsappStandardFlowActionKey.OrdersReceipt,
      interactionTitle: 'Receipt',
    });

    expect(
      orderAccessService.createWhatsappMagicLinkForVerifiedOrder,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        publicCode: 'ORD-260621-ABC1234567',
      }),
      'single_order_receipt',
      {
        userAgent: 'ordira-whatsapp-standard-flow',
      },
    );
    expect(savedMessages[0]?.content).toMatchObject({
      type: 'cta_url',
      body: expect.any(String) as string,
      displayText: 'Open receipt',
      url: '/ordira/mama-tee/order-access/magic/order_magic_token',
    });
  });
});

type SavedOutboundMessage = {
  _id: Types.ObjectId;
  workspaceId?: string | null;
  restaurantId?: string | null;
  branchId?: string | null;
  status: string;
  content: WhatsappOutboundContent;
  idempotencyKeyHash: string;
  save: () => Promise<void>;
};

function createService(
  savedMessages: SavedOutboundMessage[],
  options: { storefrontBaseUrl?: string | null } = {},
): {
  service: WhatsappStandardFlowService;
  conversationModel: {
    findOneAndUpdate: jest.Mock<QueryStub<unknown>, [unknown, unknown]>;
    updateOne: jest.Mock<UpdateResultQuery, [unknown, unknown]>;
  };
  outboundDispatcherService: {
    enqueueOutboundMessage: jest.Mock<Promise<boolean>, [string]>;
    sendTypingIndicator: jest.Mock<
      Promise<boolean>,
      [
        {
          conversation: WhatsappConversationRecord;
          providerMessageId?: string | null;
          reason: string;
        },
      ]
    >;
  };
  publicStorefrontService: jest.Mocked<
    Pick<
      PublicStorefrontService,
      | 'nearbyBranches'
      | 'search'
      | 'findRestaurantProfile'
      | 'findBranchProfile'
    >
  >;
  branchOperationsService: jest.Mocked<
    Pick<BranchOperationsService, 'getPublicBranchAvailability'>
  >;
  findPreferenceChoices: jest.Mock;
  budgetQuoteService: jest.Mocked<Pick<WhatsappBudgetQuoteService, 'resolve'>>;
  menuItemSearchService: jest.Mocked<
    Pick<StorefrontMenuItemSearchService, 'search'>
  >;
  checkoutSessionsService: jest.Mocked<
    Pick<
      CheckoutSessionsService,
      | 'createWhatsappStandardDraftCheckoutSession'
      | 'createWhatsappReorderDraft'
      | 'getConversationCheckoutPaymentStatus'
    >
  >;
  orderModel: {
    find: jest.Mock<OrderFindQuery, [unknown]>;
    findOne: jest.Mock<QueryStub<unknown>, [unknown]>;
  };
  platformIdentityModel: {
    findOne: jest.Mock<QueryStub<unknown>, [unknown]>;
    findOneAndUpdate: jest.Mock<
      QueryStub<unknown>,
      [unknown, unknown, unknown]
    >;
  };
  orderAccessService: jest.Mocked<
    Pick<OrderAccessService, 'createWhatsappMagicLinkForVerifiedOrder'>
  >;
} {
  const conversationModel = {
    findOneAndUpdate: jest.fn(() => createQuery(null)),
    updateOne: jest.fn(() => createUpdateResultQuery({ modifiedCount: 1 })),
  };
  const outboundMessageModel = jest.fn(
    (input: Omit<SavedOutboundMessage, '_id' | 'save'>) => {
      const document: SavedOutboundMessage = {
        ...input,
        _id: new Types.ObjectId(),
        save: jest.fn(() => {
          savedMessages.push(document);
          return Promise.resolve();
        }),
      };

      return document;
    },
  );
  const outboundDispatcherService = {
    enqueueOutboundMessage: jest.fn(() => Promise.resolve(true)),
    sendTypingIndicator: jest.fn(() => Promise.resolve(true)),
  };
  const publicStorefrontService = {
    nearbyBranches: jest.fn(),
    search: jest.fn(),
    findRestaurantProfile: jest.fn(),
    findBranchProfile: jest.fn(),
  };
  const menuItemSearchService = { search: jest.fn() };
  const budgetQuoteService = { resolve: jest.fn() };
  const findPreferenceChoices = jest.fn().mockResolvedValue([]);
  const branchOperationsService = { getPublicBranchAvailability: jest.fn() };
  const checkoutSessionsService = {
    createWhatsappStandardDraftCheckoutSession: jest.fn(),
    createWhatsappReorderDraft: jest.fn(),
    getConversationCheckoutPaymentStatus: jest.fn(),
  };
  const orderModel = {
    find: jest.fn(() => createOrderFindQuery([])),
    findOne: jest.fn(() => createQuery(null)),
  };
  const platformIdentityModel = {
    findOne: jest.fn(() => createQuery(null)),
    findOneAndUpdate: jest.fn(() => createQuery(null)),
  };
  const orderAccessService = {
    createWhatsappMagicLinkForVerifiedOrder: jest.fn(),
  };
  const config = {
    baseUrl: Object.prototype.hasOwnProperty.call(options, 'storefrontBaseUrl')
      ? (options.storefrontBaseUrl ?? null)
      : 'https://store.ordira.test',
  };

  const whatsappConversationsRepository = new WhatsappConversationsRepository(
    {} as unknown as Model<WhatsappInboundEvent>,
    conversationModel as unknown as Model<WhatsappConversation>,
    outboundMessageModel as unknown as Model<WhatsappOutboundMessage>,
    platformIdentityModel as unknown as Model<PlatformCustomerIdentity>,
    {} as unknown as Model<CheckoutSession>,
    orderModel as unknown as Model<Order>,
  );

  return {
    service: new WhatsappStandardFlowService(
      whatsappConversationsRepository,
      outboundDispatcherService as never,
      config as never,
      publicStorefrontService as unknown as PublicStorefrontService,
      checkoutSessionsService as unknown as CheckoutSessionsService,
      orderAccessService as unknown as OrderAccessService,
      menuItemSearchService as unknown as StorefrontMenuItemSearchService,
      budgetQuoteService as unknown as WhatsappBudgetQuoteService,
      {
        findPreferenceChoices,
        suggest: (input) =>
          Promise.resolve(
            buildWhatsappBudgetCombinations(
              input.foods,
              input.drinks,
              input.budget,
              input.quote,
            ),
          ),
      } as WhatsappBudgetSuggestionsService,
      branchOperationsService as unknown as BranchOperationsService,
    ),
    branchOperationsService,
    findPreferenceChoices,
    conversationModel,
    outboundDispatcherService,
    publicStorefrontService,
    menuItemSearchService,
    budgetQuoteService,
    checkoutSessionsService,
    orderModel,
    platformIdentityModel,
    orderAccessService,
  };
}

function createConversation(
  input: Partial<WhatsappConversationRecord> = {},
): WhatsappConversationRecord {
  const now = new Date('2026-06-21T12:00:00.000Z');

  return {
    id: 'conversation_123',
    channelId: 'channel_123',
    channelMode: WhatsappChannelMode.SharedPlatform,
    platformCustomerIdentityId: 'identity_123',
    workspaceId: null,
    restaurantId: null,
    branchId: null,
    customerPhoneNumber: '+234 800 000 0000',
    customerPhoneNumberNormalized: '2348000000000',
    customerName: 'Ada Customer',
    status: WhatsappConversationStatus.WaitingForStaff,
    source: WhatsappConversationSource.Whatsapp,
    checkoutSessionId: null,
    checkoutSessionCode: null,
    orderId: null,
    lastMessageText: 'hello',
    lastMessageAt: now,
    lastInboundAt: now,
    lastOutboundAt: null,
    lastCustomerMessageAt: null,
    serviceWindowExpiresAt: null,
    state: input.state ?? WhatsappConversationState.New,
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

function createBranchCard() {
  return {
    id: 'branch_123',
    branchId: 'branch_123',
    workspaceId: 'workspace_123',
    restaurantId: 'restaurant_123',
    workspaceSlug: 'ordira',
    restaurantSlug: 'mama-tee',
    branchSlug: 'lekki',
    name: 'Lekki',
    branchName: 'Lekki',
    restaurantName: 'Mama Tee',
    description: null,
    coverImageUrl: null,
    address: {
      city: 'Lekki',
      state: 'Lagos',
      country: 'NG',
    },
    distanceKm: 2.4,
    pickupEnabled: true,
    deliveryEnabled: true,
    storefrontPath: '/ordira/mama-tee/branches/lekki',
    menuPath: '/ordira/mama-tee/branches/lekki/menu',
    seo: {
      title: 'Mama Tee Lekki',
      description: 'Mama Tee in Lekki',
      canonicalPath: '/ordira/mama-tee/branches/lekki',
      imageUrl: null,
    },
  };
}

function createBranchCandidate() {
  return {
    branchId: 'branch_123',
    workspaceId: 'workspace_123',
    restaurantId: 'restaurant_123',
    workspaceSlug: 'ordira',
    restaurantSlug: 'mama-tee',
    branchSlug: 'lekki',
    restaurantName: 'Mama Tee',
    branchName: 'Lekki',
    menuPath: '/ordira/mama-tee/branches/lekki/menu',
    distanceKm: 2.4,
  };
}

function createCheckoutSessionResponse() {
  return {
    id: 'session_123',
    sessionCode: 'CHK-260621-ABC1234567',
    sessionToken: 'session_token',
    status: 'draft',
    source: 'whatsapp',
    workspaceId: 'workspace_123',
    restaurantId: 'restaurant_123',
    branchId: 'branch_123',
    customer: {},
    items: [],
    totals: {
      subtotalMinorUnit: 0,
      serviceChargeMinorUnit: 0,
      taxMinorUnit: 0,
      deliveryFeeMinorUnit: 0,
      discountMinorUnit: 0,
      totalMinorUnit: 0,
      currency: 'NGN',
    },
    customerNote: null,
    expiresAt: new Date('2026-06-21T12:30:00.000Z'),
    lastTouchedAt: new Date('2026-06-21T12:00:00.000Z'),
    convertedOrderId: null,
    confirmedAt: null,
    convertedAt: null,
    whatsappChannelId: null,
    whatsappOpenedAt: null,
    storefrontResumeUrl:
      '/ordira/mama-tee/branches/lekki/menu?checkout=session_token',
    whatsappHandoff: {
      message: 'Continue my Ordira order CHK-260621-ABC1234567',
    },
    createdAt: new Date('2026-06-21T12:00:00.000Z'),
    updatedAt: new Date('2026-06-21T12:00:00.000Z'),
  };
}

function createOrderDocument() {
  return {
    _id: new Types.ObjectId('66f000000000000000000101'),
    workspaceId: 'workspace_123',
    restaurantId: 'restaurant_123',
    branchId: 'branch_123',
    publicCode: 'ORD-260621-ABC1234567',
    status: 'submitted',
    paymentStatus: 'unpaid',
    fulfillmentType: 'pickup',
    orderTiming: 'immediate',
    requestedFulfillmentAt: null,
    source: 'whatsapp',
    branchSnapshot: {
      name: 'Lekki',
      slug: 'lekki',
    },
    customerSnapshot: {
      firstName: 'Ada',
      lastName: null,
      fullName: 'Ada Customer',
      phoneNumber: '+2348000000000',
      email: null,
    },
    items: [],
    subtotalMinorUnit: 100000,
    serviceChargeMinorUnit: 0,
    taxMinorUnit: 0,
    deliveryFeeMinorUnit: 0,
    discountMinorUnit: 0,
    totalMinorUnit: 100000,
    currency: 'NGN',
    timeline: [],
    submittedAt: new Date('2026-06-21T12:00:00.000Z'),
    createdAt: new Date('2026-06-21T12:00:00.000Z'),
    updatedAt: new Date('2026-06-21T12:00:00.000Z'),
  };
}

function createOrderCandidate() {
  return {
    orderId: '66f000000000000000000101',
    workspaceId: 'workspace_123',
    restaurantId: 'restaurant_123',
    branchId: 'branch_123',
    publicCode: 'ORD-260621-ABC1234567',
    status: 'submitted',
    paymentStatus: 'unpaid',
    branchName: 'Lekki',
    totalMinorUnit: 100000,
    currency: 'NGN',
    createdAt: '2026-06-21T12:00:00.000Z',
  };
}

function createPaginationMeta(total: number) {
  return {
    page: 1,
    limit: 10,
    total,
    totalPages: total > 0 ? 1 : 0,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

type QueryStub<TResult> = {
  exec: jest.Mock<Promise<TResult>, []>;
};

type UpdateResultQuery = {
  exec: jest.Mock<Promise<{ modifiedCount: number }>, []>;
};

type OrderFindQuery = {
  sort: jest.Mock<
    {
      limit: jest.Mock<QueryStub<unknown[]>, [number]>;
    },
    [unknown]
  >;
};

type OrderFindFilter = {
  'customerSnapshot.phoneNumber'?: {
    $in?: string[];
  };
};

function createQuery<TResult>(result: TResult): QueryStub<TResult> {
  return {
    exec: jest.fn(() => Promise.resolve(result)),
  };
}

function createUpdateResultQuery(input: {
  modifiedCount: number;
}): UpdateResultQuery {
  return {
    exec: jest.fn(() => Promise.resolve(input)),
  };
}

function createOrderFindQuery(result: unknown[]): OrderFindQuery {
  return {
    sort: jest.fn(() => ({
      limit: jest.fn(() => createQuery(result)),
    })),
  };
}

function getUpdateSet(update: unknown): Record<string, unknown> {
  if (!isRecord(update) || !isRecord(update.$set)) {
    return {};
  }

  return update.$set;
}

function getUpdateCallByState(
  mock: jest.Mock<QueryStub<unknown>, [unknown, unknown]>,
  state: WhatsappConversationState,
): [unknown, unknown] | undefined {
  return mock.mock.calls.find((call) => getUpdateSet(call[1]).state === state);
}

function getUpdateSetByState(
  mock: jest.Mock<QueryStub<unknown>, [unknown, unknown]>,
  state: WhatsappConversationState,
): Record<string, unknown> {
  const call = getUpdateCallByState(mock, state);

  return call ? getUpdateSet(call[1]) : {};
}

function getStateUpdateInvocationOrder(
  mock: jest.Mock<QueryStub<unknown>, [unknown, unknown]>,
  state: WhatsappConversationState,
): number {
  const callIndex = mock.mock.calls.findIndex(
    (call) => getUpdateSet(call[1]).state === state,
  );

  return callIndex >= 0 ? (mock.mock.invocationCallOrder[callIndex] ?? 0) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
