import type { ConfigType } from '@nestjs/config';
import type OpenAI from 'openai';
import { customerAiConfig } from '@config/customer-ai.config';
import {
  WhatsappConversationState as State,
  type WhatsappConversationRecord,
} from '@modules/whatsapp-conversations/schemas/whatsapp-conversation.schema';
import { WhatsappStandardFlowActionKey as Action } from '@modules/whatsapp-conversations/whatsapp-standard-flow-action-registry';
import {
  CustomerAiIntentService,
  customerIntentContext,
  validateCustomerAiIntent,
} from './customer-ai-intent.service';
import type { CustomerAiSpendGuardService } from './customer-ai-spend-guard.service';
import type { CustomerAiProviderHealthService } from './customer-ai-provider-health.service';
import type { CustomerAiRepository } from './customer-ai.repository';

const conversation = {
  id: 'conversation_1',
  state: State.PlatformHome,
  inputVersion: 3,
  stateVersion: 2,
  metadata: {},
} as WhatsappConversationRecord;
const plan = (
  intent = 'order_history',
  fields: Record<string, unknown> = {},
) => ({
  intent,
  confidence: 'high',
  query: null,
  city: null,
  itemQuery: null,
  selectionIndex: null,
  budgetMaxMinorUnit: null,
  budgetCurrency: null,
  includesDelivery: null,
  ...fields,
});

