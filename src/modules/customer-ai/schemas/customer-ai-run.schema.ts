import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type {
  CustomerAiMode,
  CustomerAiProviderName,
  CustomerAiReasoningEffort,
} from '@config/types/env.types';
import type { HydratedDocument } from 'mongoose';
import { Types } from 'mongoose';
import type {
  CustomerAiPhase,
  CustomerAiRunStatus,
} from '../customer-ai.types';
import type { CustomerAiPolicySignals } from '../customer-ai-policy.service';

export type CustomerAiRunDocument = HydratedDocument<CustomerAiRun> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Immutable input/config snapshot plus execution outcome for one inbound event.
 * A run is the unit claimed by a worker and the primary audit record used to
 * reproduce which model, contracts, limits, and conversation versions applied.
 */
@Schema({
  collection: 'customer_ai_runs',
  timestamps: true,
  versionKey: false,
})
export class CustomerAiRun {
  // Causal/domain identity captured when shadow observation occurs.
  @Prop({ type: String, required: true, index: true })
  conversationId!: string;

  @Prop({ type: String, required: true, unique: true, index: true })
  inboundEventId!: string;

  @Prop({ type: String, default: null, index: true })
  workspaceId?: string | null;

  @Prop({ type: String, default: null, index: true })
  restaurantId?: string | null;

  @Prop({ type: String, default: null, index: true })
  branchId?: string | null;

  // Rollout mode and the customer-journey phase seen by the provider.
  @Prop({ type: String, required: true })
  mode!: CustomerAiMode;

  @Prop({ type: String, required: true, default: 'discovery' })
  phase!: CustomerAiPhase;

  @Prop({
    type: String,
    required: true,
    enum: [
      'queued',
      'running',
      'shadow_completed',
      'failed',
      'timed_out',
      'superseded',
      'handed_off',
    ],
    default: 'queued',
    index: true,
  })
  status!: CustomerAiRunStatus;

  // Provider and contract snapshot: queued work keeps its original behavior
  // even if process configuration changes before a worker claims it.
  @Prop({ type: String, required: true, enum: ['fake', 'openai'] })
  provider!: CustomerAiProviderName;

  @Prop({ type: String, default: null })
  model?: string | null;

  @Prop({ type: String, default: null })
  reasoningEffort?: CustomerAiReasoningEffort | null;

  @Prop({ type: String, required: true })
  promptVersion!: string;

  @Prop({ type: String, required: true })
  policyVersion!: string;

  @Prop({ type: String, required: true })
  toolContractVersion!: string;

  @Prop({ type: String, required: true })
  responseContractVersion!: string;

  // Causal versions suppress answers made obsolete by newer customer input or
  // deterministic state transitions. Draft/session versions are reserved for
  // optimistic concurrency when customer-visible modes are implemented.
  @Prop({ type: Number, min: 0, required: true })
  causalInputVersion!: number;

  // The state version observed immediately after inbound upsert and the state
  // produced by processing that same message are stored separately. This lets
  // shadow analytics compare AI output with the deterministic transition
  // without misclassifying that transition as a newer customer input.
  @Prop({ type: Number, min: 0, required: true })
  observedConversationVersion!: number;

  @Prop({ type: Number, min: 0, required: true })
  deterministicPostConversationVersion!: number;

  @Prop({ type: Number, min: 0, required: true })
  expectedConversationVersion!: number;

  @Prop({ type: Number, min: 0, default: 0 })
  expectedSessionVersion!: number;

  @Prop({ type: Number, min: 0, default: null })
  expectedCheckoutVersion?: number | null;

  @Prop({ type: Boolean, default: false, required: true })
  sideEffectCommitted!: boolean;

  // Lease ownership and fencing prevent an expired worker from completing or
  // failing a run after another worker has reclaimed it.
  @Prop({ type: Number, min: 0, default: 0, required: true })
  attemptCount!: number;

  @Prop({ type: String, default: null })
  leaseOwner?: string | null;

  @Prop({ type: Date, default: null, index: true })
  leaseExpiresAt?: Date | null;

  @Prop({ type: Number, min: 0, default: 0, required: true })
  fencingToken!: number;

  // Incremented only by a currently fenced worker immediately before it
  // persists a tool audit row. This makes audit authorization an atomic write
  // against the same ownership tuple used by terminal run mutations.
  @Prop({ type: Number, min: 0, default: 0, required: true })
  toolAuditRevision!: number;

  // Hard execution budgets copied from config at run creation time.
  @Prop({ type: Number, min: 1, required: true })
  maxProviderCalls!: number;

  @Prop({ type: Number, min: 1, required: true })
  maxToolCalls!: number;

  @Prop({ type: Number, min: 1, required: true })
  maxOutputTokens!: number;

  @Prop({ type: Number, min: 1, required: true })
  maxContextMessages!: number;

  @Prop({ type: Number, min: 1, required: true })
  turnDeadlineMs!: number;

  // Aggregated operational, usage, and outcome telemetry. Raw provider output
  // and raw tool arguments are intentionally not persisted here.
  @Prop({ type: Number, min: 0, default: 0 })
  providerCallCount!: number;

  @Prop({ type: Number, min: 0, default: 0 })
  toolCallCount!: number;

  @Prop({ type: Number, min: 0, default: 0 })
  inputTokens!: number;

  @Prop({ type: Number, min: 0, default: 0 })
  cachedInputTokens!: number;

  @Prop({ type: Number, min: 0, default: 0 })
  outputTokens!: number;

  @Prop({ type: Number, min: 0, default: 0 })
  estimatedCostMinorUnit!: number;

  @Prop({ type: Number, min: 0, default: null })
  latencyMs?: number | null;

  @Prop({ type: String, trim: true, maxlength: 120, default: null })
  responseType?: string | null;

  @Prop({ type: String, trim: true, maxlength: 120, default: null })
  compilerReasonCode?: string | null;

  @Prop({
    type: String,
    enum: ['continue', 'handoff'],
    default: null,
  })
  policyAction?: 'continue' | 'handoff' | null;

  @Prop({ type: String, trim: true, maxlength: 120, default: null })
  policyReasonCode?: string | null;

  // Sanitized objective evidence explains why policy continued or handed off.
  // It contains booleans/counts/fact-domain names, never raw customer text.
  @Prop({ type: Object, default: null })
  policySignals?: CustomerAiPolicySignals | null;

  @Prop({ type: String, trim: true, maxlength: 120, default: null })
  outcomeCode?: string | null;

  @Prop({ type: String, trim: true, maxlength: 120, default: null })
  errorCategory?: string | null;

  @Prop({ type: Date, default: null })
  startedAt?: Date | null;

  @Prop({ type: Date, default: null })
  completedAt?: Date | null;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const CustomerAiRunSchema = SchemaFactory.createForClass(CustomerAiRun);

// Recovery queries scan status/lease age; conversation history scans newest
// causal versions; TTL removes expired audit data automatically.
CustomerAiRunSchema.index({ status: 1, leaseExpiresAt: 1, createdAt: 1 });
CustomerAiRunSchema.index({ conversationId: 1, causalInputVersion: -1 });
// Workspace-first time-window scans back the shadow observability report
// without requiring collection-wide scans as run volume grows.
CustomerAiRunSchema.index({ workspaceId: 1, createdAt: -1 });
CustomerAiRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
