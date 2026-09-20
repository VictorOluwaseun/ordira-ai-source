import { randomUUID } from 'node:crypto';
import { buildWhatsappChoiceQuestion } from './whatsapp-question.util';
import { BranchOperationsService } from '@modules/branch-operations/branch-operations.service';
import { OrderFulfillmentType } from '@modules/orders/schemas/order.schema';
import {
  readCustomerFollowup,
  freshConversationContext,
  type CustomerFollowup,
} from './whatsapp-followup.util';
import { WhatsappBudgetSuggestionsService } from './whatsapp-budget-suggestions.service';
import { renderWhatsappBudgetCombinations } from './whatsapp-budget-combinations.util';
import { StorefrontMenuItemSearchSort } from '@modules/storefront-search/dto/search-storefront-menu-items.dto';
import { readWhatsappMenuBudget } from './whatsapp-budget.util';
import {
  WhatsappBudgetQuoteService,
  type WhatsappBudgetQuote,
} from './whatsapp-budget-quote.service';
import { normalizeStorefrontFilterValue } from '@modules/storefront-search/storefront-search-token-registry';
import { HttpException } from '@nestjs/common';
import { StorefrontMenuItemSearchService } from '@modules/storefront-search/storefront-menu-item-search.service';
import {
  getWhatsappRestaurantSearch,
  isWhatsappHomeCommand,
  normalizeWhatsappActionText,
  resolveWhatsappStandardTextAction,
} from './whatsapp-text-action.util';
import type { WhatsappRestaurantSearch } from './whatsapp-language.util';
import {
  renderWhatsappOrderDetails,
  splitWhatsappOrderDetails,
} from './whatsapp-order-details.util';
import { renderWhatsappOrderStatus } from '@modules/customer-notifications/templates/whatsapp-order-status.template';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { sha256 } from '@common/utils/crypto.util';
import {
  isPresent,
  toNullableRecord as readRecord,
} from '@common/utils/object.util';
import { isHttpUrl } from '@common/utils/url.util';
import {
  getErrorMessage,
  isMongoDuplicateKeyError as isDuplicateKeyError,
} from '@common/utils/error.util';
import { storefrontConfig } from '@config/storefront.config';
import type { CheckoutSessionResponse } from '@modules/checkout-sessions/types/checkout-session-response.type';
import { CheckoutSessionsService } from '@modules/checkout-sessions/checkout-sessions.service';
import {
  normalizeCustomerEmail,
  normalizeCustomerPhoneNumber,
} from '@modules/customers/schemas/customer.schema';
import {
  DEFAULT_PLATFORM_CUSTOMER_COMMUNICATION_PREFERENCES,
  type PlatformCustomerCommunicationPreferences,
} from '@modules/customers/schemas/platform-customer-identity.schema';
import { OrderAccessService } from '@modules/order-access/order-access.service';
import { OrderAccessChallengePurpose } from '@modules/order-access/schemas/order-access-challenge.schema';
import {
  PaymentStatus,
  type OrderRecord,
} from '@modules/orders/schemas/order.schema';
import { PublicStorefrontService } from '@modules/public-storefront/public-storefront.service';
import type {
  PublicStorefrontBranchCard,
  PublicStorefrontSearchItem,
} from '@modules/public-storefront/types/public-storefront-response.type';
import {
  WhatsappConversationState,
  WhatsappConversationStatus,
  type WhatsappConversationRecord,
} from './schemas/whatsapp-conversation.schema';
import type { WhatsappInboundLocation } from './schemas/whatsapp-inbound-event.schema';
import {
  WhatsappOutboundMessageStatus,
  WhatsappOutboundMessageType,
} from './schemas/whatsapp-outbound-message.schema';
import type { WhatsappOutboundContent } from './types/whatsapp-outbound-content.type';
import { WhatsappConversationsRepository } from './whatsapp-conversations.repository';
import { WhatsappOutboundDispatcherService } from './whatsapp-outbound-dispatcher.service';
import { formatWhatsappMinorUnit as formatMinorUnit } from './whatsapp-format.util';
import {
  WHATSAPP_STANDARD_FLOW_HOME_ACTIONS,
  WhatsappStandardFlowActionKey,
  createBranchSelectActionId,
  createOrderSelectActionId,
  createMealSelectActionId,
  parseWhatsappStandardFlowActionId,
} from './whatsapp-standard-flow-action-registry';
import {
  WhatsappStandardFlowTextKey,
  getWhatsappStandardFlowActionLabel,
  getWhatsappStandardFlowText,
  getWhatsappStateGuidanceText,
  type WhatsappStandardFlowCopyOverrides,
} from './whatsapp-standard-flow-copy.registry';

export type WhatsappStandardFlowInbound = {
  conversation: WhatsappConversationRecord;
  inboundEventId: string;
  providerMessageId?: string | null;
  text?: string | null;
  interactionId?: string | null;
  interactionTitle?: string | null;
  location?: WhatsappInboundLocation | null;
  /**
   * Internal handoff from the validated intent classifier, not a webhook field.
   * Supplies bounded name/city inputs to the same search used by typed commands;
   * it does not authorize a branch selection or bypass availability checks.
   */
  restaurantSearch?: WhatsappRestaurantSearch;
  followup?: CustomerFollowup;
};

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_BRANCH_SELECTION_ROWS = 10;
const RESPONSE_DEBOUNCE_MS = 3000;

type StandardFlowBranchCandidate = {
  branchId: string;
  workspaceId?: string;
  restaurantId: string;
  workspaceSlug: string;
  restaurantSlug: string;
  branchSlug: string;
  restaurantName: string;
  branchName: string;
  menuPath: string;
  distanceKm?: number;
};

type StandardFlowOrderCandidate = {
  orderId: string;
  workspaceId: string;
  restaurantId: string;
  branchId: string;
  publicCode: string;
  status: string;
  paymentStatus: string;
  branchName: string;
  totalMinorUnit: number;
  currency: string;
  createdAt: string;
};

@Injectable()
export class WhatsappStandardFlowService {
  private readonly logger = new Logger(WhatsappStandardFlowService.name);

  constructor(
    private readonly whatsappConversationsRepository: WhatsappConversationsRepository,
    private readonly outboundDispatcherService: WhatsappOutboundDispatcherService,
    @Inject(storefrontConfig.KEY)
    private readonly config: ConfigType<typeof storefrontConfig>,
    @Optional()
    private readonly publicStorefrontService?: PublicStorefrontService,
    @Optional()
    private readonly checkoutSessionsService?: CheckoutSessionsService,
    @Optional()
    private readonly orderAccessService?: OrderAccessService,
    @Optional()
    private readonly menuItemSearchService?: StorefrontMenuItemSearchService,
    @Optional()
    private readonly budgetQuoteService?: WhatsappBudgetQuoteService,
    @Optional()
    private readonly budgetSuggestionsService?: WhatsappBudgetSuggestionsService,
    @Optional()
    private readonly branchOperationsService?: BranchOperationsService,
  ) {}

  async processInbound(input: WhatsappStandardFlowInbound): Promise<void> {
    let customerServiceWindowTouched = false;
    try {
      customerServiceWindowTouched = await this.processInboundRoute(input);
    } finally {
      if (!customerServiceWindowTouched) {
        await this.touchCustomerServiceWindowSafely(input.conversation.id);
      }
    }
  }

  private async processInboundRoute(
    input: WhatsappStandardFlowInbound,
  ): Promise<boolean> {
    const typedInput = !input.interactionId;
    if (!input.interactionId) {
      const interactionId = resolveWhatsappStandardTextAction(
        input.conversation,
        input.text,
      );
      if (interactionId) input = { ...input, interactionId };
    }
    const text = normalizeWhatsappActionText(input.text);
    const action = parseWhatsappStandardFlowActionId(input.interactionId);

    if (action?.type === 'meal_select') {
      const flow = readRecord(input.conversation.metadata.standardFlow);
      const question = freshConversationContext(flow?.mealQuestion);
      const discovery = freshConversationContext(flow?.discovery);
      // Old buttons must not point at the same index in a newer set of meals.
      // Conversation-local question IDs also reject another customer's button.
      if (
        input.conversation.state !==
          WhatsappConversationState.StorefrontHandoff ||
        !question ||
        !discovery ||
        question.id !== action.questionId ||
        question.discoveryExpiresAt !== discovery.expiresAt
      ) {
        await this.queueFlowMessage(input, 'meal-question-expired', {
          type: 'text',
          text: 'That meal question is no longer current. Reply with the meal you want, or ask me to show the options again.',
        });
        return false;
      }
      return this.handleCustomerAssist(input, {
        kind: 'suggestion',
        index: action.index,
      });
    }

    if (!input.interactionId && text === 'email')
      return this.promptEmail(input);
    if (isWhatsappHomeCommand(text)) {
      return this.showHome(input);
    }
    if (action?.type === 'branch_select') {
      return this.handleBranchSelection(input, action.branchId);
    }
    if (action?.type === 'order_select') {
      return this.handleOrderSelection(input, action.orderId);
    }
    if (!input.interactionId && input.location) {
      const flow = readRecord(input.conversation.metadata.standardFlow);
      const deliveryCheck = freshConversationContext(flow?.deliveryCheck);
      // AwaitingLocation is shared by nearby discovery and delivery enquiries.
      // Dispatch by the fresh pending task before treating a pin as a nearby
      // search; an expired enquiry must not silently change the customer's goal.
      if (
        input.conversation.state ===
          WhatsappConversationState.AwaitingLocation &&
        deliveryCheck
      )
        return this.completeDeliveryCheck(input, deliveryCheck);
      if (
        input.conversation.state ===
          WhatsappConversationState.AwaitingLocation &&
        flow?.deliveryCheck &&
        !deliveryCheck
      )
        return this.queueFlowMessageThenUpdateState(
          input,
          'delivery-check-expired',
          {
            type: 'text',
            text: 'That delivery check has expired. Please tell me the restaurant and delivery area again.',
          },
          WhatsappConversationState.AwaitingOrderEntryChoice,
        );
      const pending = readPendingBudgetSearch(input.conversation);
      if (pending && isBranchCandidate(flow?.budgetBranch)) {
        return this.selectBudgetBranch(
          input,
          flow.budgetBranch,
          pending,
          input.location,
        );
      }
      return this.showNearbyBranches(input);
    }
    if (
      !input.interactionId &&
      input.conversation.state ===
        WhatsappConversationState.AwaitingRestaurantSearch &&
      text
    ) {
      return this.showSearchResults(input, input.text?.trim() ?? '');
    }
    if (
      !input.interactionId &&
      input.conversation.state === WhatsappConversationState.AwaitingEmail &&
      input.text
    ) {
      return this.updateEmail(input, input.text);
    }
    if (!input.interactionId) {
      return this.showHome(input);
    }
    if (!action || action.type !== 'action') {
      await this.sendStateGuidance(input);
      return false;
    }
    if (action.key === WhatsappStandardFlowActionKey.TellFood) {
      await this.queueFlowMessage(input, 'tell-food', {
        type: 'text',
        text: '🍽️ What would you like to eat? For example, “I want rice and chicken”.',
      });
      return false;
    }
    if (action.key === WhatsappStandardFlowActionKey.ConversationAssist)
      return this.handleCustomerAssist(
        input,
        input.followup ?? readCustomerFollowup(input.conversation, input.text),
      );
    if (
      [
        WhatsappStandardFlowActionKey.BudgetTotal,
        WhatsappStandardFlowActionKey.BudgetPerPerson,
        WhatsappStandardFlowActionKey.RepeatDraft,
      ].includes(action.key as never)
    )
      return this.handleAssistChoice(input, action.key);
    if (action.key === WhatsappStandardFlowActionKey.HomePlaceOrder) {
      return this.showOrderEntry(input);
    }
    if (action.key === WhatsappStandardFlowActionKey.NavigationClarify) {
      await this.queueFlowMessage(input, 'selection-clarification', {
        type: 'text',
        text: '🔎 Which option do you mean? Tap an option in the last list, or reply with its name or number.',
      });
      return false;
    }
    if (action.key === WhatsappStandardFlowActionKey.NavigationDiscover) {
      return this.queueFlowMessageThenUpdateState(
        input,
        'discovery-choice',
        {
          type: 'reply_buttons',
          body: text.startsWith('show')
            ? '🔎 What would you like me to show you?'
            : '🔎 What would you like to find?',
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
        },
        WhatsappConversationState.AwaitingHomeAction,
        { 'metadata.standardFlow.discoveryPrompt': true },
      );
    }
    if (action.key === WhatsappStandardFlowActionKey.OrderEntryNearby) {
      return this.requestLocation(input);
    }
    if (action.key === WhatsappStandardFlowActionKey.OrderEntrySearch) {
      // AI dispatch has a synthetic action ID and no original text to parse.
      // Prefer its validated query; ordinary typed commands keep their existing
      // local extraction, while a plain search button opens the search prompt.
      if (input.restaurantSearch)
        return this.showSearchResults(input, input.restaurantSearch);
      const search = typedInput
        ? getWhatsappRestaurantSearch(input.conversation, input.text)
        : null;
      if (search) return this.showSearchResults(input, search);
      return this.promptRestaurantSearch(input);
    }
    if (action.key === WhatsappStandardFlowActionKey.HomeAccountHelp) {
      return this.showAccountHelp(input);
    }
    if (action.key === WhatsappStandardFlowActionKey.HomeMyOrders) {
      return this.showMyOrders(input);
    }
    if (action.key === WhatsappStandardFlowActionKey.OrdersCurrent) {
      return this.showCurrentOrder(input);
    }
    if (action.key === WhatsappStandardFlowActionKey.OrdersTrack) {
      await this.sendSelectedOrderAction(
        input,
        OrderAccessChallengePurpose.SingleOrderStatus,
      );
      return false;
    }
    if (action.key === WhatsappStandardFlowActionKey.OrdersReceipt) {
      await this.sendSelectedOrderAction(
        input,
        OrderAccessChallengePurpose.SingleOrderReceipt,
        'receipt',
      );
      return false;
    }
    if (action.key === WhatsappStandardFlowActionKey.OrdersPaymentReceipt) {
      await this.sendSelectedOrderAction(
        input,
        OrderAccessChallengePurpose.SinglePaymentReceipt,
        'receipt',
      );
      return false;
    }
    if (action.key === WhatsappStandardFlowActionKey.OrdersCancelHelp) {
      await this.queueFlowMessage(input, 'cancel-order-help', {
        type: 'reply_buttons',
        body: '🛟 Do you mean an order you already submitted?\nOpen My orders to check it and contact the restaurant about cancellation. No order has been cancelled.',
        buttons: [
          {
            id: WhatsappStandardFlowActionKey.HomeMyOrders,
            title: '🧾 My orders',
          },
          {
            id: WhatsappStandardFlowActionKey.NavigationHome,
            title: '🏠 Home',
          },
        ],
      });
      return false;
    }
    if (action.key === WhatsappStandardFlowActionKey.OrdersPay) {
      await this.sendSelectedOrderAction(
        input,
        OrderAccessChallengePurpose.SingleOrderStatus,
        'payment',
      );
      return false;
    }
    if (action.key === WhatsappStandardFlowActionKey.NavigationHome) {
      return this.showHome(input);
    }
    if (action.key === WhatsappStandardFlowActionKey.AccountEmail) {
      return this.promptEmail(input);
    }
    if (action.key === WhatsappStandardFlowActionKey.AccountNotifications) {
      return this.showNotificationPreferences(input);
    }
    if (action.key === WhatsappStandardFlowActionKey.AccountHelp) {
      await this.showHelp(input);
      return false;
    }
    if (isNotificationPreferenceAction(action.key)) {
      return this.updateNotificationPreference(input, action.key);
    }
    await this.sendStateGuidance(input);
    return false;
  }

