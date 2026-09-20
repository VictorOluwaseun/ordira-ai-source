import { toNullableRecord as record } from '@common/utils/object.util';
import {
  WhatsappConversationState as State,
  type WhatsappConversationRecord,
} from './schemas/whatsapp-conversation.schema';

/**
 * Semantic requests shared by the rules parser and the AI-output validator.
 * These describe what the customer means, not permission to mutate an order.
 * The standard-flow handler resolves current records, ownership and availability
 * before replying; checkout confirmation stays in the checkout flow.
 */
export type CustomerFollowup =
  | {
      kind:
        | 'hungry'
        | 'cheaper'
        | 'eta'
        | 'paid'
        | 'support'
        | 'reorder'
        | 'change'
        | 'preference'
        | 'allergy'
        | 'status';
      text?: string;
    }
  | { kind: 'substitute'; before: string; after: string }
  | { kind: 'availability'; food: string }
  | { kind: 'delivery'; food: string; area: string }
  | { kind: 'delivery_coverage'; area: string }
  | { kind: 'refine_food'; food: string }
  | { kind: 'group_budget'; amount: number; people: number }
  | { kind: 'suggestion'; index?: number };

/**
 * Recognize familiar English/Pidgin follow-ups without a model call. Match whole
 * requests so a keyword inside a longer or negated sentence cannot trigger an
 * unrelated action. Returning null declines this parser; the caller determines
 * whether another rule, field-entry handler or the AI interpreter is eligible.
 *
 * Address/email entry is excluded except for an explicit request for a human.
 * Normalization is local to matching: it must not rewrite stored customer data.
 */
