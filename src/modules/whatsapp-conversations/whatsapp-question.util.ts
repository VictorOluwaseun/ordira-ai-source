import type { WhatsappOutboundContent } from './types/whatsapp-outbound-content.type';

/**
 * Render a finite question using the interactive formats our provider supports.
 * The backend supplies the allowed actions; neither labels nor model output may
 * invent URLs or authorize writes. Short questions use reply buttons, while
 * longer choice sets use one list so the provider does not silently drop options.
 *
 * Callers own context validation and expiry. A question-specific action ID should
 * be used whenever the meaning of a choice can change between successive prompts.
 * Free-text entry remains available; this function only builds presentation.
 */
export function buildWhatsappChoiceQuestion(input: {
  body: string;
  choices: { id: string; title: string; description?: string }[];
  buttonText?: string;
}): WhatsappOutboundContent {
  if (
    !input.body.trim() ||
    input.choices.length < 1 ||
    input.choices.length > 10 ||
    input.choices.some((choice) => !choice.id.trim() || !choice.title.trim()) ||
    new Set(input.choices.map((choice) => choice.id)).size !==
      input.choices.length
  )
    throw new Error('Invalid WhatsApp question choices');

  const body = clip(input.body, 1024);
  if (input.choices.length <= 3)
    return {
      type: 'reply_buttons',
      body,
      buttons: input.choices.map((choice) => ({
        id: choice.id,
        title: clip(choice.title, 20),
      })),
    };
  return {
    type: 'list',
    body,
    buttonText: clip(input.buttonText ?? 'Choose an option', 20),
    sections: [
      {
        rows: input.choices.map((choice) => ({
          id: choice.id,
          title: clip(choice.title, 24),
          ...(choice.description
            ? { description: clip(choice.description, 72) }
            : {}),
        })),
      },
    ],
  };
}

/** Slice code points so truncation cannot split an emoji's surrogate pair. */
function clip(value: string, limit: number): string {
  const characters = Array.from(value.trim());
  return characters.length > limit
    ? `${characters.slice(0, limit - 1).join('')}…`
    : characters.join('');
}