  /** Follow-ups operate on server-owned context. Read replies never authorize
   * payment or submitted-order edits; only an explicit draft-review button can
   * create a new reorder basket, which still needs normal checkout confirmation. */
  private async handleCustomerAssist(
    input: WhatsappStandardFlowInbound,
    request: CustomerFollowup | null,
    selectedOrder?: OrderRecord,
  ): Promise<boolean> {
    const flow = readRecord(input.conversation.metadata.standardFlow);
    const context =
      input.conversation.state === WhatsappConversationState.StorefrontHandoff
        ? freshConversationContext(flow?.discovery)
        : null;
    const reply = async (text: string) => {
      await this.queueFlowMessage(
        input,
        `assist-${request?.kind ?? 'clarify'}`,
        { type: 'text', text },
      );
      return false;
    };
    if (!request)
      return reply(
        'What would you like to change or check? Tell me the food or order you mean.',
      );
    if (request.kind === 'hungry') {
      return this.queueFlowMessageThenUpdateState(
        input,
        'hungry',
        {
          type: 'reply_buttons',
          body: '🍽️ Anything you’re craving, or should we explore restaurants near you?',
          buttons: [
            {
              id: WhatsappStandardFlowActionKey.OrderEntryNearby,
              title: '📍 Find nearby',
            },
            {
              id: WhatsappStandardFlowActionKey.TellFood,
              title: 'I know what I want',
            },
          ],
        },
        WhatsappConversationState.AwaitingOrderEntryChoice,
      );
    }
    if (request.kind === 'group_budget') {
      await this.whatsappConversationsRepository.updateConversation(
        input.conversation.id,
        {
          'metadata.standardFlow.pendingAssist': {
            ...request,
            expiresAt: Date.now() + 15 * 60_000,
          },
        },
      );
      await this.queueFlowMessage(
        input,
        'group-budget',
        buildWhatsappChoiceQuestion({
          body: `🍽️ Is ${formatMinorUnit(request.amount, 'NGN')} the total budget for ${request.people} people, or the budget per person?`,
          choices: [
            {
              id: WhatsappStandardFlowActionKey.BudgetTotal,
              title: 'Total budget',
            },
            {
              id: WhatsappStandardFlowActionKey.BudgetPerPerson,
              title: 'Per person',
            },
          ],
        }),
      );
      return false;
    }
    if (request.kind === 'delivery_coverage') {
      // Preserve the branch from fresh discovery when "they" refers to it.
      // Otherwise collect restaurant -> branch -> pin as a short-lived enquiry.
      // Store intent separately from checkout so checking delivery does not
      // select fulfillment or overwrite an existing basket's delivery address.
      const branch = context?.branch;
      const deliveryCheck = {
        area: request.area,
        branch: isBranchCandidate(branch) ? branch : null,
        expiresAt: Date.now() + 15 * 60_000,
      };
      await this.whatsappConversationsRepository.updateConversation(
        input.conversation.id,
        {
          'metadata.standardFlow.deliveryCheck': deliveryCheck,
        },
      );
      if (isBranchCandidate(branch))
        return this.promptDeliveryCheckLocation(input, deliveryCheck);
      return this.queueFlowMessageThenUpdateState(
        input,
        'delivery-restaurant',
        {
          type: 'text',
          text: `🛵 Which restaurant would you like delivery from? Send its name, then I’ll check ${request.area ? `your location in ${request.area}` : 'your delivery location'}.`,
        },
        WhatsappConversationState.AwaitingRestaurantSearch,
        { 'metadata.standardFlow.deliveryCheck': deliveryCheck },
      );
    }
    if (request.kind === 'refine_food') {
      // Replace the dish query while retaining the chosen branch, budget and
      // location. A viewed order or linked checkout without discovery is not a
      // search draft: send that change to the existing review/assistance flow.
      if (
        input.conversation.state === WhatsappConversationState.ViewingOrder ||
        (!context && input.conversation.checkoutSessionId)
      )
        return this.handleCustomerAssist(input, {
          kind: 'change',
          text: request.food,
        });
      if (!isBranchCandidate(context?.branch))
        return this.beginFoodSearch(input, request.food);
      return this.selectBudgetBranch(
        input,
        context.branch,
        {
          itemQuery: request.food,
          ...(readWhatsappMenuBudget(context.budget)
            ? { budget: readWhatsappMenuBudget(context.budget)! }
            : {}),
        },
        readBudgetLocation(context.location),
      );
    }
    if (request.kind === 'delivery') {
      await this.whatsappConversationsRepository.updateConversation(
        input.conversation.id,
        {
          'metadata.standardFlow.itemQuery': request.food,
          'metadata.standardFlow.deliveryRequested': true,
          'metadata.standardFlow.deliveryArea': request.area,
        },
      );
      return this.requestLocation({
        ...input,
        conversation: {
          ...input.conversation,
          state: WhatsappConversationState.AwaitingOrderEntryChoice,
          metadata: {
            ...input.conversation.metadata,
            standardFlow: { ...flow, itemQuery: request.food },
          },
        },
      });
    }
    if (request.kind === 'allergy' || request.kind === 'preference') {
      await this.whatsappConversationsRepository.updateConversation(
        input.conversation.id,
        {
          'metadata.standardFlow.foodPreference': {
            text: request.text,
            allergy: request.kind === 'allergy',
            expiresAt: Date.now() + 30 * 60_000,
          },
        },
      );
      if (
        request.kind === 'preference' &&
        this.budgetSuggestionsService &&
        isBranchCandidate(context?.branch) &&
        typeof context.menuUrl === 'string'
      ) {
        const meals = Array.isArray(context.suggestions)
          ? context.suggestions.map(readRecord)
          : [];
        const index =
          typeof context.selectedIndex === 'number'
            ? context.selectedIndex
            : meals.length === 1
              ? 0
              : -1;
        const meal = meals[index];
        if (!meal && meals.length > 1) {
          await this.whatsappConversationsRepository.updateConversation(
            input.conversation.id,
            {
              'metadata.standardFlow.foodPreference.awaitingMeal': true,
            },
          );
          return this.askMealChoice(
            input,
            context,
            '🍽️ Which meal should I check that preference for?',
          );
        }
        if (typeof meal?.menuItemId === 'string') {
          try {
            const choices =
              await this.budgetSuggestionsService.findPreferenceChoices(
                context.branch,
                meal.menuItemId,
                request.text ?? '',
              );
            if (choices.length) {
              await this.queueFlowMessage(input, 'preference-options', {
                type: 'cta_url',
                body: `🍽️ Available choices for this meal:\n${choices.map((choice) => `• ${truncateWhatsappLabel(choice, 100)}`).join('\n')}\n\nChoose the option on the menu and review the price. It has not been applied to your basket.`,
                displayText: 'Open menu',
                url: context.menuUrl,
              });
              return false;
            }
          } catch (error) {
            if (
              !(error instanceof HttpException) ||
              ![400, 404].includes(error.getStatus())
            )
              throw error;
          }
        }
      }
      return reply(
        request.kind === 'allergy'
          ? '⚠️ Please confirm ingredients and cross-contact risks with the restaurant before ordering. I can’t confirm allergy safety from a menu name or remove that risk by adding an order note.'
          : '🍽️ Choose that option under the meal’s extras or modifiers if it is available. Otherwise, ask the restaurant to confirm before ordering. I’ve noted your preference here; it has not been applied to a basket or sent to the kitchen.',
      );
    }
    if (request.kind === 'suggestion') {
      const suggestions = Array.isArray(context?.suggestions)
        ? context.suggestions.map(readRecord)
        : [];
      const index = request.index ?? (suggestions.length === 1 ? 0 : -1);
      const suggestion = suggestions[index];
      if (!suggestion || typeof suggestion.label !== 'string') {
        if (suggestions.length && context)
          return this.askMealChoice(
            input,
            context,
            '🍽️ Which meal do you mean?',
          );
        return reply(
          'Those suggestions have expired. Tell me what you’d like and I’ll check the menu again.',
        );
      }
      await this.whatsappConversationsRepository.updateConversation(
        input.conversation.id,
        {
          'metadata.standardFlow.discovery.selectedIndex': index,
          'metadata.standardFlow.mealQuestion': null,
        },
      );
      // Resume a specific clarification once; an old preference must not hijack
      // every subsequent meal selection or turn an allergy into a modifier.
      const preference = freshConversationContext(flow?.foodPreference);
      if (
        preference?.awaitingMeal &&
        !preference.allergy &&
        typeof preference.text === 'string'
      ) {
        return this.handleCustomerAssist(
          {
            ...input,
            conversation: {
              ...input.conversation,
              metadata: {
                ...input.conversation.metadata,
                standardFlow: {
                  ...flow,
                  discovery: { ...context, selectedIndex: index },
                },
              },
            },
          },
          { kind: 'preference', text: preference.text },
        );
      }
      const url = typeof context?.menuUrl === 'string' ? context.menuUrl : null;
      if (!url)
        return reply(
          'Please choose the restaurant again so I can open its current menu.',
        );
      await this.queueFlowMessage(input, 'suggestion-selected', {
        type: 'cta_url',
        body: `🍽️ You chose:\n${truncateWhatsappLabel(suggestion.label, 750)}\n\nOpen the menu to select this meal and review its current price. Nothing has been submitted.`,
        displayText: 'Open menu',
        url,
      });
      return false;
    }
    if (
      request.kind === 'cheaper' ||
      request.kind === 'availability' ||
      request.kind === 'substitute'
    ) {
      // "Fish instead" during an order/basket review is not a discovery edit.
      if (
        request.kind === 'substitute' &&
        (input.conversation.state === WhatsappConversationState.ViewingOrder ||
          (!context && input.conversation.checkoutSessionId))
      )
        return this.handleCustomerAssist(input, {
          kind: 'change',
          text: `${request.before} → ${request.after}`,
        });
      const branch = context?.branch;
      let itemQuery =
        typeof context?.itemQuery === 'string'
          ? context.itemQuery
          : readPendingDishSearch(input.conversation)?.itemQuery;
      if (request.kind === 'availability') itemQuery = request.food;
      if (request.kind === 'substitute') {
        // Replace a literal, whole food phrase in the known query, including
        // multiword dishes. Escape regex characters and use a replacement
        // callback so customer/model text cannot act as regex or $-substitution
        // syntax. If the named food is absent, ask rather than guess the target.
        if (
          !itemQuery ||
          !new RegExp(
            `\\b${request.before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
            'i',
          ).test(itemQuery)
        )
          return reply(
            `Which meal should use ${request.after} instead of ${request.before}? Tell me the dish so I don’t change the wrong thing.`,
          );
        itemQuery = itemQuery.replace(
          new RegExp(
            `\\b${request.before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
            'i',
          ),
          () => request.after,
        );
      }
      if (!isBranchCandidate(branch)) {
        if (request.kind === 'cheaper')
          return reply(
            'What budget would you like me to work within? For example, “something for ₦3,000”.',
          );
        return this.beginFoodSearch(input, itemQuery ?? 'food');
      }
      let budget = readWhatsappMenuBudget(context?.budget) ?? undefined;
      if (request.kind === 'cheaper') {
        if (context?.currency && context.currency !== 'NGN')
          return reply(
            'These menu prices use a different currency. Please check the menu for lower-priced choices; I won’t convert the budget without an exchange rate.',
          );
        const suggestions = Array.isArray(context?.suggestions)
          ? context.suggestions.map(readRecord)
          : [];
        const selected =
          typeof context?.selectedIndex === 'number'
            ? suggestions[context.selectedIndex]
            : null;
        const prices = (selected ? [selected] : suggestions)
          .map((value) => Number(value?.totalMinorUnit))
          .filter((value) => Number.isSafeInteger(value) && value > 0);
        if (!prices.length || Math.min(...prices) <= 1)
          return reply(
            'What budget would you prefer? Tell me an amount and I’ll check current menu choices.',
          );
        budget = {
          maxPriceMinorUnit: Math.min(...prices) - 1,
          currency: 'NGN',
          includesDelivery: budget?.includesDelivery ?? false,
        };
      }
      return this.selectBudgetBranch(
        input,
        branch,
        { ...(itemQuery ? { itemQuery } : {}), ...(budget ? { budget } : {}) },
        readBudgetLocation(context?.location),
      );
    }
    if (
      request.kind === 'change' &&
      input.conversation.checkoutSessionId &&
      input.conversation.state !== WhatsappConversationState.ViewingOrder &&
      !input.conversation.orderId
    ) {
      const storefront = readRecord(flow?.storefront);
      const url =
        context?.menuUrl ??
        (typeof storefront?.menuPath === 'string'
          ? toAbsoluteStorefrontUrl(storefront.menuPath, this.config.baseUrl)
          : null);
      if (typeof url === 'string') {
        await this.queueFlowMessage(input, 'basket-change', {
          type: 'cta_url',
          body: '🛍️ Open your basket to make that change and review the updated total before confirming. I haven’t changed or submitted it.',
          displayText: 'Review basket',
          url,
        });
        return false;
      }
    }
    // Every order lookup includes the customer's phone and tenant scope. Multiple
    // active orders require an explicit choice instead of guessing the newest.
    let order = selectedOrder;
    // Before-submission payments may exist before an order does. Prefer that
    // checkout over unrelated historical orders, unless the user selected one.
    if (
      request.kind === 'paid' &&
      !order &&
      input.conversation.state !== WhatsappConversationState.ViewingOrder &&
      input.conversation.checkoutSessionId &&
      this.checkoutSessionsService
    ) {
      const progress =
        await this.checkoutSessionsService.getConversationCheckoutPaymentStatus(
          {
            checkoutSessionId: input.conversation.checkoutSessionId,
            customerPhoneNumber:
              input.conversation.customerPhoneNumberNormalized,
            workspaceId: input.conversation.workspaceId,
            restaurantId: input.conversation.restaurantId,
          },
        );
      if (!progress)
        return reply(
          '💳 I couldn’t find that checkout for your WhatsApp number. Open My orders or ask for support.',
        );
      if (progress.orderId)
        order =
          (await this.findOrderForConversation(input.conversation, {
            orderId: progress.orderId,
          })) ?? undefined;
      if (!order)
        return reply(
          progress.paid
            ? '✅ Your payment is recorded. Your order submission is still being processed; please don’t pay again. Ask for support if confirmation does not arrive.'
            : '💳 Payment for your current checkout is not confirmed in our records yet. If you’ve paid, please wait for verification or ask for support; don’t pay again while confirmation is pending.',
        );
    }
    if (!order) {
      const candidate =
        input.conversation.state === WhatsappConversationState.ViewingOrder
          ? readSelectedOrderCandidate(input.conversation.metadata)
          : null;
      if (candidate)
        order =
          (await this.findOrderForConversation(input.conversation, {
            orderId: candidate.orderId,
            candidate,
          })) ?? undefined;
      // A general human-help request must not be blocked on picking an order.
      // Attach an already selected owned order above when available; otherwise
      // staff review can begin without one. Other requests still disambiguate.
      else if (request.kind !== 'support') {
        const orders =
          await this.whatsappConversationsRepository.findRecentOrdersForConversation(
            {
              phoneNumbers: phoneLookupValues(input.conversation),
              workspaceId: input.conversation.workspaceId,
              restaurantId: input.conversation.restaurantId,
              limit: 10,
              activeOnly: !['reorder', 'paid'].includes(request.kind),
            },
          );
        if (
          orders.length === 1 ||
          (request.kind === 'reorder' && orders.length)
        )
          order = orders[0];
        else if (orders.length > 1) {
          const shown = await this.showMyOrders(input);
          await this.whatsappConversationsRepository.updateConversation(
            input.conversation.id,
            {
              'metadata.standardFlow.pendingAssist': {
                ...request,
                expiresAt: Date.now() + 15 * 60_000,
              },
            },
          );
          return shown;
        }
      }
    }
    if (request.kind === 'support') {
      await this.whatsappConversationsRepository.updateConversation(
        input.conversation.id,
        {
          status: WhatsappConversationStatus.WaitingForStaff,
          'metadata.standardFlow.supportRequest': {
            requestedAt: new Date().toISOString(),
            orderId: order?.id ?? null,
            customerMessage:
              request.text ?? input.text ?? 'Customer requested support',
          },
        },
      );
      return reply(
        `🛟 I’ve marked this conversation for staff review.${order?.branchSnapshot?.phoneNumber ? ` For help with order ${order.publicCode}, you can also call ${order.branchSnapshot.phoneNumber}.` : ''} I don’t have a confirmed response time.`,
      );
    }
    if (!order)
      return reply(
        request.kind === 'eta'
          ? '⏱️ I don’t have a confirmed preparation or delivery estimate yet. Choose a restaurant and check its current checkout details; I won’t guess an arrival time.'
          : '🧾 I couldn’t find an order for this request. Open My orders to choose one, or tell me what you’d like to order.',
      );
    if (request.kind === 'status') return this.showOrderDetails(input, order);
    if (request.kind === 'paid')
      return reply(
        order.paymentStatus === PaymentStatus.Paid
          ? `✅ Payment is confirmed for *${order.publicCode}*. Your order status is ${order.status}.`
          : `💳 Payment for *${order.publicCode}* is not confirmed in our records yet. If you’ve paid, please wait for verification or ask for support; don’t pay again just because confirmation is pending.`,
      );
    if (
      request.kind === 'eta' &&
      ['completed', 'cancelled'].includes(order.status)
    )
      return reply(
        `📋 Order *${order.publicCode}* is ${order.status}. There is no pending delivery estimate for this order.`,
      );
    if (request.kind === 'eta')
      return reply(
        `⏱️ Order *${order.publicCode}* is ${order.status}. ${order.deliverySnapshot?.estimatedDeliveryMinutes ? `The saved delivery estimate is ${order.deliverySnapshot.estimatedDeliveryMinutes} minutes; this is not a live countdown or a guaranteed arrival time.` : 'There is no confirmed live arrival estimate available. We’ll send status updates here.'}`,
      );
    if (
      request.kind === 'change' &&
      !['completed', 'cancelled'].includes(order.status)
    )
      return reply(
        `📝 Order *${order.publicCode}* is ${order.status}${order.paymentStatus === PaymentStatus.Paid ? ' and paid' : ''}. Changes require restaurant approval and may affect the total.${order.branchSnapshot?.phoneNumber ? ` Contact the restaurant on ${order.branchSnapshot.phoneNumber}.` : 'Ask for support to discuss the change.'} Your order has not been changed.`,
      );
    if (request.kind === 'reorder' || request.kind === 'change') {
      await this.whatsappConversationsRepository.updateConversation(
        input.conversation.id,
        {
          'metadata.standardFlow.pendingAssist': {
            kind: 'reorder',
            orderId: order.id,
            expiresAt: Date.now() + 15 * 60_000,
          },
        },
      );
      await this.queueFlowMessage(input, 'repeat-order-prompt', {
        type: 'reply_buttons',
        body: `🛍️ ${request.kind === 'change' ? 'That order has already ended. ' : ''}Would you like a new basket based on *${order.publicCode}*? I’ll recheck availability, extras and current prices. You’ll review it before submitting or paying.`,
        buttons: [
          {
            id: WhatsappStandardFlowActionKey.RepeatDraft,
            title: 'Review new order',
          },
          {
            id: WhatsappStandardFlowActionKey.NavigationHome,
            title: '🏠 Home',
          },
        ],
      });
      return false;
    }
    return reply(
      'Tell me which meal or order you mean so I can help with the next step.',
    );
  }

  /**
   * Build options from the actual displayed meal snapshot, never model guesses.
   * Persist the question before enqueueing its message so fast replies can resolve
   * it. The expiry is capped by the source discovery; it is not renewed by taps.
   * Numbered labels stay distinguishable when the provider truncates long names.
   */
  private async askMealChoice(
    input: WhatsappStandardFlowInbound,
    context: Record<string, unknown>,
    question: string,
  ): Promise<boolean> {
    const suggestions = Array.isArray(context.suggestions)
      ? context.suggestions.map(readRecord)
      : [];
    const choices = suggestions.flatMap((meal, index) =>
      typeof meal?.label === 'string' && meal.label.trim() && index < 10
        ? [{ index, label: meal.label }]
        : [],
    );
    if (!choices.length) return false;
    const questionId = randomUUID();
    await this.whatsappConversationsRepository.updateConversation(
      input.conversation.id,
      {
        'metadata.standardFlow.mealQuestion': {
          id: questionId,
          discoveryExpiresAt: context.expiresAt,
          expiresAt: Math.min(
            Number(context.expiresAt),
            Date.now() + 15 * 60_000,
          ),
        },
      },
    );
    await this.queueFlowMessage(
      input,
      'meal-question',
      buildWhatsappChoiceQuestion({
        body: [
          question,
          ...(choices.length <= 3
            ? choices.map(
                (meal) =>
                  `${meal.index + 1}. ${truncateWhatsappLabel(meal.label, 180)}`,
              )
            : []),
          'Choose below, or reply with the meal number. You can also type a different request.',
        ].join('\n\n'),
        buttonText: 'Choose a meal',
        choices: choices.map((meal) => ({
          id: createMealSelectActionId(questionId, meal.index),
          title: `${meal.index + 1}. ${meal.label}`,
          description: meal.label,
        })),
      }),
    );
    return false;
  }

  private async handleAssistChoice(
    input: WhatsappStandardFlowInbound,
    action: string,
  ): Promise<boolean> {
    const flow = readRecord(input.conversation.metadata.standardFlow);
    const pending = freshConversationContext(flow?.pendingAssist);
    if (!pending) {
      await this.queueFlowMessage(input, 'assist-expired', {
        type: 'text',
        text: 'That question has expired. Please tell me your request again.',
      });
      return false;
    }
    if (
      (action === WhatsappStandardFlowActionKey.BudgetTotal ||
        action === WhatsappStandardFlowActionKey.BudgetPerPerson) &&
      pending.kind === 'group_budget'
    ) {
      const amount =
        Number(pending.amount) *
        (action === WhatsappStandardFlowActionKey.BudgetPerPerson
          ? Number(pending.people)
          : 1);
      const budget = readWhatsappMenuBudget({
        maxPriceMinorUnit: amount,
        currency: 'NGN',
        includesDelivery: false,
      });
      if (!budget) {
        await this.queueFlowMessage(input, 'budget-invalid', {
          type: 'text',
          text: 'Please provide a smaller total budget for the group.',
        });
        return false;
      }
      await this.whatsappConversationsRepository.updateConversation(
        input.conversation.id,
        {
          'metadata.standardFlow.pendingAssist': null,
          'metadata.standardFlow.groupSize': pending.people,
        },
      );
      await this.queueFlowMessage(input, 'group-portions', {
        type: 'text',
        text: `I’ll use ${formatMinorUnit(amount, 'NGN')} as the total budget. Menu portions vary, so suggestions are meal choices—not a guarantee of enough food for ${Number(pending.people)} people. Please check serving sizes on the menu.`,
      });
      return this.beginBudgetSearch(input, { budget });
    }
    if (
      action !== WhatsappStandardFlowActionKey.RepeatDraft ||
      pending.kind !== 'reorder' ||
      typeof pending.orderId !== 'string' ||
      !this.checkoutSessionsService
    )
      return false;
    const order = await this.findOrderForConversation(input.conversation, {
      orderId: pending.orderId,
    });
    if (!order) {
      await this.queueFlowMessage(input, 'repeat-unavailable', {
        type: 'text',
        text: 'I couldn’t find that order for your WhatsApp number.',
      });
      return false;
    }
    try {
      const saved = freshConversationContext(flow?.repeatDraft);
      let url =
        saved?.orderId === order.id && typeof saved.url === 'string'
          ? saved.url
          : null;
      let total = saved?.total;
      if (!url) {
        const session =
          await this.checkoutSessionsService.createWhatsappReorderDraft(order);
        url = session.sessionToken
          ? toAbsoluteStorefrontUrl(
              `/checkout/${encodeURIComponent(session.sessionToken)}`,
              this.config.baseUrl,
            )
          : null;
        total = formatMinorUnit(
          session.totals.totalMinorUnit,
          session.totals.currency,
        );
        if (url)
          await this.whatsappConversationsRepository.updateConversation(
            input.conversation.id,
            {
              'metadata.standardFlow.repeatDraft': {
                orderId: order.id,
                url,
                total,
                expiresAt: Math.min(
                  Date.now() + 15 * 60_000,
                  new Date(session.expiresAt).getTime(),
                ),
              },
            },
          );
      }
      if (!url) throw new Error('Reorder menu URL unavailable');
      await this.queueFlowMessage(input, 'repeat-draft', {
        type: 'cta_url',
        body: `🛍️ Your new basket is ready to review. Current food and restaurant charges: *${String(total)}*. Delivery is checked at checkout. Review the items, extras and final total before confirming. Your previous order is unchanged.`,
        displayText: 'Review new order',
        url,
      });
      return false;
    } catch (error) {
      if (
        !(error instanceof HttpException) ||
        ![400, 404].includes(error.getStatus())
      )
        throw error;
      await this.queueFlowMessage(input, 'repeat-menu-changed', {
        type: 'reply_buttons',
        body: '🍽️ Some items, extras, quantities or the branch are no longer available as ordered. Please build a new basket from the current menu; I haven’t silently replaced anything.',
        buttons: [
          {
            id: WhatsappStandardFlowActionKey.HomePlaceOrder,
            title: '🍽️ New order',
          },
          {
            id: WhatsappStandardFlowActionKey.NavigationHome,
            title: '🏠 Home',
          },
        ],
      });
      return false;
    }
  }

  private async showHome(input: WhatsappStandardFlowInbound): Promise<boolean> {
    await this.whatsappConversationsRepository.updateConversation(
      input.conversation.id,
      {
        'metadata.standardFlow.discovery': null,
        'metadata.standardFlow.pendingAssist': null,
        'metadata.standardFlow.deliveryCheck': null,
        'metadata.standardFlow.repeatDraft': null,
      },
    );
    const copyOverrides = getCopyOverrides(input.conversation.metadata);

    return this.queueFlowMessageThenUpdateState(
      input,
      'home',
      {
        type: 'reply_buttons',
        body: getWhatsappStandardFlowText(
          WhatsappStandardFlowTextKey.HomePrompt,
          {
            customerName: getFirstName(input.conversation.customerName),
          },
          copyOverrides,
        ),
        buttons: WHATSAPP_STANDARD_FLOW_HOME_ACTIONS.map((key) => ({
          id: key,
          title: getWhatsappStandardFlowActionLabel(key, copyOverrides),
        })),
      },
      WhatsappConversationState.PlatformHome,
    );
  }

  private async showOrderEntry(
    input: WhatsappStandardFlowInbound,
  ): Promise<boolean> {
    const copyOverrides = getCopyOverrides(input.conversation.metadata);

    return this.queueFlowMessageThenUpdateState(
      input,
      'order-entry',
      {
        type: 'reply_buttons',
        body: getWhatsappStandardFlowText(
          WhatsappStandardFlowTextKey.OrderEntryPrompt,
          {},
          copyOverrides,
        ),
        buttons: [
          {
            id: WhatsappStandardFlowActionKey.OrderEntryNearby,
            title: getWhatsappStandardFlowActionLabel(
              WhatsappStandardFlowActionKey.OrderEntryNearby,
              copyOverrides,
            ),
          },
          {
            id: WhatsappStandardFlowActionKey.OrderEntrySearch,
            title: getWhatsappStandardFlowActionLabel(
              WhatsappStandardFlowActionKey.OrderEntrySearch,
              copyOverrides,
            ),
          },
          {
            id: WhatsappStandardFlowActionKey.OrderEntryRecent,
            title: getWhatsappStandardFlowActionLabel(
              WhatsappStandardFlowActionKey.OrderEntryRecent,
              copyOverrides,
            ),
          },
        ],
      },
      WhatsappConversationState.AwaitingOrderEntryChoice,
    );
  }

  /**
   * Ask for a precise destination: an area such as Lekki may span several zones.
   * Carry the original enquiry expiry through this step instead of extending its
   * life on every prompt. Selecting a branch here does not start checkout or set
   * fulfillment; it identifies which branch's delivery rules to evaluate.
   */
  private promptDeliveryCheckLocation(
    input: WhatsappStandardFlowInbound,
    check: Record<string, unknown>,
  ): Promise<boolean> {
    return this.queueFlowMessageThenUpdateState(
      input,
      'delivery-check-location',
      {
        type: 'location_request',
        body: `📍 Share your delivery location${typeof check.area === 'string' && check.area ? ` in ${check.area}` : ''} so I can check this branch’s delivery coverage and fee.`,
      },
      WhatsappConversationState.AwaitingLocation,
      { 'metadata.standardFlow.deliveryCheck': check },
    );
  }

  /**
   * Answer a delivery enquiry from current public branch rules. The stored branch
   * is a reference, not proof that it remains visible, open or delivery-enabled.
   * Invalid pins remain at the question; expected branch-unavailability responses
   * end the enquiry. Infrastructure failures propagate for the inbound retry path.
   * No order, basket, payment or checkout address is written by this method.
   */
  private async completeDeliveryCheck(
    input: WhatsappStandardFlowInbound,
    check: Record<string, unknown>,
  ): Promise<boolean> {
    const branch = check.branch;
    if (
      !isBranchCandidate(branch) ||
      !input.location ||
      !this.branchOperationsService
    ) {
      await this.queueFlowMessage(input, 'delivery-check-missing', {
        type: 'text',
        text: 'Please choose the restaurant again so I can check delivery to your location.',
      });
      return false;
    }
    const { latitude, longitude } = input.location;
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      await this.queueFlowMessage(input, 'delivery-check-invalid-location', {
        type: 'text',
        text: 'Please share a valid WhatsApp location pin.',
      });
      return false;
    }
    let result: Awaited<
      ReturnType<BranchOperationsService['getPublicBranchAvailability']>
    >['delivery'];
    try {
      // Use the same public availability boundary as storefront checkout, not
      // cached branch labels or model guesses. Zero order value asks about the
      // destination without fabricating a basket total; handle minimums below.
      const availability =
        await this.branchOperationsService.getPublicBranchAvailability(
          branch.workspaceSlug,
          branch.restaurantSlug,
          branch.branchSlug,
          {
            fulfillmentType: OrderFulfillmentType.Delivery,
            latitude,
            longitude,
            orderValueMinorUnit: 0,
          },
        );
      result = availability.delivery;
    } catch (error) {
      if (
        !(error instanceof HttpException) ||
        ![400, 404].includes(error.getStatus())
      )
        throw error;
      return this.queueFlowMessageThenUpdateState(
        input,
        'delivery-check-unavailable',
        {
          type: 'text',
          text: 'This branch is no longer available for a delivery check. Please choose another restaurant.',
        },
        WhatsappConversationState.AwaitingOrderEntryChoice,
        { 'metadata.standardFlow.deliveryCheck': null },
      );
    }
    const zone = result.zone;
    // A matched zone with only a minimum-order failure still establishes
    // geographic coverage. Explain its fee/minimum rather than reporting it as
    // outside the zone. Other failures (closed, paused, disabled) remain failures;
    // even a positive answer is provisional until actual checkout validation.
    const covered =
      result.available || (result.reason === 'below_minimum_order' && !!zone);
    const detail = covered
      ? `🛵 ${branch.restaurantName} — ${branch.branchName} covers this location.${zone ? ` Delivery fee: ${formatMinorUnit(zone.deliveryFeeMinorUnit, zone.currency)}.${zone.minimumOrderMinorUnit > 0 ? ` Minimum order: ${formatMinorUnit(zone.minimumOrderMinorUnit, zone.currency)}.` : ''}` : ''} Final availability and charges are checked at checkout.`
      : result.reason === 'outside_delivery_zone'
        ? '🛵 This location is outside this branch’s current delivery area. You can choose another branch or collect your order.'
        : result.reason === 'delivery_disabled'
          ? '🛵 This branch currently does not offer delivery.'
          : '🛵 This branch cannot accept a delivery order right now. It may be closed, paused or unavailable. Please check another branch or try later.';
    const flow = readRecord(input.conversation.metadata.standardFlow);
    // Resume meal discovery only while its references remain fresh, then clear
    // the enquiry so a later location message cannot accidentally repeat it.
    return this.queueFlowMessageThenUpdateState(
      input,
      'delivery-check-result',
      { type: 'text', text: detail },
      freshConversationContext(flow?.discovery)
        ? WhatsappConversationState.StorefrontHandoff
        : WhatsappConversationState.AwaitingOrderEntryChoice,
      { 'metadata.standardFlow.deliveryCheck': null },
    );
  }