export function readCustomerFollowup(
  conversation: Pick<WhatsappConversationRecord, 'state' | 'metadata'>,
  input?: string | null,
): CustomerFollowup | null {
  const text = (input ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(/^(?:please|pls|abeg)[, ]+/, '')
    .replace(/[, ]+(?:please|pls|abeg)$/, '');
  // A full, explicit request for a person may interrupt address/email entry;
  // ordinary field values still never pass through intent matching.
  if (
    /^(?:i want to (?:speak|talk) to someone|i wan (?:talk|speak) to person|speak to an agent|i need a human)$/.test(
      text,
    )
  )
    return { kind: 'support' };
  if (
    !text ||
    text.length > 500 ||
    [
      State.AwaitingEmail,
      State.AwaitingEmailVerification,
      State.AwaitingDeliveryAddress,
    ].includes(conversation.state as never)
  )
    return null;
  // Whole-phrase aliases only: do not globally autocorrect customer names,
  // addresses, amounts or negations. Less familiar wording can reach the AI in
  // eligible states. In particular, "I don pay" requests a payment-status read;
  // it is not evidence of payment, and "I never pay" must not match this alias.
  const aliases: Record<string, CustomerFollowup['kind']> = {
    'i dey hungry': 'hungry',
    'hunger dey wire me': 'hungry',
    'wetin i fit chop': 'hungry',
    'e too cost': 'cheaper',
    'this one too cost': 'cheaper',
    'i don pay': 'paid',
    'i don pay already': 'paid',
    'where my food dey': 'status',
    'where my order dey': 'status',
    'my order nko': 'status',
    'where is my oder': 'status',
    'wher is my order': 'status',
    'where is my ordr': 'status',
    'where my order': 'status',
    'wetin happen to my order': 'status',
    'how far my order': 'status',
    'i wan talk to person': 'support',
    'i wan speak to person': 'support',
    'i want to speak to someone': 'support',
    'i want to talk to someone': 'support',
    'i want to speek to someone': 'support',
    'i need suport': 'support',
    'when my food go reach': 'eta',
    'how long e go take': 'eta',
    'give me wetin i buy last time': 'reorder',
  };
  if (aliases[text]) return { kind: aliases[text] } as CustomerFollowup;
  // An area name identifies the question, not a delivery zone or an address.
  // The handler must obtain a branch and precise pin before checking coverage.
  const coverage =
    /^(?:can (?:they|you) (?:deliver|delivr)|do (?:they|you) deliver|(?:dem|una) (?:dey|fit) deliver|delivery) to ([a-z][a-z '-]{0,79})$/.exec(
      text,
    );
  if (
    coverage &&
    !/\b(?:not|and|or|instead|but|cancel|refund)\b/.test(coverage[1])
  )
    return { kind: 'delivery_coverage', area: coverage[1] };
  // Only a complete, simple replacement request is deterministic here. Mixed
  // instructions and order/payment changes need a different handler or clarity.
  const refinement =
    /^(?:actually[, ]+(?:i want |make (?:it|am) )?|make (?:it|am) )([a-z ]{1,100}) instead$/.exec(
      text,
    );
  if (
    refinement &&
    !/\b(?:not|no|cancel|pay|refund|pickup|delivery|order|and|or)\b/.test(
      refinement[1],
    )
  )
    return { kind: 'refine_food', food: refinement[1].trim() };
  if (
    /^(?:i'm hungry|i am hungry|hungry|i need food|what should i eat)$/.test(
      text,
    )
  )
    return { kind: 'hungry' };
  if (
    /^(?:something cheaper|anything cheaper|show me cheaper options|cheaper|that's too expensive|that is too expensive|too expensive)$/.test(
      text,
    )
  )
    return { kind: 'cheaper' };
  if (
    /^(?:how long (?:will it take|does it take)|when will (?:it|my food|my order) arrive|what is the delivery time)$/.test(
      text,
    )
  )
    return { kind: 'eta' };
  if (
    /^(?:i (?:have )?(?:paid|already paid)|i paid already|payment (?:made|completed|successful))$/.test(
      text,
    )
  )
    return { kind: 'paid' };
  if (
    /^(?:someone should help me|i need (?:a human|help)|speak to (?:someone|a human|an agent)|talk to (?:someone|a human|an agent)|customer support)$/.test(
      text,
    )
  )
    return { kind: 'support' };
  if (
    /^(?:same as last time|(?:i want )?(?:the )?same (?:order|thing) again|order (?:it |that )?again|reorder|repeat my (?:last )?order)$/.test(
      text,
    )
  )
    return { kind: 'reorder' };
  if (/^(?:where is my (?:food|order)|where's my food)$/.test(text))
    return { kind: 'status' };
  if (
    /^(?:(?:i am|i'm) allergic to|i have an? .+ allergy|allergic to) .+/.test(
      text,
    ) ||
    /^i have an? .+ allergy$/.test(text)
  )
    return { kind: 'allergy', text };
  if (
    /^(?:not spicy|no onions|no pepper|less spicy|without onions|without pepper|make it mild)$/.test(
      text,
    )
  )
    return { kind: 'preference', text };
  if (
    /^(?:add|remove|change|modify|replace) .{1,180}(?:my order|my basket|my cart)$/.test(
      text,
    ) ||
    /^(?:i want to )?(?:modify|change) (?:my|the|this) order(?: .*)?$/.test(
      text,
    )
  )
    return { kind: 'change', text };
  const substitution =
    /^no ([a-z ]{1,50})[ ,—–-]+([a-z ]{1,50}) instead$/.exec(text) ??
    /^(?:replace|swap) ([a-z ]{1,50}) (?:with|for) ([a-z ]{1,50})$/.exec(text);
  if (
    substitution &&
    !/\b(?:order|cancel|refund|pay|and|or)\b/.test(
      substitution[1] + ' ' + substitution[2],
    )
  )
    return {
      kind: 'substitute',
      before: substitution[1].trim().replace(/^the /, ''),
      after: substitution[2].trim().replace(/^the /, ''),
    };
  const availability =
    /^(?:do (?:they|you) have|is there|can i get) ([a-z ]{1,100})$/.exec(text);
  if (
    availability &&
    !/\b(?:order|refund|receipt|and|or|from|at)\b/.test(availability[1])
  )
    return { kind: 'availability', food: availability[1] };
  const delivery =
    /^(?:i want |get |order )?([a-z ,&]{1,100})[ ,]+(?:delivered to|for delivery to) ([a-z ]{1,80})$/.exec(
      text,
    );
  if (delivery && !/\b(?:cancel|refund|change|modify|not)\b/.test(text))
    return {
      kind: 'delivery',
      food: delivery[1].replace(/^some /, '').replace(/[, ]+$/, ''),
      area: delivery[2],
    };
  const group =
    /^(?:(?:something|food|meals?) for )?(?:₦|n\s*|ngn\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\s*naira)? for (two|three|four|five|six|[2-9]|1[0-2]) (?:people|persons)$/.exec(
      text,
    );
  if (group) {
    const amount = Number(group[1].replace(/,/g, '')) * 100;
    const people =
      (
        { two: 2, three: 3, four: 4, five: 5, six: 6 } as Record<string, number>
      )[group[2]] ?? Number(group[2]);
    if (amount > 0 && amount <= 100000000)
      return { kind: 'group_budget', amount, people };
  }
  // Short replies have meaning only in the meal-discovery step. An omitted
  // index deliberately leaves "yes/that one" unresolved: the handler checks
  // fresh suggestions and asks which meal if more than one remains possible.
  // A suggestion selection must never become checkout confirmation.
  if (
    conversation.state === State.StorefrontHandoff &&
    record(conversation.metadata.standardFlow)?.discovery
  ) {
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
      /^(?:the |option |number |meal |na the )?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|10|[1-9])(?: one| one abeg)?$/.exec(
        text,
      )?.[1];
    if (choice)
      return {
        kind: 'suggestion',
        index: ordinals.includes(choice)
          ? ordinals.indexOf(choice)
          : Number(choice) - 1,
      };
    if (
      /^(?:that looks good|that one|this one|i like that|looks good|yes|yeah|yep|ok|okay|na that one|that one good|show options again|show meals|show the options)$/.test(
        text,
      )
    )
      return { kind: 'suggestion' };
  }
  return null;
}

/**
 * Expired references behave like missing context; do not revive an old meal,
 * branch or pending question just because its metadata still exists. This only
 * checks record shape and expiry. Callers must validate the payload they need.
 * An injectable clock keeps expiry-boundary tests independent of wall time.
 */
export function freshConversationContext(
  value: unknown,
  now = Date.now(),
): Record<string, unknown> | null {
  const context = record(value);
  return context &&
    typeof context.expiresAt === 'number' &&
    context.expiresAt > now
    ? context
    : null;
}