describe('customer AI intent boundary', () => {
  it('passes a delivery enquiry without inventing a restaurant or coordinates', () => {
    expect(
      validateCustomerAiIntent(
        plan('delivery_coverage', { city: 'Lekki' }),
        conversation,
      ),
    ).toEqual({
      actionId: Action.ConversationAssist,
      followup: { kind: 'delivery_coverage', area: 'Lekki' },
    });
    expect(
      validateCustomerAiIntent(
        plan('delivery_coverage', {
          query: 'guessed restaurant',
          city: 'Lekki',
        }),
        conversation,
      ),
    ).toEqual({ actionId: Action.NavigationDiscover });
  });
  it('resolves meal references only against fresh displayed suggestions', () => {
    const c = {
      ...conversation,
      state: State.StorefrontHandoff,
      metadata: {
        standardFlow: {
          discovery: {
            expiresAt: Date.now() + 10000,
            suggestions: [{ label: 'Rice' }, { label: 'Yam' }],
          },
        },
      },
    };
    expect(
      validateCustomerAiIntent(
        plan('select_suggestion', { selectionIndex: 2 }),
        c,
      ),
    ).toEqual({
      actionId: Action.ConversationAssist,
      followup: { kind: 'suggestion', index: 1 },
    });
    expect(
      validateCustomerAiIntent(
        plan('select_suggestion', { selectionIndex: 3 }),
        c,
      ),
    ).toEqual({ actionId: Action.NavigationDiscover });
    c.metadata.standardFlow.discovery.expiresAt = 0;
    expect(
      validateCustomerAiIntent(
        plan('select_suggestion', { selectionIndex: 2 }),
        c,
      ),
    ).toEqual({ actionId: Action.NavigationDiscover });
  });
  it('limits model context to fresh labels and pending questions', () => {
    const c = {
      ...conversation,
      state: State.StorefrontHandoff,
      metadata: {
        standardFlow: {
          discovery: {
            expiresAt: Date.now() + 10000,
            itemQuery: 'rice',
            branch: {
              restaurantName: 'Love',
              branchName: 'Majek',
              branchId: 'private-id',
            },
            menuUrl: 'https://secret-token',
            phone: 'private-phone',
          },
          pendingAssist: {
            kind: 'group_budget',
            expiresAt: Date.now() + 10000,
          },
        },
      },
    };
    const context = customerIntentContext(c);
    expect(context).toMatchObject({
      restaurant: 'Love',
      food: 'rice',
      pendingQuestion: 'total_or_per_person',
    });
    expect(JSON.stringify(context)).not.toMatch(/private|secret/);
    c.metadata.standardFlow.discovery.expiresAt = 0;
    expect(customerIntentContext(c).food).toBeNull();
  });
  it('keeps AI order status on the ownership-checked multi-order route', () => {
    expect(
      validateCustomerAiIntent(plan('order_status'), conversation),
    ).toEqual({
      actionId: Action.ConversationAssist,
      followup: { kind: 'status' },
    });
  });
  it('allows bounded search corrections but never a payment mutation', () => {
    expect(
      validateCustomerAiIntent(
        plan('substitute', { query: 'chicken', itemQuery: 'fish' }),
        conversation,
      ),
    ).toMatchObject({
      followup: { kind: 'substitute', before: 'chicken', after: 'fish' },
    });
    expect(
      validateCustomerAiIntent(
        plan('refine_food', { itemQuery: 'yam' }),
        conversation,
      ),
    ).toMatchObject({ followup: { kind: 'refine_food', food: 'yam' } });
    expect(
      validateCustomerAiIntent(
        plan('refine_food', { itemQuery: 'yam', budgetMaxMinorUnit: 5000 }),
        conversation,
      ),
    ).toEqual({ actionId: Action.NavigationDiscover });
  });
  it('accepts a validated naira budget without inventing a restaurant', () => {
    expect(
      validateCustomerAiIntent(
        plan('search_budget', {
          budgetMaxMinorUnit: 500000,
          budgetCurrency: 'NGN',
          includesDelivery: false,
        }),
        conversation,
      ),
    ).toEqual({
      actionId: Action.OrderEntrySearch,
      restaurantSearch: {
        budget: {
          maxPriceMinorUnit: 500000,
          currency: 'NGN',
          includesDelivery: false,
        },
      },
    });
  });
  it.each([
    { budgetMaxMinorUnit: 0, budgetCurrency: 'NGN', includesDelivery: false },
    { budgetMaxMinorUnit: -5, budgetCurrency: 'NGN', includesDelivery: true },
    {
      budgetMaxMinorUnit: 500000,
      budgetCurrency: 'USD',
      includesDelivery: false,
    },
    {
      budgetMaxMinorUnit: 500000,
      budgetCurrency: 'NGN',
      includesDelivery: null,
    },
    {
      budgetMaxMinorUnit: 100000001,
      budgetCurrency: 'NGN',
      includesDelivery: false,
    },
  ])('clarifies invalid or incomplete budgets', (fields) => {
    expect(
      validateCustomerAiIntent(plan('search_budget', fields), conversation),
    ).toEqual({ actionId: Action.NavigationDiscover });
  });

  it('passes only explicit dish and restaurant search details to the backend', () => {
    expect(
      validateCustomerAiIntent(
        plan('search_menu', {
          query: 'Madam Love',
          itemQuery: 'rice',
          city: 'Lagos',
        }),
        conversation,
      ),
    ).toEqual({
      actionId: Action.OrderEntrySearch,
      restaurantSearch: { q: 'Madam Love', itemQuery: 'rice', city: 'Lagos' },
    });
  });
  it.each(['hungry', 'cheaper', 'eta', 'paid', 'support', 'reorder'])(
    'routes the bounded %s follow-up without mutation authority',
    (kind) => {
      expect(validateCustomerAiIntent(plan(kind), conversation)).toEqual({
        actionId: Action.ConversationAssist,
        followup: { kind },
      });
      expect(
        validateCustomerAiIntent(
          plan(kind, { query: 'unrelated' }),
          conversation,
        ),
      ).toEqual({ actionId: Action.NavigationDiscover });
    },
  );
  it('accepts a food request without inventing a restaurant', () => {
    expect(
      validateCustomerAiIntent(
        plan('search_menu', { itemQuery: 'rice and chicken' }),
        conversation,
      ),
    ).toEqual({
      actionId: Action.OrderEntrySearch,
      restaurantSearch: { itemQuery: 'rice and chicken' },
    });
  });
  it.each([
    plan('search_menu', { query: 'Love' }),
    plan('home', { itemQuery: 'rice' }),
    plan('search_restaurants', { query: 'Love', itemQuery: 'rice' }),
    plan('select_branch', { selectionIndex: 1, itemQuery: 'rice' }),
  ])('clarifies incomplete or unrelated dish parameters', (value) => {
    expect(validateCustomerAiIntent(value, conversation)).toEqual({
      actionId: Action.NavigationDiscover,
    });
  });

  it.each([
    'confirm',
    'cancel',
    'refund',
    'charge',
    'checkout.confirm',
    'admin',
  ])('rejects unsupported action %s', (intent) => {
    expect(() => validateCustomerAiIntent(plan(intent), conversation)).toThrow(
      'INVALID_INTENT_SCHEMA',
    );
  });
  it.each([
    plan('order_history', { orderId: 'somebody_else' }),
    plan('search_restaurants', { query: 'x'.repeat(121) }),
    plan('select_order', { selectionIndex: 1.5 }),
    plan('home', { confidence: 'maybe' }),
  ])('rejects malformed or extra fields', (value) => {
    expect(() => validateCustomerAiIntent(value, conversation)).toThrow();
  });
  it('uses only an option from the displayed order list', () => {
    const scoped = {
      ...conversation,
      state: State.ViewingOrders,
      metadata: { standardFlow: { orderCandidates: [{ orderId: 'order_1' }] } },
    };
    expect(
      validateCustomerAiIntent(
        plan('select_order', { selectionIndex: 1 }),
        scoped,
      ),
    ).toEqual({ actionId: 'order.select:order_1' });
    expect(
      validateCustomerAiIntent(
        plan('select_order', { selectionIndex: 2 }),
        scoped,
      ),
    ).toEqual({ actionId: Action.NavigationDiscover });
    expect(
      validateCustomerAiIntent(
        plan('select_order', { selectionIndex: 1 }),
        conversation,
      ),
    ).toEqual({ actionId: Action.NavigationDiscover });
  });
  it('requires a clear single intent and consistent fields', () => {
    expect(
      validateCustomerAiIntent(
        plan('payment', { confidence: 'uncertain' }),
        conversation,
      ),
    ).toEqual({ actionId: Action.NavigationDiscover });
    expect(
      validateCustomerAiIntent(
        plan('home', { query: 'private' }),
        conversation,
      ),
    ).toEqual({ actionId: Action.NavigationDiscover });
    expect(
      validateCustomerAiIntent(
        plan('search_restaurants', { query: 'Mama Tee', city: 'Lekki' }),
        conversation,
      ),
    ).toEqual({
      actionId: Action.OrderEntrySearch,
      restaurantSearch: { q: 'Mama Tee', city: 'Lekki' },
    });
  });
});

