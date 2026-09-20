import type { Schema } from 'mongoose';
import { CustomerAiRunSchema } from './customer-ai-run.schema';
import { CustomerAiSessionSchema } from './customer-ai-session.schema';
import { CustomerAiToolExecutionSchema } from './customer-ai-tool-execution.schema';

describe('customer AI TTL indexes', () => {
  it.each([
    ['run', CustomerAiRunSchema],
    ['session', CustomerAiSessionSchema],
    ['tool execution', CustomerAiToolExecutionSchema],
  ])('declares exactly one TTL index for %s expiry', (_name, schema) => {
    const expiryIndexes = indexesForField(schema, 'expiresAt');

    expect(expiryIndexes).toHaveLength(1);
    expect(expiryIndexes[0]?.[1]).toEqual(
      expect.objectContaining({ expireAfterSeconds: 0 }),
    );
  });
});

/**
 * Property-level `index: true` and an explicit TTL index produce identical key
 * patterns with different options. Keeping this assertion at the schema layer
 * prevents Mongoose from silently preferring a non-TTL duplicate in the future.
 */
function indexesForField(schema: Schema, field: string) {
  return schema
    .indexes()
    .filter(([keys]) => Object.keys(keys).length === 1 && keys[field] === 1);
}