  private async requestLocation(
    input: WhatsappStandardFlowInbound,
  ): Promise<boolean> {
    const copyOverrides = getCopyOverrides(input.conversation.metadata);

    return this.queueFlowMessageThenUpdateState(
      input,
      'location-request',
      {
        type: 'location_request',
        body: readPendingBudgetSearch(input.conversation)?.budget
          ?.includesDelivery
          ? '📍 Share your delivery location so I can find nearby restaurants and include delivery fees in your budget.'
          : readPendingDishSearch(input.conversation)
            ? '📍 Share the location you want to order from, and I’ll look for nearby restaurants.'
            : getWhatsappStandardFlowText(
                WhatsappStandardFlowTextKey.LocationRequest,
                {},
                copyOverrides,
              ),
      },
      WhatsappConversationState.AwaitingLocation,
      {
        'metadata.standardFlow.budgetSearch': readPendingBudgetSearch(
          input.conversation,
        ),
        'metadata.standardFlow.itemQuery':
          readPendingDishSearch(input.conversation)?.itemQuery ?? null,
      },
    );
  }

  private async promptRestaurantSearch(
    input: WhatsappStandardFlowInbound,
  ): Promise<boolean> {
    const copyOverrides = getCopyOverrides(input.conversation.metadata);

    return this.queueFlowMessageThenUpdateState(
      input,
      'restaurant-search-prompt',
      {
        type: 'text',
        text: readPendingDishSearch(input.conversation)
          ? '🍽️ Which restaurant do you have in mind? Send me its name.'
          : getWhatsappStandardFlowText(
              WhatsappStandardFlowTextKey.RestaurantSearchPrompt,
              {},
              copyOverrides,
            ),
      },
      WhatsappConversationState.AwaitingRestaurantSearch,
      {
        'metadata.standardFlow.budgetSearch': readPendingBudgetSearch(
          input.conversation,
        ),
        'metadata.standardFlow.itemQuery':
          readPendingDishSearch(input.conversation)?.itemQuery ?? null,
      },
    );
  }