describe('CustomerAiIntentService', () => {
  it('starts typing after budget approval and before inference without waiting for feedback', async () => {
    const h = harness();
    const onInferenceStart = jest.fn(() => new Promise<void>(() => undefined));
    await expect(
      h.service.interpret({
        conversation,
        text: 'an unfamiliar request',
        deterministicInput: false,
        onInferenceStart,
      }),
    ).resolves.toMatchObject({ status: 'interpreted' });
    expect(onInferenceStart).toHaveBeenCalledTimes(1);
    expect(h.spend.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      onInferenceStart.mock.invocationCallOrder[0],
    );
    expect(onInferenceStart.mock.invocationCallOrder[0]).toBeLessThan(
      h.create.mock.invocationCallOrder[0],
    );
  });

  it.each(['rejected', 'thrown'])(
    'keeps inference working when typing feedback is %s',
    async (failure) => {
      const h = harness();
      const onInferenceStart = jest.fn(() => {
        if (failure === 'thrown') throw new Error('typing unavailable');
        return Promise.reject(new Error('typing unavailable'));
      });
      await expect(
        h.service.interpret({
          conversation,
          text: 'an unfamiliar request',
          deterministicInput: false,
          onInferenceStart,
        }),
      ).resolves.toMatchObject({
        status: 'interpreted',
        actionId: Action.HomeMyOrders,
      });
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.health.recordFailure).not.toHaveBeenCalled();
    },
  );

  it.each(['known', 'disabled', 'state', 'budget', 'breaker'])(
    'does not send AI typing feedback when blocked by %s',
    async (reason) => {
      const h = harness();
      const onInferenceStart = jest.fn().mockResolvedValue(true);
      if (reason === 'disabled') h.config.interpreterEnabled = false;
      if (reason === 'budget')
        h.spend.reserve.mockRejectedValue(new Error('budget'));
      if (reason === 'breaker') h.health.acquirePermit.mockResolvedValue(null);
      await h.service.interpret({
        conversation:
          reason === 'state'
            ? { ...conversation, state: State.AwaitingEmail }
            : conversation,
        text: 'some input',
        deterministicInput: reason === 'known',
        onInferenceStart,
      });
      expect(onInferenceStart).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
    },
  );

  it('interprets one message with a bounded structured request and reconciles spend', async () => {
    const h = harness();
    const result = await h.service.interpret({
      conversation,
      text: 'Could I see everything I have bought?',
      deterministicInput: false,
    });
    expect(result).toEqual({
      status: 'interpreted',
      actionId: Action.HomeMyOrders,
    });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.4',
        store: false,
        text: expect.objectContaining({
          format: expect.objectContaining({ strict: true }) as unknown,
        }) as unknown,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) as unknown }),
    );
    expect(h.spend.reserve).toHaveBeenCalledTimes(1);
    expect(h.spend.settle).toHaveBeenCalledTimes(1);
    expect(h.spend.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      h.create.mock.invocationCallOrder[0],
    );
  });
  it.each([
    State.AwaitingConfirmation,
    State.AwaitingFulfillment,
    State.AwaitingDeliveryAddress,
    State.AwaitingEmail,
    State.AwaitingRestaurantSearch,
  ])('never invokes AI while collecting input in %s', async (state) => {
    const h = harness();
    expect(
      await h.service.interpret({
        conversation: { ...conversation, state },
        text: 'please do it',
        deterministicInput: false,
      }),
    ).toEqual({ status: 'skipped' });
    expect(h.create).not.toHaveBeenCalled();
  });
  it('skips known commands and disabled interpretation', async () => {
    const h = harness();
    await h.service.interpret({
      conversation,
      text: 'orders',
      deterministicInput: true,
    });
    h.config.interpreterEnabled = false;
    await h.service.interpret({
      conversation,
      text: 'something unfamiliar',
      deterministicInput: false,
    });
    expect(h.spend.reserve).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('leaves database failures to inbound-job retry instead of silently dropping the message', async () => {
    const h = harness();
    h.repository.findConversationVersions.mockRejectedValue(
      new Error('database unavailable'),
    );
    await expect(
      h.service.interpret({
        conversation,
        text: 'some request',
        deterministicInput: false,
      }),
    ).rejects.toThrow('database unavailable');
  });
  it.each(['timeout', 'schema', 'refusal', 'incomplete', 'budget', 'breaker'])(
    'returns a fixed clarification after %s',
    async (failure) => {
      const h = harness();
      if (failure === 'timeout')
        h.create.mockRejectedValue(new Error('timeout'));
      if (failure === 'schema')
        h.create.mockResolvedValue({
          ...response(),
          output_text: JSON.stringify(plan('cancel')),
        });
      if (failure === 'refusal')
        h.create.mockResolvedValue({
          ...response(),
          output: [{ type: 'message', content: [{ type: 'refusal' }] }],
        });
      if (failure === 'incomplete')
        h.create.mockResolvedValue({ ...response(), status: 'incomplete' });
      if (failure === 'budget')
        h.spend.reserve.mockRejectedValue(new Error('CUSTOMER_AI_SPEND_LIMIT'));
      if (failure === 'breaker') h.health.acquirePermit.mockResolvedValue(null);
      expect(
        await h.service.interpret({
          conversation,
          text: 'an unknown message',
          deterministicInput: false,
        }),
      ).toEqual({ status: 'interpreted', actionId: Action.NavigationDiscover });
      if (failure === 'budget' || failure === 'breaker')
        expect(h.create).not.toHaveBeenCalled();
    },
  );
  it.each([
    { inputVersion: 4, stateVersion: 2 },
    { inputVersion: 3, stateVersion: 3 },
    null,
  ])(
    'drops responses after a newer message, state change, or missing conversation',
    async (versions) => {
      const h = harness();
      h.repository.findConversationVersions.mockResolvedValue(versions);
      expect(
        await h.service.interpret({
          conversation,
          text: 'some request',
          deterministicInput: false,
        }),
      ).toEqual({ status: 'stale' });
    },
  );
});

