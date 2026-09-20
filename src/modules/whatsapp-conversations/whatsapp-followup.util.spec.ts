import {
  readCustomerFollowup as read,
  freshConversationContext,
} from './whatsapp-followup.util';
import { WhatsappConversationState as State } from './schemas/whatsapp-conversation.schema';
import { resolveWhatsappStandardTextAction as resolve } from './whatsapp-text-action.util';
import { WhatsappStandardFlowActionKey as Action } from './whatsapp-standard-flow-action-registry';
const home = { state: State.PlatformHome, metadata: {} };
describe('customer follow-ups', () => {
  it.each(['5', 'the fifth one', 'meal 5'])(
    'accepts %s from a longer meal list before inference',
    (text) => {
      const conversation = {
        state: State.StorefrontHandoff,
        metadata: {
          standardFlow: { discovery: { expiresAt: Date.now() + 60_000 } },
        },
      };
      expect(read(conversation, text)).toEqual({
        kind: 'suggestion',
        index: 4,
      });
      expect(resolve(conversation, text)).toBe(Action.ConversationAssist);
      expect(read(home, text)).toBeNull();
    },
  );
  it.each([
    ['Can they deliver to Lekki?', 'delivery_coverage'],
    ['Dem fit deliver to Lekki?', 'delivery_coverage'],
    ['Can they delivr to Lekki?', 'delivery_coverage'],
    ['Where is my order?', 'status'],
    ['Abeg where my food dey?', 'status'],
    ['Wher is my order?', 'status'],
    ['My order nko?', 'status'],
    ['I want to speak to someone.', 'support'],
    ['I wan talk to person', 'support'],
    ['I dey hungry', 'hungry'],
    ['This one too cost', 'cheaper'],
    ['I don pay', 'paid'],
    ['Actually I want yam instead', 'refine_food'],
    ["I'm hungry", 'hungry'],
    ['Something cheaper', 'cheaper'],
    ['How long will it take?', 'eta'],
    ['I paid already', 'paid'],
    ['Someone should help me', 'support'],
    ['Same as last time', 'reorder'],
    ['Where is my food?', 'status'],
    ["I'm allergic to peanuts", 'allergy'],
    ['Not spicy', 'preference'],
    ['Add another chicken to my order', 'change'],
    ['No chicken—fish instead', 'substitute'],
    ['Do they have grilled chicken?', 'availability'],
    ['Rice and chicken, delivered to Lekki', 'delivery'],
    ['₦5,000 for two people', 'group_budget'],
  ])('routes %s without inference', (text, kind) => {
    expect(read(home, text)?.kind).toBe(kind);
    expect(resolve(home, text)).toBe(Action.ConversationAssist);
  });
  it.each([
    'I never pay',
    'No deliver to Lekki',
    'I no wan talk to person',
    'Can they deliver to Lekki and refund me',
    'yes',
    'Do not repeat my order',
    'I have not paid',
    'I paid and cancel my order',
    '₦5000 or ₦6000 for two people',
    '$5000 for two people',
    '0 for two people',
    '1000001 for two people',
    'Cancel and refund this',
    'someone@example.com',
  ])('does not guess for %s', (text) => expect(read(home, text)).toBeNull());
  it('keeps email and address data entry out of intent matching', () => {
    expect(
      read(
        { state: State.AwaitingDeliveryAddress, metadata: {} },
        'I wan talk to person',
      ),
    ).toEqual({ kind: 'support' });
    expect(
      read({ state: State.AwaitingEmail, metadata: {} }, 'I paid'),
    ).toBeNull();
    expect(
      read(
        { state: State.AwaitingDeliveryAddress, metadata: {} },
        'No chicken—fish instead',
      ),
    ).toBeNull();
  });
  it('uses ordinals only in a displayed meal context', () => {
    expect(read(home, 'the second one')).toBeNull();
    expect(
      read(
        {
          state: State.StorefrontHandoff,
          metadata: { standardFlow: { discovery: {} } },
        },
        'the second one',
      ),
    ).toEqual({ kind: 'suggestion', index: 1 });
  });
  it('accepts budget answers only while the matching question is fresh', () => {
    const conversation = {
      state: State.PlatformHome,
      metadata: {
        standardFlow: {
          pendingAssist: {
            kind: 'group_budget',
            expiresAt: Date.now() + 10000,
          },
        },
      },
    };
    expect(resolve(conversation, 'per person')).toBe(Action.BudgetPerPerson);
    conversation.metadata.standardFlow.pendingAssist.expiresAt = 0;
    expect(resolve(conversation, 'per person')).toBeNull();
    expect(freshConversationContext({ expiresAt: 0 })).toBeNull();
  });
});