  private async showAccountHelp(
    input: WhatsappStandardFlowInbound,
  ): Promise<boolean> {
    const copyOverrides = getCopyOverrides(input.conversation.metadata);

    return this.queueFlowMessageThenUpdateState(
      input,
      'account-help',
      {
        type: 'list',
        body: getWhatsappStandardFlowText(
          WhatsappStandardFlowTextKey.AccountHelpPrompt,
          {},
          copyOverrides,
        ),
        buttonText: getWhatsappStandardFlowText(
          WhatsappStandardFlowTextKey.AccountHelpButton,
          {},
          copyOverrides,
        ),
        sections: [
          {
            rows: [
              {
                id: WhatsappStandardFlowActionKey.AccountEmail,
                title: getWhatsappStandardFlowActionLabel(
                  WhatsappStandardFlowActionKey.AccountEmail,
                  copyOverrides,
                ),
              },
              {
                id: WhatsappStandardFlowActionKey.AccountNotifications,
                title: getWhatsappStandardFlowActionLabel(
                  WhatsappStandardFlowActionKey.AccountNotifications,
                  copyOverrides,
                ),
              },
              {
                id: WhatsappStandardFlowActionKey.AccountHelp,
                title: getWhatsappStandardFlowActionLabel(
                  WhatsappStandardFlowActionKey.AccountHelp,
                  copyOverrides,
                ),
              },
              {
                id: WhatsappStandardFlowActionKey.NavigationHome,
                title: getWhatsappStandardFlowActionLabel(
                  WhatsappStandardFlowActionKey.NavigationHome,
                  copyOverrides,
                ),
              },
            ],
          },
        ],
      },
      WhatsappConversationState.AccountMenu,
    );
  }

  private async showCurrentOrder(
    input: WhatsappStandardFlowInbound,
  ): Promise<boolean> {
    this.queueTypingIndicator(input, 'current-order');
    const [order] = await this.findRecentOrdersForConversation(
      input.conversation,
      true,
    );
    if (!order) {
      return this.queueFlowMessageThenUpdateState(
        input,
        'current-order-empty',
        {
          type: 'reply_buttons',
          body: '📋 You have no active orders right now.\nWhat would you like to do?',
          buttons: [
            {
              id: WhatsappStandardFlowActionKey.NavigationHome,
              title: '🏠 Home',
            },
            {
              id: WhatsappStandardFlowActionKey.HomeMyOrders,
              title: '🧾 My orders',
            },
            {
              id: WhatsappStandardFlowActionKey.HomePlaceOrder,
              title: '🍽️ Place my order',
            },
          ],
        },
        WhatsappConversationState.PlatformHome,
      );
    }
    return this.showOrderDetails(input, order);
  }

  private async showMyOrders(
    input: WhatsappStandardFlowInbound,
    pendingOrderAction: 'payment' | 'receipt' | 'payment_receipt' | null = null,
  ): Promise<boolean> {
    this.queueTypingIndicator(input, 'my-orders');
    const orders = await this.findRecentOrdersForConversation(
      input.conversation,
    );
    const candidates = orders.map(orderToCandidate);

    if (candidates.length === 0) {
      return this.queueFlowMessageThenUpdateState(
        input,
        'orders-empty',
        {
          type: 'text',
          text: '🧾 No recent orders found for this WhatsApp number. Reply HOME to start a new order.',
        },
        WhatsappConversationState.ViewingOrders,
        {
          'metadata.standardFlow.orderCandidates': candidates,
          'metadata.standardFlow.pendingOrderAction': null,
        },
      );
    }

    return this.queueFlowMessageThenUpdateState(
      input,
      'orders-list',
      {
        type: 'list',
        body: pendingOrderAction
          ? '🧾 Which order is this for? Choose an order to continue.'
          : '🧾 Choose an order to view status, payment, or receipt options.',
        buttonText: 'Orders',
        sections: [
          {
            title: 'Recent orders',
            rows: candidates.map((order) => ({
              id: createOrderSelectActionId(order.orderId),
              title: truncateWhatsappLabel(
                `${statusEmoji(order.status)} ${order.publicCode}`,
                24,
              ),
              description: truncateWhatsappLabel(
                `${order.branchName} • ${formatMinorUnit(
                  order.totalMinorUnit,
                  order.currency,
                )}`,
                72,
              ),
            })),
          },
        ],
      },
      WhatsappConversationState.ViewingOrders,
      {
        'metadata.standardFlow.orderCandidates': candidates,
        'metadata.standardFlow.pendingOrderAction': pendingOrderAction,
      },
    );
  }