function response() {
  return {
    status: 'completed',
    output: [] as unknown[],
    output_text: JSON.stringify(plan()),
    usage: { input_tokens: 50, output_tokens: 30 },
  };
}
function harness() {
  const config = {
    interpreterEnabled: true,
    model: 'gpt-5.4',
    reasoningEffort: 'none',
    maxOutputTokens: 512,
    apiTimeoutMs: 8000,
    turnDeadlineMs: 15000,
    openAiInputCostPerMillionMinorUnit: 250,
    openAiOutputCostPerMillionMinorUnit: 1500,
  } as ConfigType<typeof customerAiConfig>;
  const create = jest.fn().mockResolvedValue(response());
  const spend = {
    reserve: jest.fn().mockResolvedValue({}),
    settle: jest.fn().mockResolvedValue(undefined),
  };
  const health = {
    acquirePermit: jest.fn().mockResolvedValue({}),
    recordSuccess: jest.fn().mockResolvedValue(undefined),
    recordFailure: jest.fn().mockResolvedValue(undefined),
  };
  const repository = {
    findConversationVersions: jest
      .fn()
      .mockResolvedValue({ inputVersion: 3, stateVersion: 2 }),
  };
  const service = new CustomerAiIntentService(
    config,
    { responses: { create } } as unknown as OpenAI,
    spend as unknown as CustomerAiSpendGuardService,
    health as unknown as CustomerAiProviderHealthService,
    repository as unknown as CustomerAiRepository,
  );
  return { service, config, create, spend, health, repository };
}
