import { buildWhatsappChoiceQuestion as build } from './whatsapp-question.util';

describe('interactive questions', () => {
  const choices = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `choice:${index}`,
      title: `${index + 1}. ${'Rice and chicken '.repeat(4)}`,
      description: 'Available meal with extras '.repeat(5),
    }));

  it.each([1, 2, 3])('keeps all %i answers in reply buttons', (count) => {
    const result = build({ body: 'Which meal?', choices: choices(count) });
    if (result.type !== 'reply_buttons') throw new Error('Expected buttons');
    expect(result.buttons).toHaveLength(count);
    expect(
      result.buttons.every((button) => Array.from(button.title).length <= 20),
    ).toBe(true);
    expect(new Set(result.buttons.map((button) => button.title)).size).toBe(
      count,
    );
  });

  it.each([4, 10])(
    'keeps all %i answers in a list without provider truncation',
    (count) => {
      const result = build({ body: 'Which meal?', choices: choices(count) });
      if (result.type !== 'list') throw new Error('Expected list');
      const rows = result.sections.flatMap((section) => section.rows);
      expect(rows.map((row) => row.id)).toEqual(
        choices(count).map((choice) => choice.id),
      );
      expect(
        rows.every(
          (row) =>
            row.title.length <= 24 && (row.description?.length ?? 0) <= 72,
        ),
      ).toBe(true);
    },
  );

  it('rejects empty, oversized and duplicate choices rather than silently omitting answers', () => {
    for (const invalid of [[], choices(11), [choices(1)[0], choices(1)[0]]])
      expect(() => build({ body: 'Question', choices: invalid })).toThrow();
  });
});