  private async handleOrderSelection(
    input: WhatsappStandardFlowInbound,
    orderId: string,
  ): Promise<boolean> {
    this.queueTypingIndicator(input, 'order-detail');
    const order = await this.findOrderForConversation(input.conversation, {
      orderId,
      candidate: findOrderCandidate(input.conversation.metadata, orderId),
    });
    if (!order) {
      await this.queueFlowMessage(input, 'order-selection-stale', {
        type: 'text',
        text: '🧾 I could not find that order for this WhatsApp number. Reply HOME to try again.',
      });
      return false;
    }

    const assistance = freshConversationContext(
      readRecord(input.conversation.metadata.standardFlow)?.pendingAssist,
    );
    if (
      input.conversation.state === WhatsappConversationState.ViewingOrders &&
      typeof assistance?.kind === 'string' &&
      ['paid', 'eta', 'change', 'support', 'status', 'reorder'].includes(
        assistance.kind,
      )
    ) {
      await this.whatsappConversationsRepository.updateConversation(
        input.conversation.id,
        { 'metadata.standardFlow.pendingAssist': null },
      );
      return this.handleCustomerAssist(
        input,
        { kind: assistance.kind } as CustomerFollowup,
        order,
      );
    }
    const pending = readRecord(
      input.conversation.metadata.standardFlow,
    )?.pendingOrderAction;
    if (
      input.conversation.state === WhatsappConversationState.ViewingOrders &&
      (pending === 'payment' ||
        pending === 'receipt' ||
        pending === 'payment_receipt')
    ) {
      await this.updateConversationState(
        input.conversation.id,
        WhatsappConversationState.ViewingOrder,
        {
          orderId: order.id,
          'metadata.standardFlow.selectedOrder': orderToCandidate(order),
          'metadata.standardFlow.pendingOrderAction': null,
        },
      );
      await this.sendSelectedOrderAction(
        input,
        pending === 'payment'
          ? OrderAccessChallengePurpose.SingleOrderStatus
          : pending === 'payment_receipt'
            ? OrderAccessChallengePurpose.SinglePaymentReceipt
            : OrderAccessChallengePurpose.SingleOrderReceipt,
        pending === 'payment' ? 'payment' : 'receipt',
        order,
      );
      return true;
    }
    return this.showOrderDetails(input, order);
  }

  private async showOrderDetails(
    input: WhatsappStandardFlowInbound,
    order: OrderRecord,
  ): Promise<boolean> {
    await this.updateConversationState(
      input.conversation.id,
      WhatsappConversationState.ViewingOrder,
      {
        orderId: order.id,
        'metadata.standardFlow.selectedOrder': orderToCandidate(order),
        'metadata.standardFlow.pendingOrderAction': null,
      },
    );

    const details = renderWhatsappOrderDetails(order);
    const scope = {
      workspaceId: order.workspaceId,
      restaurantId: order.restaurantId,
      branchId: order.branchId,
    };
    // Button bodies are limited to 1024 characters. Keep short orders in one
    // reply; longer orders get complete text parts plus the same action buttons.
    // Stable part keys make retries idempotent for this inbound selection.
    if (details.length > 1024) {
      const parts = splitWhatsappOrderDetails(details);
      for (const [index, text] of parts.entries()) {
        await this.queueFlowMessage(
          input,
          `order-detail-part-${index + 1}`,
          {
            type: 'text',
            text:
              parts.length > 1
                ? `🧾 *Order details — part ${index + 1} of ${parts.length}*\n\n${text}`
                : text,
          },
          scope,
        );
      }
    }

    await this.queueFlowMessage(
      input,
      'order-detail',
      {
        type: 'reply_buttons',
        body:
          details.length <= 1024
            ? details
            : `🧾 Order *${order.publicCode}*\nWhat would you like to do next?`,
        buttons: [
          {
            id: WhatsappStandardFlowActionKey.OrdersTrack,
            title: getWhatsappStandardFlowActionLabel(
              WhatsappStandardFlowActionKey.OrdersTrack,
            ),
          },
          {
            id:
              order.paymentStatus === PaymentStatus.Paid
                ? WhatsappStandardFlowActionKey.OrdersReceipt
                : WhatsappStandardFlowActionKey.OrdersPay,
            title: getWhatsappStandardFlowActionLabel(
              order.paymentStatus === PaymentStatus.Paid
                ? WhatsappStandardFlowActionKey.OrdersReceipt
                : WhatsappStandardFlowActionKey.OrdersPay,
            ),
          },
          {
            id: WhatsappStandardFlowActionKey.NavigationHome,
            title: getWhatsappStandardFlowActionLabel(
              WhatsappStandardFlowActionKey.NavigationHome,
            ),
          },
        ],
      },
      scope,
    );
    return true;
  }

  private async sendSelectedOrderAction(
    input: WhatsappStandardFlowInbound,
    purpose:
      | typeof OrderAccessChallengePurpose.SingleOrderStatus
      | typeof OrderAccessChallengePurpose.SingleOrderReceipt
      | typeof OrderAccessChallengePurpose.SinglePaymentReceipt,
    intent: 'status' | 'payment' | 'receipt' = 'status',
    selectedOrder?: OrderRecord,
  ): Promise<void> {
    if (intent !== 'status' && !this.orderAccessService) {
      await this.sendStateGuidance(input);
      return;
    }

    this.queueTypingIndicator(input, `order-${intent}-link`);
    const candidate =
      input.conversation.state === WhatsappConversationState.ViewingOrder
        ? readSelectedOrderCandidate(input.conversation.metadata)
        : null;
    if (!selectedOrder && !candidate && intent !== 'status') {
      await this.showMyOrders(
        input,
        intent === 'payment'
          ? 'payment'
          : purpose === OrderAccessChallengePurpose.SinglePaymentReceipt
            ? 'payment_receipt'
            : 'receipt',
      );
      return;
    }
    const order =
      selectedOrder ??
      (candidate
        ? await this.findOrderForConversation(input.conversation, {
            orderId: candidate.orderId,
            candidate,
          })
        : null);
    if (!order) {
      await this.queueFlowMessage(input, 'order-link-stale', {
        type: 'text',
        text: '🧾 I could not find that order for this WhatsApp number. Reply HOME to try again.',
      });
      return;
    }

    if (intent === 'status') {
      await this.queueFlowMessage(
        input,
        'order-status',
        {
          type: 'text',
          text: renderWhatsappOrderStatus({ order }),
        },
        {
          workspaceId: order.workspaceId,
          restaurantId: order.restaurantId,
          branchId: order.branchId,
        },
      );
      return;
    }

    const link =
      await this.orderAccessService!.createWhatsappMagicLinkForVerifiedOrder(
        order,
        purpose,
        {
          userAgent: 'ordira-whatsapp-standard-flow',
        },
      );
    const url = link.urls.redirectUrl;

    await this.queueFlowMessage(
      input,
      `order-${intent}-link`,
      {
        type: 'cta_url',
        body: orderAccessLinkText(order, intent),
        displayText:
          purpose === OrderAccessChallengePurpose.SinglePaymentReceipt
            ? 'Payment receipt'
            : intent === 'receipt'
              ? 'Open receipt'
              : 'Open order',
        url,
      },
      {
        workspaceId: order.workspaceId,
        restaurantId: order.restaurantId,
        branchId: order.branchId,
      },
    );
  }

  private async promptEmail(
    input: WhatsappStandardFlowInbound,
  ): Promise<boolean> {
    return this.queueFlowMessageThenUpdateState(
      input,
      'account-email-prompt',
      {
        type: 'text',
        text: '✉️ Send the email address you want to use for receipts and order updates.',
      },
      WhatsappConversationState.AwaitingEmail,
    );
  }

  private async updateEmail(
    input: WhatsappStandardFlowInbound,
    emailText: string,
  ): Promise<boolean> {
    const email = normalizeCustomerEmail(emailText);
    if (!email || !isLikelyEmail(email)) {
      await this.queueFlowMessage(input, 'account-email-invalid', {
        type: 'text',
        text: '✉️ That email does not look valid. Send a valid email address or reply HOME.',
      });
      return false;
    }

    this.queueTypingIndicator(input, 'account-email-update');
    await this.whatsappConversationsRepository.updatePlatformIdentityForConversation(
      {
        platformCustomerIdentityId:
          input.conversation.platformCustomerIdentityId,
        customerPhoneNumberNormalized:
          input.conversation.customerPhoneNumberNormalized,
        set: {
          email,
          emailNormalized: email,
          emailVerifiedAt: null,
        },
      },
    );
    await this.updateConversationState(
      input.conversation.id,
      WhatsappConversationState.AccountMenu,
    );
    await this.queueFlowMessage(input, 'account-email-updated', {
      type: 'text',
      text: '✉️ Email saved for future receipts and order updates. Your WhatsApp receipts will continue.',
    });
    return true;
  }

  private async showNotificationPreferences(
    input: WhatsappStandardFlowInbound,
  ): Promise<boolean> {
    const preferences =
      readConversationNotificationPreferences(input.conversation.metadata) ??
      DEFAULT_PLATFORM_CUSTOMER_COMMUNICATION_PREFERENCES;

    return this.queueFlowMessageThenUpdateState(
      input,
      'notification-preferences',
      {
        type: 'list',
        body: notificationPreferenceSummary(preferences),
        buttonText: 'Preferences',
        sections: [
          {
            title: 'Notifications',
            rows: [
              {
                id: preferences.whatsappTransactional
                  ? WhatsappStandardFlowActionKey.NotificationsWhatsappTransactionalOff
                  : WhatsappStandardFlowActionKey.NotificationsWhatsappTransactionalOn,
                title: preferences.whatsappTransactional
                  ? '🔕 WhatsApp alerts off'
                  : '✅ WhatsApp alerts on',
              },
              {
                id: preferences.emailTransactional
                  ? WhatsappStandardFlowActionKey.NotificationsEmailTransactionalOff
                  : WhatsappStandardFlowActionKey.NotificationsEmailTransactionalOn,
                title: preferences.emailTransactional
                  ? '📪 Email alerts off'
                  : '✅ Email alerts on',
              },
              {
                id: preferences.whatsappMarketing
                  ? WhatsappStandardFlowActionKey.NotificationsWhatsappMarketingOff
                  : WhatsappStandardFlowActionKey.NotificationsWhatsappMarketingOn,
                title: preferences.whatsappMarketing
                  ? '🔕 WhatsApp promos off'
                  : '🔔 WhatsApp promos on',
              },
              {
                id: preferences.emailMarketing
                  ? WhatsappStandardFlowActionKey.NotificationsEmailMarketingOff
                  : WhatsappStandardFlowActionKey.NotificationsEmailMarketingOn,
                title: preferences.emailMarketing
                  ? '📪 Email promos off'
                  : '✉️ Email promos on',
              },
            ],
          },
        ],
      },
      WhatsappConversationState.NotificationPreferences,
    );
  }

  private async updateNotificationPreference(
    input: WhatsappStandardFlowInbound,
    actionKey: WhatsappStandardFlowActionKey,
  ): Promise<boolean> {
    const patch = notificationPreferencePatch(actionKey);
    if (!patch) {
      await this.sendStateGuidance(input);
      return false;
    }

    this.queueTypingIndicator(input, 'notification-preference-update');
    const record =
      await this.whatsappConversationsRepository.updatePlatformIdentityForConversation(
        {
          platformCustomerIdentityId:
            input.conversation.platformCustomerIdentityId,
          customerPhoneNumberNormalized:
            input.conversation.customerPhoneNumberNormalized,
          set: preferenceUpdateSet(patch),
        },
      );
    const preferences =
      record?.communicationPreferences ??
      mergeNotificationPreferences(
        readConversationNotificationPreferences(input.conversation.metadata),
        patch,
      );

    await this.queueFlowMessage(input, 'notification-preference-updated', {
      type: 'text',
      text: notificationPreferenceSummary(preferences),
    });
    await this.updateConversationState(
      input.conversation.id,
      WhatsappConversationState.NotificationPreferences,
      {
        'metadata.standardFlow.notificationPreferences': preferences,
      },
    );
    return true;
  }

  private async showHelp(input: WhatsappStandardFlowInbound): Promise<void> {
    await this.queueFlowMessage(input, 'account-help-text', {
      type: 'text',
      text: [
        '🛟 Ordira help',
        'Reply HOME anytime to return to the main menu.',
        'Use My orders to track an order, open payment, or view a receipt.',
      ].join('\n'),
    });
  }

  private async findRecentOrdersForConversation(
    conversation: WhatsappConversationRecord,
    activeOnly = false,
  ): Promise<OrderRecord[]> {
    const phoneNumbers = phoneLookupValues(conversation);
    if (phoneNumbers.length === 0) {
      return [];
    }

    return this.whatsappConversationsRepository.findRecentOrdersForConversation(
      {
        phoneNumbers,
        workspaceId: conversation.workspaceId,
        restaurantId: conversation.restaurantId,
        limit: activeOnly ? 1 : 10,
        activeOnly,
      },
    );
  }

  private async findOrderForConversation(
    conversation: WhatsappConversationRecord,
    input: {
      orderId: string;
      candidate?: StandardFlowOrderCandidate | null;
    },
  ): Promise<OrderRecord | null> {
    const phoneNumbers = phoneLookupValues(conversation);
    if (phoneNumbers.length === 0) {
      return null;
    }

    return this.whatsappConversationsRepository.findOrderForConversation({
      orderId: input.orderId,
      phoneNumbers,
      workspaceId: input.candidate?.workspaceId,
      restaurantId: input.candidate?.restaurantId,
    });
  }

  private async showNearbyBranches(
    input: WhatsappStandardFlowInbound,
  ): Promise<boolean> {
    if (!this.publicStorefrontService || !input.location) {
      await this.sendStateGuidance(input);
      return false;
    }

    this.queueTypingIndicator(input, 'nearby-branches');
    const response = await this.publicStorefrontService.nearbyBranches({
      lat: input.location.latitude,
      lng: input.location.longitude,
      limit: MAX_BRANCH_SELECTION_ROWS,
    });
    const candidates = response.data.map(branchCardToCandidate);

    return this.showBranchCandidates(input, candidates, {
      responseAction: 'nearby-branches',
      body:
        candidates.length > 0
          ? readPendingDishSearch(input.conversation)?.itemQuery
            ? `📍 Here are nearby restaurants where you can check the menu for *${truncateWhatsappLabel(readPendingDishSearch(input.conversation)!.itemQuery!, 120)}*. Choose a branch.`
            : '📍 Choose a nearby branch to continue.'
          : '📍 No nearby branches found yet. Reply HOME to try another option.',
      sectionTitle: 'Nearby branches',
      itemQuery: readPendingDishSearch(input.conversation)?.itemQuery,
      budgetSearch: readPendingBudgetSearch(input.conversation) ?? undefined,
      budgetLocation: input.location,
    });
  }

