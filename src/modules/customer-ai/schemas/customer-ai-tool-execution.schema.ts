import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { CustomerAiSideEffectClass } from '../customer-ai.types';

/**
 * Privacy-reduced audit row for one ordered tool execution.
 *
 * It records which contract and side-effect class ran, structural argument
 * metadata, returned opaque refs, latency, and future mutation-version fields.
 * Raw customer queries and full domain responses are intentionally excluded.
 */
@Schema({
  collection: 'customer_ai_tool_executions',
  timestamps: true,
  versionKey: false,
})
export class CustomerAiToolExecution {
  @Prop({ type: String, required: true, index: true })
  runId!: string;

  // Attempt identity prevents a tool audit from an expired worker colliding
  // with the replacement worker's audit for the same logical sequence.
  @Prop({ type: String, required: true, trim: true, maxlength: 200 })
  leaseOwner!: string;

  @Prop({ type: Number, min: 1, required: true })
  fencingToken!: number;

  @Prop({ type: Number, min: 1, required: true })
  sequence!: number;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  toolName!: string;

  @Prop({ type: String, required: true })
  contractVersion!: string;

  // Shadow currently permits only `read`; the wider enum makes future reviews
  // and policy checks explicit when draft/commit tools are introduced.
  @Prop({
    type: String,
    required: true,
    enum: ['read', 'draft_write', 'commit'],
  })
  sideEffectClass!: CustomerAiSideEffectClass;

  @Prop({ type: String, required: true, maxlength: 128 })
  argumentsHash!: string;

  @Prop({ type: Object, default: () => ({}) })
  sanitizedArgumentSummary!: Record<string, unknown>;

  @Prop({ type: String, required: true, enum: ['succeeded', 'failed'] })
  status!: 'succeeded' | 'failed';

  @Prop({ type: String, trim: true, maxlength: 120, default: null })
  domainResponseCode?: string | null;

  @Prop({ type: Number, min: 0, required: true })
  latencyMs!: number;

  @Prop({ type: Number, min: 0, default: 0 })
  retryCount!: number;

  @Prop({ type: Number, min: 0, default: 0 })
  resultCardinality!: number;

  @Prop({ type: [String], default: () => [] })
  returnedRefs!: string[];

  // Reserved mutation audit fields. Draft writes will require both an
  // idempotency key and an expected/committed optimistic version.
  @Prop({ type: String, maxlength: 128, default: null })
  idempotencyKeyHash?: string | null;

  @Prop({ type: Number, min: 0, default: null })
  expectedVersion?: number | null;

  @Prop({ type: Number, min: 0, default: null })
  committedVersion?: number | null;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const CustomerAiToolExecutionSchema = SchemaFactory.createForClass(
  CustomerAiToolExecution,
);

CustomerAiToolExecutionSchema.index(
  { runId: 1, fencingToken: 1, sequence: 1 },
  { unique: true },
);
// Tool audit data follows the same bounded-retention approach as AI runs.
CustomerAiToolExecutionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 },
);
