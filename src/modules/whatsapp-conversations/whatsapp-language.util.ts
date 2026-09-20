import {
  extractWhatsappBudgetSearch,
  type WhatsappMenuBudget,
} from './whatsapp-budget.util';
import { toNullableRecord as readRecord } from '@common/utils/object.util';
import {
  WhatsappConversationState as State,
  type WhatsappConversationRecord,
} from './schemas/whatsapp-conversation.schema';
import {
  WhatsappStandardFlowActionKey as Action,
  createBranchSelectActionId,
  createOrderSelectActionId,
} from './whatsapp-standard-flow-action-registry';

/**
 * Remove conversational wrappers from an already case/emoji/whitespace-normalized
 * matching copy. The bounded passes handle stacked wording such as "abeg please
 * show ...". This is not a general translator or a sanitizer for stored names,
 * addresses or messages; those values must retain the customer's original text.
 */
export function stripWhatsappPoliteWording(text: string): string {
  let result = text.replace(/[.!?…]+$/u, '').trim();
  for (let i = 0; i < 3; i += 1) {
    result = result
      .replace(/^(?:please|pls|kindly|abeg)[, ]+/, '')
      .replace(/^(?:can|could|would|will) you (?:please )?/, '')
      .replace(/^(?:i would like to|i'd like to|i want to) /, '')
      .replace(/[, ]+(?:please|pls|thanks|thank you)$/, '')
      .trim();
  }
  return result;
}

// Explicit spelling variants only. Never fuzzy-match confirmation/cancellation.
const spellingVariants: Record<string, string> = {
  resturant: 'restaurant',
  resturants: 'restaurants',
  restaraunt: 'restaurant',
  restaraunts: 'restaurants',
  oder: 'order',
  oders: 'orders',
  reciept: 'receipt',
  reciepts: 'receipt',
  paymnt: 'payment',
  serach: 'search',
  shwo: 'show',
};

/**
 * Correct only the enumerated command spellings. Avoid approximate matching:
 * a close spelling of a restaurant name, negation or financial instruction must
 * not silently turn into a command with a different meaning.
 */
export function normalizeWhatsappCommandWording(text: string): string {
  return stripWhatsappPoliteWording(text).replace(
    /\b[a-z]+\b/g,
    (word) => spellingVariants[word] ?? word,
  );
}

export type WhatsappRestaurantSearch = {
  q?: string;
  city?: string;
  /** Dish requested by the customer, kept separate from the restaurant name. */
  itemQuery?: string;
  budget?: WhatsappMenuBudget;
};

/** Recognize an explicit dish-at-restaurant request without changing any order. */
function extractDishSearch(text: string): WhatsappRestaurantSearch | null {
  const match =
    /^(?:get|order|buy|have|find(?: me)?|show(?: me)?) (.+?) (?:from|at) (.+)$/.exec(
      text,
    );
  if (
    !match ||
    /\b(?:not|don't|dont|never|except|but|and|or|cancel|modify|change|again|instead|replace)\b/.test(
      text,
    )
  )
    return null;
  const itemQuery = match[1].replace(/^(?:some|a|an) /, '').trim();
  const location = /^(.*?)\bin (.+)$/.exec(match[2]);
  const city = location?.[2].trim();
  const q = (location ? location[1] : match[2])
    .trim()
    .replace(/^the /, '')
    .replace(/ restaurants?$/, '')
    .trim();
  if (
    !itemQuery ||
    !q ||
    itemQuery.length > 120 ||
    q.length > 120 ||
    (city?.length ?? 0) > 100
  )
    return null;
  if (
    /\b(?:restaurants?|orders?|receipts?|payments?|above|again|same)\b/.test(
      itemQuery,
    )
  )
    return null;
  return { q, itemQuery, ...(city ? { city } : {}) };
}

/**
 * A clear food craving is enough to start discovery. English and Pidgin prefixes
 * share the same route; keep the requested food words together rather than
 * guessing portions or treating "rice and chicken" as two unrelated commands.
 * Restaurant selection comes next, without creating a basket. Requests carrying
 * modifications, negations or a restaurant/location need another parser or the
 * bounded AI interpreter so this broad craving pattern does not swallow them.
 */
function extractFoodRequest(text: string): WhatsappRestaurantSearch | null {
  const match =
    /^(?:i want|i would like|i'd like|i feel like|i am craving|i'm craving|i wan chop|i wan buy|i wan|i want chop|can i (?:get|have)|could i (?:get|have)|get|order|buy|have|find(?: me)?|show(?: me)?) (.+)$/.exec(
      text,
    );
  if (
    !match ||
    /\b(?:from|at|in|near|not|don't|dont|never|except|but|or|cancel|modify|change|again|instead|replace|remove|add|without|order|orders|receipt|payment|above|same)\b/.test(
      match[1],
    ) ||
    /\d/.test(match[1])
  )
    return null;
  const itemQuery = match[1].replace(/^(?:some|a|an) /, '').trim();
  if (
    !itemQuery ||
    itemQuery.length > 120 ||
    !/\b(?:rice|chicken|fish|beef|yam|beans|pasta|noodles|pizza|burger|soup|suya|amala|eba|egusi|pounded yam|plantain|shawarma|salad|sandwich|food|meal|meals)\b/.test(
      itemQuery,
    )
  )
    return null;
  return { itemQuery };
}

/** Extract only explicit restaurant searches; never treat a bare address as one. */
export function extractWhatsappRestaurantSearch(
  normalizedText: string,
): WhatsappRestaurantSearch | null {
  const text = stripWhatsappPoliteWording(normalizedText);
  const budgetSearch = extractWhatsappBudgetSearch(text);
  if (budgetSearch) return budgetSearch;
  // Do not misroute an unparsed price constraint as a restaurant name.
  if (
    /[₦$€£]|\b(?:ngn|naira|budget|under|within)\b/.test(text) ||
    /\bn\s*\d/.test(text)
  )
    return null;
  const dishSearch = extractDishSearch(text);
  if (dishSearch) return dishSearch;
  const foodRequest = extractFoodRequest(text);
  if (foodRequest) return foodRequest;
  // Leave ambiguous dish requests to clarification; do not search for the whole
  // sentence as though it were a restaurant's name.
  if (
    /\b(?:from|at)\b/.test(text) &&
    !/^(?:find(?: me)?|search for|look for|show(?: me)?) (?:a |an )?restaurants?\b/.test(
      text,
    )
  )
    return null;
  const match = /^(?:find(?: me)?|search for|look for|show(?: me)?) (.+)$/.exec(
    text,
  );
  if (!match) return null;
  let target = match[1].trim();
  if (
    /^(?:my |the |this |that |order\b|orders\b|receipt\b|payment\b|menu\b)/.test(
      target,
    )
  )
    return null;
  // Do not turn a negated or multi-action request into a restaurant search.
  if (/\b(?:not|don't|dont|never|except|but|and|or)\b/.test(target))
    return null;
  target = target.replace(
    /^(?:a |an )?(?:restaurants?|resturants?|restaraunts?)(?: called| named)?(?: |$)/,
    '',
  );
  const location = /^(.*?)\bin (.+)$/.exec(target);
  const q = (location ? location[1] : target)
    .trim()
    .replace(/^["']|["']$/g, '');
  const city = location?.[2].trim();
  if ((!q && !city) || q.length > 120 || (city?.length ?? 0) > 100) return null;
  if (/^(?:a |an )?(?:orders?|receipts?|menu|payment)\b/.test(q)) return null;
  return { ...(q ? { q } : {}), ...(city ? { city } : {}) };
}

export function resolveWhatsappContextualFollowup(
  conversation: Pick<WhatsappConversationRecord, 'state' | 'metadata'>,
  normalizedText: string,
): string | null {
  const text = stripWhatsappPoliteWording(normalizedText).replace(
    /^(?:show(?: me)?|tell me) /,
    '',
  );
  const flow = readRecord(conversation.metadata.standardFlow);
  if (
    conversation.state === State.ViewingOrder &&
    [
      'has it been accepted',
      'has my order been accepted',
      'is it ready',
      'is my order ready',
      'what is its status',
      'what is the status',
      'where is it',
      'has it arrived',
    ].includes(text)
  )
    return Action.OrdersTrack;

  const orders = conversation.state === State.ViewingOrders;
  const branches = conversation.state === State.AwaitingBranchSelection;
  if (!orders && !branches) return null;
  const saved = orders ? flow?.orderCandidates : flow?.branchCandidates;
  const candidates = Array.isArray(saved) ? saved.slice(0, 10) : [];
  const ordinals = [
    'first',
    'second',
    'third',
    'fourth',
    'fifth',
    'sixth',
    'seventh',
    'eighth',
    'ninth',
    'tenth',
  ];
  const choice =
    /^(?:the |number |option )?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|[1-9]|10)(?: one| order| branch)?$/.exec(
      text,
    )?.[1];
  const latest =
    orders &&
    /^(?:the |my )?(?:latest|newest|most recent)(?: one| order)?$/.test(text);
  const vague = ['that one', 'this one', 'it'].includes(text);
  if (!choice && !latest && !vague) return null;
  const index = latest
    ? 0
    : choice === 'last'
      ? candidates.length - 1
      : choice && ordinals.includes(choice)
        ? ordinals.indexOf(choice)
        : choice
          ? Number(choice) - 1
          : 0;
  if (vague && candidates.length !== 1) return Action.NavigationClarify;
  const candidate = readRecord(candidates[index]);
  const id = orders ? candidate?.orderId : candidate?.branchId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{3,80}$/.test(id))
    return Action.NavigationClarify;
  return orders
    ? createOrderSelectActionId(id)
    : createBranchSelectActionId(id);
}