  private async showSearchResults(
    input: WhatsappStandardFlowInbound,
    query: string | WhatsappRestaurantSearch,
  ): Promise<boolean> {
    if (!this.publicStorefrontService) {
      await this.sendStateGuidance(input);
      return false;
    }

    const pending =
      readPendingBudgetSearch(input.conversation) ??
      readPendingDishSearch(input.conversation);
    if (pending && (typeof query === 'string' || !query.budget)) {
      query = {
        ...pending,
        ...(typeof query === 'string' ? { q: query } : query),
      };
    }
    if (typeof query !== 'string' && query.budget) {
      if (query.q) return this.showDishSearchBranches(input, query);
      return this.beginBudgetSearch(input, query);
    }
    if (typeof query !== 'string' && query.itemQuery) {
      if (!query.q) return this.beginFoodSearch(input, query.itemQuery);
      return this.showDishSearchBranches(input, query);
    }

    this.queueTypingIndicator(input, 'restaurant-search-results');
    const response = await this.publicStorefrontService.search({
      ...(typeof query === 'string' ? { q: query } : query),
      limit: MAX_BRANCH_SELECTION_ROWS,
    });
    const candidates = response.data
      .map(searchItemToCandidate)
      .filter(isPresent);

    return this.showBranchCandidates(input, candidates, {
      responseAction: 'restaurant-search-results',
      body:
        candidates.length > 0
          ? '🔎 Choose a branch to continue.'
          : '🔎 No matching branches found. Send another search or reply HOME.',
      sectionTitle: 'Search results',
    });
  }

  private async beginFoodSearch(
    input: WhatsappStandardFlowInbound,
    itemQuery: string,
  ): Promise<boolean> {
    return this.queueFlowMessageThenUpdateState(
      input,
      'food-search-scope',
      {
        type: 'reply_buttons',
        body: `🍽️ Let’s find you some *${truncateWhatsappLabel(itemQuery, 120)}*.\n\nDo you have a restaurant in mind, or would you like me to look for one closest to you?`,
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
      },
      WhatsappConversationState.AwaitingOrderEntryChoice,
      {
        'metadata.standardFlow.itemQuery': itemQuery,
        'metadata.standardFlow.budgetSearch': null,
        'metadata.standardFlow.budgetBranch': null,
        'metadata.standardFlow.deliveryCheck': null,
        'metadata.standardFlow.budgetLocation': null,
      },
    );
  }

  private async beginBudgetSearch(
    input: WhatsappStandardFlowInbound,
    search: WhatsappRestaurantSearch,
  ): Promise<boolean> {
    return this.queueFlowMessageThenUpdateState(
      input,
      'budget-search-scope',
      {
        type: 'reply_buttons',
        body: `🍽️ Which restaurant would you like your meal from? Send its name and I’ll suggest meals with available extras, modifiers or drinks within *${formatMinorUnit(search.budget!.maxPriceMinorUnit, 'NGN')}*${search.budget!.includesDelivery ? ', including delivery' : ''}. You can also find a restaurant nearby.`,
        buttons: [
          {
            id: WhatsappStandardFlowActionKey.OrderEntryNearby,
            title: '📍 Near me',
          },
        ],
      },
      WhatsappConversationState.AwaitingRestaurantSearch,
      {
        'metadata.standardFlow.budgetSearch': search,
        'metadata.standardFlow.deliveryCheck': null,
      },
    );
  }

  /** Carry only the explicit budget and chosen branch into the existing handoff.
   * Public visibility is rechecked by handleBranchSelection before menu lookup. */
  private selectBudgetBranch(
    input: WhatsappStandardFlowInbound,
    branch: StandardFlowBranchCandidate,
    search: WhatsappRestaurantSearch,
    location?: WhatsappInboundLocation,
  ): Promise<boolean> {
    return this.handleBranchSelection(
      {
        ...input,
        conversation: {
          ...input.conversation,
          state: WhatsappConversationState.AwaitingBranchSelection,
          metadata: {
            ...input.conversation.metadata,
            standardFlow: {
              ...readRecord(input.conversation.metadata.standardFlow),
              branchCandidates: [branch],
              itemQuery: search.itemQuery ?? null,
              budgetSearch: search,
              budgetLocation: location ?? null,
            },
          },
        },
      },
      branch.branchId,
    );
  }

  /** Resolve public identities first. A shared restaurant name never selects a
   * tenant or branch implicitly, and no catalog result is supplied by the model. */
  private async showDishSearchBranches(
    input: WhatsappStandardFlowInbound,
    query: WhatsappRestaurantSearch,
  ): Promise<boolean> {
    if (!this.publicStorefrontService || !query.q) {
      await this.sendStateGuidance(input);
      return false;
    }
    const response = await this.publicStorefrontService.search({
      q: query.q,
      city: query.city,
      limit: MAX_BRANCH_SELECTION_ROWS,
    });
    const restaurants = [
      ...new Map(
        response.data.map((item) => [item.restaurantId, item]),
      ).values(),
    ];
    const profiles = await Promise.all(
      restaurants.map(async (item) => {
        try {
          return await this.publicStorefrontService!.findRestaurantProfile(
            item.workspaceSlug,
            item.restaurantSlug,
          );
        } catch (error) {
          // A restaurant can disappear between index lookup and profile read.
          // Infrastructure failures still propagate for the inbound job to retry.
          if (error instanceof HttpException && error.getStatus() === 404)
            return null;
          throw error;
        }
      }),
    );
    const candidates = profiles.flatMap(
      (profile) =>
        profile?.branches
          .filter(
            (branch) =>
              !query.city ||
              normalizeStorefrontFilterValue(branch.address.city) ===
                normalizeStorefrontFilterValue(query.city),
          )
          .map(branchCardToCandidate) ?? [],
    );
    return this.showBranchCandidates(
      input,
      candidates.slice(0, MAX_BRANCH_SELECTION_ROWS),
      {
        responseAction: 'dish-search-branches',
        body: candidates.length
          ? `🍽️ Looking for ${query.itemQuery ? `*${query.itemQuery}*` : 'food'}${query.budget ? ` within *${formatMinorUnit(query.budget.maxPriceMinorUnit, query.budget.currency)}*` : ''}. Choose the restaurant and branch whose menu you want to see.${response.meta?.hasNextPage || candidates.length > MAX_BRANCH_SELECTION_ROWS ? '\nShowing the first matches. You can send a more specific restaurant search.' : ''}`
          : `🔎 I couldn't find a public branch for *${query.q}*. Try another restaurant name or reply HOME.`,
        sectionTitle: 'Choose a branch',
        itemQuery: query.itemQuery,
        budgetSearch: query.budget ? query : undefined,
      },
    );
  }

  private async showBranchCandidates(
    input: WhatsappStandardFlowInbound,
    candidates: StandardFlowBranchCandidate[],
    copy: {
      responseAction: string;
      body: string;
      sectionTitle: string;
      itemQuery?: string;
      budgetSearch?: WhatsappRestaurantSearch;
      budgetLocation?: WhatsappInboundLocation;
    },
  ): Promise<boolean> {
    if (candidates.length === 0) {
      return this.queueFlowMessageThenUpdateState(
        input,
        copy.responseAction,
        {
          type: 'text',
          text: copy.body,
        },
        WhatsappConversationState.AwaitingOrderEntryChoice,
        {
          'metadata.standardFlow.branchCandidates': candidates,
          'metadata.standardFlow.deliveryCheck': freshConversationContext(
            readRecord(input.conversation.metadata.standardFlow)?.deliveryCheck,
          ),
          'metadata.standardFlow.itemQuery': null,
        },
      );
    }

    return this.queueFlowMessageThenUpdateState(
      input,
      copy.responseAction,
      {
        type: 'list',
        body: copy.body,
        buttonText: 'Branches',
        sections: [
          {
            title: copy.sectionTitle,
            rows: candidates
              .slice(0, MAX_BRANCH_SELECTION_ROWS)
              .map((branch) => ({
                id: createBranchSelectActionId(branch.branchId),
                title: truncateWhatsappLabel(
                  `${branch.restaurantName} - ${branch.branchName}`,
                  24,
                ),
                description: branch.distanceKm
                  ? `${branch.distanceKm.toFixed(1)} km away`
                  : copy.itemQuery || copy.budgetSearch
                    ? truncateWhatsappLabel(
                        `${branch.restaurantName} — ${branch.branchName}`,
                        72,
                      )
                    : branch.menuPath,
              })),
          },
        ],
      },
      WhatsappConversationState.AwaitingBranchSelection,
      {
        'metadata.standardFlow.branchCandidates': candidates,
        'metadata.standardFlow.deliveryCheck': freshConversationContext(
          readRecord(input.conversation.metadata.standardFlow)?.deliveryCheck,
        ),
        'metadata.standardFlow.itemQuery':
          copy.itemQuery ?? copy.budgetSearch?.itemQuery ?? null,
        'metadata.standardFlow.budgetSearch': copy.budgetSearch ?? null,
        'metadata.standardFlow.budgetLocation': copy.budgetLocation ?? null,
      },
    );
  }

  private async handleBranchSelection(
    input: WhatsappStandardFlowInbound,
    branchId: string,
  ): Promise<boolean> {
    let branch = findBranchCandidate(input.conversation.metadata, branchId);
    if (!branch || !this.checkoutSessionsService) {
      await this.sendStateGuidance(input);
      return false;
    }

    const flow = readRecord(input.conversation.metadata.standardFlow);
    const deliveryCheck = freshConversationContext(flow?.deliveryCheck);
    if (
      deliveryCheck &&
      input.conversation.state ===
        WhatsappConversationState.AwaitingBranchSelection
    )
      return this.promptDeliveryCheckLocation(input, {
        ...deliveryCheck,
        branch,
      });
    const itemQuery =
      input.conversation.state ===
        WhatsappConversationState.AwaitingBranchSelection &&
      typeof flow?.itemQuery === 'string'
        ? flow.itemQuery
        : null;
    let discoveryCurrency: string | null = null;
    let discoverySuggestions: Array<{
      label: string;
      totalMinorUnit: number;
      menuItemId: string;
    }> = [];
    let body = `🍽️ Continue with ${branch.restaurantName} - ${branch.branchName}.`;
    const budget = readPendingBudgetSearch(input.conversation)?.budget;
    if (itemQuery || budget) {
      if (!this.publicStorefrontService || !this.menuItemSearchService) {
        await this.sendStateGuidance(input);
        return false;
      }
      try {
        // Recheck public visibility after the customer chooses a saved result.
        const profile = await this.publicStorefrontService.findBranchProfile(
          branch.workspaceSlug,
          branch.restaurantSlug,
          branch.branchSlug,
        );
        if (
          profile.branch.branchId !== branch.branchId ||
          profile.branch.restaurantId !== branch.restaurantId
        ) {
          await this.sendStateGuidance(input);
          return false;
        }
        branch = branchCardToCandidate(profile.branch);
      } catch (error) {
        if (!(error instanceof HttpException) || error.getStatus() !== 404)
          throw error;
        return this.queueFlowMessageThenUpdateState(
          input,
          'dish-branch-unavailable',
          {
            type: 'text',
            text: '🍽️ That branch is no longer available. Search for another restaurant or reply HOME.',
          },
          WhatsappConversationState.AwaitingOrderEntryChoice,
        );
      }
      let deliveredQuote: WhatsappBudgetQuote | null = null;
      if (budget) {
        const location = readBudgetLocation(flow?.budgetLocation);
        if (budget.includesDelivery && !location) {
          return this.queueFlowMessageThenUpdateState(
            input,
            'budget-delivery-location',
            {
              type: 'location_request',
              body: `📍 Share your delivery location so I can check meals within ${formatMinorUnit(budget.maxPriceMinorUnit, budget.currency)}, including delivery and restaurant charges.`,
            },
            WhatsappConversationState.AwaitingLocation,
            {
              'metadata.standardFlow.budgetSearch': {
                budget,
                ...(itemQuery ? { itemQuery } : {}),
              },
              'metadata.standardFlow.budgetBranch': branch,
            },
          );
        }
        if (this.budgetQuoteService && branch.workspaceId) {
          deliveredQuote = await this.budgetQuoteService.resolve({
            workspaceId: branch.workspaceId,
            restaurantId: branch.restaurantId,
            branchId: branch.branchId,
            latitude: location?.latitude,
            longitude: location?.longitude,
            budget,
          });
        }
        if (!deliveredQuote) {
          return this.queueFlowMessageThenUpdateState(
            input,
            'budget-delivery-unavailable',
            {
              type: 'reply_buttons',
              body: budget.includesDelivery
                ? `🍽️ I couldn't find a delivery estimate within ${formatMinorUnit(budget.maxPriceMinorUnit, budget.currency)} for this branch and location. Delivery availability, fees or minimum order requirements may prevent it. Try another branch or a different budget.`
                : `🍽️ I couldn't calculate meal combinations within ${formatMinorUnit(budget.maxPriceMinorUnit, budget.currency)} for this branch. Try another restaurant or a different budget.`,
              buttons: [
                {
                  id: WhatsappStandardFlowActionKey.OrderEntryNearby,
                  title: '📍 Near me',
                },
                {
                  id: WhatsappStandardFlowActionKey.OrderEntrySearch,
                  title: '🔎 Find restaurant',
                },
              ],
            },
            WhatsappConversationState.AwaitingOrderEntryChoice,
            {
              'metadata.standardFlow.budgetSearch': {
                budget,
                ...(itemQuery ? { itemQuery } : {}),
              },
            },
          );
        }
      }
      if (budget && deliveredQuote) {
        if (!this.budgetSuggestionsService || !branch.workspaceId) {
          await this.sendStateGuidance(input);
          return false;
        }
        const scope = {
          branchId: branch.branchId,
          restaurantId: branch.restaurantId,
          currency: budget.currency,
        };
        // Fetch separate bounded food/drink sets before pagination, so a page of
        // cheap drinks cannot hide meals. The drink query must not inherit a
        // dish term such as "rice". Minimum delivery spend applies to the sum.
        const query = {
          maxPriceMinorUnit: deliveredQuote.maxPriceMinorUnit,
          limit: 50,
          includeUnavailable: false,
          sort: StorefrontMenuItemSearchSort.PriceAsc,
        };
        const [foods, drinks] = await Promise.all([
          this.menuItemSearchService.search(
            { ...query, ...(itemQuery ? { q: itemQuery } : {}) },
            { ...scope, itemKind: 'food' },
          ),
          this.menuItemSearchService.search(query, {
            ...scope,
            itemKind: 'drink',
          }),
        ]);
        const combinations = await this.budgetSuggestionsService.suggest({
          foods: foods.data,
          drinks: drinks.data,
          budget,
          quote: deliveredQuote,
          scope: {
            workspaceId: branch.workspaceId,
            restaurantId: branch.restaurantId,
            branchId: branch.branchId,
            workspaceSlug: branch.workspaceSlug,
            restaurantSlug: branch.restaurantSlug,
            branchSlug: branch.branchSlug,
          },
        });
        body = renderWhatsappBudgetCombinations({
          restaurantName: branch.restaurantName,
          branchName: branch.branchName,
          budget,
          combinations,
        });
        discoveryCurrency = budget.currency;
        discoverySuggestions = combinations.flatMap((combo, index) =>
          body.includes(`${index + 1}. *`)
            ? [
                {
                  label: [
                    combo.food.name,
                    ...(combo.foodModifiers ?? []).map(
                      (m) => `${m.quantity} × ${m.name}`,
                    ),
                    ...(combo.drink ? [combo.drink.name] : []),
                    ...(combo.drinkModifiers ?? []).map(
                      (m) => `${m.quantity} × ${m.name}`,
                    ),
                    formatMinorUnit(combo.totalMinorUnit, budget.currency),
                  ].join(' + '),
                  totalMinorUnit: combo.totalMinorUnit,
                  menuItemId: combo.food.menuItemId,
                },
              ]
            : [],
        );
      } else {
        const result = await this.menuItemSearchService.search(
          {
            q: itemQuery ?? undefined,
            limit: 5,
            includeUnavailable: false,
          },
          { branchId: branch.branchId, restaurantId: branch.restaurantId },
        );
        discoveryCurrency = result.data[0]?.currency ?? null;
        discoverySuggestions = result.data.map((item) => ({
          label: `${item.name} — ${formatMinorUnit(item.basePriceMinorUnit, item.currency)} (base price)`,
          totalMinorUnit: item.basePriceMinorUnit,
          menuItemId: item.menuItemId,
        }));
        const heading = `🍽️ *${truncateWhatsappLabel(branch.restaurantName, 100)} — ${truncateWhatsappLabel(branch.branchName, 80)}*`;
        body = result.data.length
          ? [
              heading,
              `Here are menu matches for *${truncateWhatsappLabel(itemQuery ?? '', 120)}*:`,
              ...result.data.map(
                (item, index) =>
                  `${index + 1}. ${truncateWhatsappLabel(item.name, 70)} — ${formatMinorUnit(item.basePriceMinorUnit, item.currency)}`,
              ),
              `${result.meta.hasNextPage ? 'More options are available on the menu. ' : ''}These are base prices; extras may cost more.`,
              'Open the menu to choose your dish, quantity and extras.',
            ].join('\n\n')
          : `${heading}\n\nI couldn't find an available menu match for *${truncateWhatsappLabel(itemQuery ?? '', 120)}*. Open the menu to browse other dishes.`;
      }
    }

    this.queueTypingIndicator(input, 'storefront-handoff');
    const session =
      await this.checkoutSessionsService.createWhatsappStandardDraftCheckoutSession(
        {
          workspaceSlug: branch.workspaceSlug,
          restaurantSlug: branch.restaurantSlug,
          branchSlug: branch.branchSlug,
          customer: {
            firstName: getFirstName(input.conversation.customerName),
            phoneNumber: input.conversation.customerPhoneNumberNormalized,
          },
        },
      );

    const storefrontUrl = toAbsoluteStorefrontUrl(
      getCheckoutSessionStorefrontPath(session, branch),
      this.config.baseUrl,
    );
    if (!storefrontUrl) {
      this.logger.warn(
        JSON.stringify({
          event: 'whatsapp_standard_flow_storefront_url_unavailable',
          responseAction: 'storefront-handoff',
          conversationId: input.conversation.id,
          branchId: branch.branchId,
          hasStorefrontBaseUrl: Boolean(this.config.baseUrl),
        }),
      );
    }

    await this.queueFlowMessage(
      input,
      'storefront-handoff',
      storefrontUrl
        ? {
            type: 'cta_url',
            body,
            displayText: 'Open menu',
            url: storefrontUrl,
          }
        : {
            type: 'text',
            text: '🍽️ Your menu is almost ready, but we could not open the storefront link right now. Please try again shortly.',
          },
    );
    await this.updateConversationForStorefrontHandoff(
      input.conversation.id,
      branch,
      session,
    );
    await this.whatsappConversationsRepository.updateConversation(
      input.conversation.id,
      {
        'metadata.standardFlow.discovery': {
          branch,
          itemQuery,
          budget: budget ?? null,
          location: readBudgetLocation(flow?.budgetLocation) ?? null,
          suggestions: discoverySuggestions,
          currency: discoveryCurrency,
          menuUrl: storefrontUrl,
          expiresAt: Math.min(
            Date.now() + 30 * 60_000,
            new Date(session.expiresAt).getTime(),
          ),
        },
      },
    );
    return true;
  }

  private async sendStateGuidance(
    input: WhatsappStandardFlowInbound,
  ): Promise<void> {
    const copyOverrides = getCopyOverrides(input.conversation.metadata);

    await this.queueFlowMessage(input, 'guidance', {
      type: 'text',
      text: getWhatsappStateGuidanceText(
        input.conversation.state,
        copyOverrides,
      ),
    });
  }

  private async queueFlowMessage(
    input: WhatsappStandardFlowInbound,
    responseAction: string,
    content: WhatsappOutboundContent,
    scope: {
      workspaceId?: string | null;
      restaurantId?: string | null;
      branchId?: string | null;
    } = {},
  ): Promise<void> {
    try {
      const message =
        await this.whatsappConversationsRepository.createOutboundMessage({
          workspaceId:
            scope.workspaceId ?? input.conversation.workspaceId ?? null,
          restaurantId:
            scope.restaurantId ?? input.conversation.restaurantId ?? null,
          branchId: scope.branchId ?? input.conversation.branchId ?? null,
          channelId: input.conversation.channelId ?? null,
          conversationId: input.conversation.id,
          checkoutSessionId: null,
          orderId: null,
          toPhoneNumber: input.conversation.customerPhoneNumber,
          toPhoneNumberNormalized:
            input.conversation.customerPhoneNumberNormalized,
          messageType:
            content.type === 'text'
              ? WhatsappOutboundMessageType.Text
              : WhatsappOutboundMessageType.Interactive,
          text: content.type === 'text' ? content.text : textSummary(content),
          content,
          payload: {
            source: 'whatsapp_standard_flow',
            responseAction,
          },
          status: WhatsappOutboundMessageStatus.Queued,
          attemptCount: 0,
          maxAttempts: 3,
          nextAttemptAt: new Date(),
          idempotencyKeyHash: hashStandardFlowIdempotencyKey(
            input.conversation.id,
            input.inboundEventId,
            responseAction,
          ),
          createdByUserId: null,
        });
      this.logger.log({
        event: 'whatsapp_latency_outbound_message_created',
        source: 'whatsapp_standard_flow',
        responseAction,
        inboundEventId: input.inboundEventId,
        outboundMessageId: message.id,
        conversationId: input.conversation.id,
        channelId: input.conversation.channelId ?? null,
        checkoutSessionId: input.conversation.checkoutSessionId ?? null,
        orderId: input.conversation.orderId ?? null,
        hasTenantScope: Boolean(
          scope.workspaceId ?? input.conversation.workspaceId,
        ),
      });
      await this.outboundDispatcherService.enqueueOutboundMessage(message.id);
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      this.logger.debug({
        event: 'whatsapp_standard_flow_duplicate_outbound_skipped',
        conversationId: input.conversation.id,
        responseAction,
      });
      return;
    }
  }

  private queueTypingIndicator(
    input: WhatsappStandardFlowInbound,
    reason: string,
  ): void {
    void this.outboundDispatcherService
      .sendTypingIndicator({
        conversation: input.conversation,
        providerMessageId: input.providerMessageId,
        reason,
      })
      .catch((error: unknown) => {
        this.logger.debug({
          event: 'whatsapp_standard_flow_typing_indicator_failed',
          conversationId: input.conversation.id,
          reason,
          error: getErrorMessage(error),
        });
      });
  }

  private async queueFlowMessageThenUpdateState(
    input: WhatsappStandardFlowInbound,
    responseAction: string,
    content: WhatsappOutboundContent,
    state: WhatsappConversationState,
    extraSet: Record<string, unknown> = {},
    scope: {
      workspaceId?: string | null;
      restaurantId?: string | null;
      branchId?: string | null;
    } = {},
  ): Promise<boolean> {
    const now = new Date();
    const debounce = createResponseDebounce(responseAction, content, now);
    const claimed =
      await this.whatsappConversationsRepository.claimStandardFlowResponseDebounce(
        {
          conversationId: input.conversation.id,
          responseAction: debounce.responseAction,
          contentHash: debounce.contentHash,
          expiresAt: debounce.expiresAt,
          now,
        },
      );
    if (!claimed) {
      this.logger.debug({
        event: 'whatsapp_standard_flow_response_debounced',
        conversationId: input.conversation.id,
        responseAction,
      });
      return false;
    }

    await this.queueFlowMessage(input, responseAction, content, scope);
    await this.updateConversationState(input.conversation.id, state, extraSet);
    return true;
  }

  private async updateConversationState(
    conversationId: string,
    state: WhatsappConversationState,
    extraSet: Record<string, unknown> = {},
  ): Promise<void> {
    const now = new Date();
    // Transient searches/enquiries are cleared on a general state transition.
    // A continuing step explicitly preserves only its needed fresh context in
    // extraSet, applied last. Keep that ordering: otherwise restaurant/branch
    // selection would lose the delivery question, or unrelated flows inherit it.
    await this.whatsappConversationsRepository.updateConversation(
      conversationId,
      {
        state,
        status: WhatsappConversationStatus.WaitingForCustomer,
        lastOutboundAt: now,
        lastCustomerMessageAt: now,
        serviceWindowExpiresAt: new Date(now.getTime() + SERVICE_WINDOW_MS),
        ...(state !== WhatsappConversationState.AwaitingBranchSelection
          ? { 'metadata.standardFlow.itemQuery': null }
          : {}),
        'metadata.standardFlow.budgetSearch': null,
        'metadata.standardFlow.budgetBranch': null,
        'metadata.standardFlow.deliveryCheck': null,
        'metadata.standardFlow.budgetLocation': null,
        'metadata.standardFlow.mealQuestion': null,
        ...extraSet,
      },
    );
  }

  private async updateConversationForStorefrontHandoff(
    conversationId: string,
    branch: StandardFlowBranchCandidate,
    session: CheckoutSessionResponse,
  ): Promise<void> {
    const now = new Date();
    await this.whatsappConversationsRepository.updateConversation(
      conversationId,
      {
        'metadata.standardFlow.itemQuery': null,
        'metadata.standardFlow.budgetSearch': null,
        'metadata.standardFlow.budgetBranch': null,
        'metadata.standardFlow.deliveryCheck': null,
        'metadata.standardFlow.budgetLocation': null,
        checkoutSessionId: session.id,
        orderId: null,
        checkoutSessionCode: session.sessionCode,
        state: WhatsappConversationState.StorefrontHandoff,
        status: WhatsappConversationStatus.WaitingForCustomer,
        lastOutboundAt: now,
        lastCustomerMessageAt: now,
        serviceWindowExpiresAt: new Date(now.getTime() + SERVICE_WINDOW_MS),
        'metadata.standardFlow.storefront': {
          workspaceId: session.workspaceId,
          restaurantId: session.restaurantId,
          branchId: session.branchId,
          workspaceSlug: branch.workspaceSlug,
          restaurantSlug: branch.restaurantSlug,
          branchSlug: branch.branchSlug,
          menuPath: session.storefrontResumeUrl ?? branch.menuPath,
        },
      },
    );
  }

  private async touchCustomerServiceWindow(
    conversationId: string,
  ): Promise<void> {
    const now = new Date();
    await this.whatsappConversationsRepository.updateConversation(
      conversationId,
      {
        lastCustomerMessageAt: now,
        serviceWindowExpiresAt: new Date(now.getTime() + SERVICE_WINDOW_MS),
      },
    );
  }

  private async touchCustomerServiceWindowSafely(
    conversationId: string,
  ): Promise<void> {
    try {
      await this.touchCustomerServiceWindow(conversationId);
    } catch (error) {
      this.logger.warn({
        event: 'whatsapp_standard_flow_touch_failed',
        conversationId,
        error: getErrorMessage(error),
      });
    }
  }
}

function getFirstName(name: string | null | undefined): string {
  const firstName = name?.trim().split(/\s+/)[0];

  return firstName || 'there';
}

function textSummary(content: WhatsappOutboundContent): string {
  if (content.type === 'reply_buttons' || content.type === 'list') {
    return content.body;
  }
  if (content.type === 'location_request') {
    return content.body;
  }
  if (content.type === 'cta_url') {
    return content.body;
  }
  if (
    content.type === 'image' ||
    content.type === 'receipt_image' ||
    content.type === 'receipt'
  ) {
    return content.caption ?? '';
  }

  return content.text;
}

function createResponseDebounce(
  responseAction: string,
  content: WhatsappOutboundContent,
  now: Date,
): {
  responseAction: string;
  contentHash: string;
  expiresAt: Date;
} {
  return {
    responseAction,
    contentHash: hashResponseContent(responseAction, content),
    expiresAt: new Date(now.getTime() + RESPONSE_DEBOUNCE_MS),
  };
}

function hashResponseContent(
  responseAction: string,
  content: WhatsappOutboundContent,
): string {
  return sha256(`${responseAction}:${textSummary(content)}`);
}

function getCheckoutSessionStorefrontPath(
  session: CheckoutSessionResponse,
  branch: StandardFlowBranchCandidate,
): string {
  if (session.sessionToken) {
    return `/checkout/${encodeURIComponent(session.sessionToken)}`;
  }

  return session.storefrontResumeUrl ?? branch.menuPath;
}

function toAbsoluteStorefrontUrl(pathOrUrl: string, baseUrl: string | null) {
  if (isHttpUrl(pathOrUrl)) {
    return pathOrUrl;
  }

  if (!baseUrl) {
    return null;
  }

  try {
    return new URL(pathOrUrl, ensureTrailingSlash(baseUrl)).toString();
  } catch {
    return null;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function branchCardToCandidate(
  branch: PublicStorefrontBranchCard,
): StandardFlowBranchCandidate {
  return {
    branchId: branch.branchId,
    workspaceId: branch.workspaceId,
    restaurantId: branch.restaurantId,
    workspaceSlug: branch.workspaceSlug,
    restaurantSlug: branch.restaurantSlug,
    branchSlug: branch.branchSlug,
    restaurantName: branch.restaurantName,
    branchName: branch.branchName,
    menuPath: branch.menuPath,
    distanceKm: branch.distanceKm,
  };
}

function searchItemToCandidate(
  item: PublicStorefrontSearchItem,
): StandardFlowBranchCandidate | null {
  if (item.type !== 'branch' || !item.branchId || !item.branchSlug) {
    return null;
  }

  return {
    branchId: item.branchId,
    restaurantId: item.restaurantId,
    workspaceSlug: item.workspaceSlug,
    restaurantSlug: item.restaurantSlug,
    branchSlug: item.branchSlug,
    restaurantName: item.name,
    branchName: 'Branch',
    menuPath: item.menuPath,
    distanceKm: item.distanceKm,
  };
}

function findBranchCandidate(
  metadata: Record<string, unknown>,
  branchId: string,
): StandardFlowBranchCandidate | null {
  const standardFlow = readRecord(metadata.standardFlow);
  const branchCandidates = standardFlow?.branchCandidates;
  const candidates: unknown[] = Array.isArray(branchCandidates)
    ? branchCandidates
    : [];
  const match = candidates.find(
    (candidate) =>
      isBranchCandidate(candidate) && candidate.branchId === branchId,
  );

  return isBranchCandidate(match) ? match : null;
}

function isBranchCandidate(
  value: unknown,
): value is StandardFlowBranchCandidate {
  const record = readRecord(value);
  if (!record) {
    return false;
  }

  return (
    typeof record.branchId === 'string' &&
    (record.workspaceId === undefined ||
      typeof record.workspaceId === 'string') &&
    typeof record.restaurantId === 'string' &&
    typeof record.workspaceSlug === 'string' &&
    typeof record.restaurantSlug === 'string' &&
    typeof record.branchSlug === 'string' &&
    typeof record.restaurantName === 'string' &&
    typeof record.branchName === 'string' &&
    typeof record.menuPath === 'string'
  );
}

function orderToCandidate(order: OrderRecord): StandardFlowOrderCandidate {
  return {
    orderId: order.id,
    workspaceId: order.workspaceId,
    restaurantId: order.restaurantId,
    branchId: order.branchId,
    publicCode: order.publicCode,
    status: order.status,
    paymentStatus: order.paymentStatus,
    branchName: order.branchSnapshot?.name ?? 'Branch',
    totalMinorUnit: order.totalMinorUnit,
    currency: order.currency,
    createdAt: order.createdAt.toISOString(),
  };
}

function findOrderCandidate(
  metadata: Record<string, unknown>,
  orderId: string,
): StandardFlowOrderCandidate | null {
  const standardFlow = readRecord(metadata.standardFlow);
  const orderCandidates = standardFlow?.orderCandidates;
  const candidates: unknown[] = Array.isArray(orderCandidates)
    ? orderCandidates
    : [];
  const match = candidates.find(
    (candidate) => isOrderCandidate(candidate) && candidate.orderId === orderId,
  );

  return isOrderCandidate(match) ? match : null;
}

function readSelectedOrderCandidate(
  metadata: Record<string, unknown>,
): StandardFlowOrderCandidate | null {
  const standardFlow = readRecord(metadata.standardFlow);

  return isOrderCandidate(standardFlow?.selectedOrder)
    ? standardFlow.selectedOrder
    : null;
}

function isOrderCandidate(value: unknown): value is StandardFlowOrderCandidate {
  const record = readRecord(value);
  if (!record) {
    return false;
  }

  return (
    typeof record.orderId === 'string' &&
    typeof record.workspaceId === 'string' &&
    typeof record.restaurantId === 'string' &&
    typeof record.branchId === 'string' &&
    typeof record.publicCode === 'string' &&
    typeof record.status === 'string' &&
    typeof record.paymentStatus === 'string' &&
    typeof record.branchName === 'string' &&
    typeof record.totalMinorUnit === 'number' &&
    typeof record.currency === 'string' &&
    typeof record.createdAt === 'string'
  );
}

function orderAccessLinkText(
  order: OrderRecord,
  intent: 'payment' | 'receipt',
): string {
  if (intent === 'receipt') {
    return `🧾 Open the secure receipt for order ${order.publicCode}.`;
  }
  return `💳 Open the secure order page to complete payment for ${order.publicCode}.`;
}

function statusEmoji(status: string): string {
  if (status === 'submitted') {
    return '✅';
  }
  if (status === 'preparing' || status === 'accepted') {
    return '👨‍🍳';
  }
  if (status === 'ready') {
    return '🛍️';
  }
  if (status === 'out_for_delivery') {
    return '🛵';
  }
  if (status === 'completed') {
    return '🧾';
  }
  if (status === 'cancelled' || status === 'rejected') {
    return '❌';
  }

  return '🧾';
}

function phoneLookupValues(conversation: WhatsappConversationRecord): string[] {
  const values = [
    conversation.customerPhoneNumber,
    conversation.customerPhoneNumberNormalized,
  ];
  const normalizedValues = values.flatMap((value) => {
    if (!value) {
      return [];
    }

    try {
      return [value, normalizeCustomerPhoneNumber(value)];
    } catch {
      return [value];
    }
  });

  return [...new Set(normalizedValues.filter(Boolean))];
}

function isLikelyEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function notificationPreferenceSummary(
  preferences: PlatformCustomerCommunicationPreferences,
): string {
  return [
    '🔔 Notification preferences',
    `WhatsApp alerts: ${preferences.whatsappTransactional ? 'on' : 'off'}`,
    `Email alerts: ${preferences.emailTransactional ? 'on' : 'off'}`,
    `WhatsApp promos: ${preferences.whatsappMarketing ? 'on' : 'off'}`,
    `Email promos: ${preferences.emailMarketing ? 'on' : 'off'}`,
  ].join('\n');
}

function readConversationNotificationPreferences(
  metadata: Record<string, unknown>,
): PlatformCustomerCommunicationPreferences | null {
  const standardFlow = readRecord(metadata.standardFlow);
  const preferences = readRecord(standardFlow?.notificationPreferences);
  if (!preferences) {
    return null;
  }

  return {
    whatsappTransactional: readBoolean(
      preferences.whatsappTransactional,
      DEFAULT_PLATFORM_CUSTOMER_COMMUNICATION_PREFERENCES.whatsappTransactional,
    ),
    emailTransactional: readBoolean(
      preferences.emailTransactional,
      DEFAULT_PLATFORM_CUSTOMER_COMMUNICATION_PREFERENCES.emailTransactional,
    ),
    whatsappMarketing: readBoolean(
      preferences.whatsappMarketing,
      DEFAULT_PLATFORM_CUSTOMER_COMMUNICATION_PREFERENCES.whatsappMarketing,
    ),
    emailMarketing: readBoolean(
      preferences.emailMarketing,
      DEFAULT_PLATFORM_CUSTOMER_COMMUNICATION_PREFERENCES.emailMarketing,
    ),
  };
}

function mergeNotificationPreferences(
  current: PlatformCustomerCommunicationPreferences | null,
  patch: Partial<PlatformCustomerCommunicationPreferences>,
): PlatformCustomerCommunicationPreferences {
  return {
    ...DEFAULT_PLATFORM_CUSTOMER_COMMUNICATION_PREFERENCES,
    ...(current ?? {}),
    ...patch,
  };
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function isNotificationPreferenceAction(
  key: WhatsappStandardFlowActionKey,
): boolean {
  return Boolean(notificationPreferencePatch(key));
}

function notificationPreferencePatch(
  key: WhatsappStandardFlowActionKey,
): Partial<PlatformCustomerCommunicationPreferences> | null {
  if (
    key === WhatsappStandardFlowActionKey.NotificationsWhatsappTransactionalOn
  ) {
    return { whatsappTransactional: true };
  }
  if (
    key === WhatsappStandardFlowActionKey.NotificationsWhatsappTransactionalOff
  ) {
    return { whatsappTransactional: false };
  }
  if (key === WhatsappStandardFlowActionKey.NotificationsEmailTransactionalOn) {
    return { emailTransactional: true };
  }
  if (
    key === WhatsappStandardFlowActionKey.NotificationsEmailTransactionalOff
  ) {
    return { emailTransactional: false };
  }
  if (key === WhatsappStandardFlowActionKey.NotificationsWhatsappMarketingOn) {
    return { whatsappMarketing: true };
  }
  if (key === WhatsappStandardFlowActionKey.NotificationsWhatsappMarketingOff) {
    return { whatsappMarketing: false };
  }
  if (key === WhatsappStandardFlowActionKey.NotificationsEmailMarketingOn) {
    return { emailMarketing: true };
  }
  if (key === WhatsappStandardFlowActionKey.NotificationsEmailMarketingOff) {
    return { emailMarketing: false };
  }

  return null;
}

function preferenceUpdateSet(
  patch: Partial<PlatformCustomerCommunicationPreferences>,
): Record<string, boolean> {
  return Object.entries(patch).reduce<Record<string, boolean>>(
    (updates, [key, value]) => {
      if (typeof value === 'boolean') {
        updates[`communicationPreferences.${key}`] = value;
      }

      return updates;
    },
    {},
  );
}

function truncateWhatsappLabel(label: string, maxLength: number): string {
  if (label.length <= maxLength) {
    return label;
  }

  return `${label.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function hashStandardFlowIdempotencyKey(
  conversationId: string,
  inboundEventId: string,
  responseAction: string,
): string {
  return sha256(
    `standard-flow:${conversationId}:${inboundEventId}:${responseAction}`,
  );
}

function getCopyOverrides(
  metadata: Record<string, unknown>,
): WhatsappStandardFlowCopyOverrides | null {
  const copyMetadata =
    readRecord(metadata.standardFlowCopy) ??
    readRecord(metadata.platformExperienceCopy);

  if (!copyMetadata) {
    return null;
  }

  return {
    brandName: toNullableString(copyMetadata.brandName),
    actionLabels: readActionLabelOverrides(copyMetadata.actionLabels),
    text: readTextOverrides(copyMetadata.text),
  };
}

function readActionLabelOverrides(
  value: unknown,
): Partial<Record<WhatsappStandardFlowActionKey, string>> | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }

  return Object.values(WhatsappStandardFlowActionKey).reduce<
    Partial<Record<WhatsappStandardFlowActionKey, string>>
  >((labels, key) => {
    const label = toNullableString(record[key]);
    if (label) {
      labels[key] = label;
    }

    return labels;
  }, {});
}

function readTextOverrides(
  value: unknown,
): Partial<Record<WhatsappStandardFlowTextKey, string>> | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }

  return Object.values(WhatsappStandardFlowTextKey).reduce<
    Partial<Record<WhatsappStandardFlowTextKey, string>>
  >((labels, key) => {
    const label = toNullableString(record[key]);
    if (label) {
      labels[key] = label;
    }

    return labels;
  }, {});
}

function toNullableString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return value.trim() || undefined;
}

/** Retain food intent only during discovery; HOME and a completed handoff
 * must not make a later restaurant search inherit an old craving. */
function readPendingDishSearch(
  conversation: WhatsappConversationRecord,
): WhatsappRestaurantSearch | null {
  if (
    !(
      [
        WhatsappConversationState.AwaitingOrderEntryChoice,
        WhatsappConversationState.AwaitingRestaurantSearch,
        WhatsappConversationState.AwaitingLocation,
        WhatsappConversationState.AwaitingBranchSelection,
      ] as WhatsappConversationState[]
    ).includes(conversation.state)
  )
    return null;
  const itemQuery = readRecord(conversation.metadata.standardFlow)?.itemQuery;
  return typeof itemQuery === 'string' && itemQuery.trim()
    ? { itemQuery: itemQuery.trim() }
    : null;
}

/** Pending budgets apply only while choosing a restaurant/branch/location. */
function readPendingBudgetSearch(
  conversation: WhatsappConversationRecord,
): WhatsappRestaurantSearch | null {
  if (
    !(
      [
        WhatsappConversationState.AwaitingOrderEntryChoice,
        WhatsappConversationState.AwaitingRestaurantSearch,
        WhatsappConversationState.AwaitingLocation,
        WhatsappConversationState.AwaitingBranchSelection,
      ] as WhatsappConversationState[]
    ).includes(conversation.state)
  )
    return null;
  const search = readRecord(
    readRecord(conversation.metadata.standardFlow)?.budgetSearch,
  );
  const budget = readWhatsappMenuBudget(search?.budget);
  return budget
    ? {
        budget,
        ...(typeof search?.itemQuery === 'string'
          ? { itemQuery: search.itemQuery }
          : {}),
      }
    : null;
}

function readBudgetLocation(
  value: unknown,
): WhatsappInboundLocation | undefined {
  const location = readRecord(value);
  if (
    !location ||
    typeof location.latitude !== 'number' ||
    typeof location.longitude !== 'number' ||
    !Number.isFinite(location.latitude) ||
    !Number.isFinite(location.longitude) ||
    Math.abs(location.latitude) > 90 ||
    Math.abs(location.longitude) > 180
  )
    return undefined;
  return { latitude: location.latitude, longitude: location.longitude };
}
