import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { CustomerAiMode } from '@config/types/env.types';
import type { HydratedDocument } from 'mongoose';
import { Types } from 'mongoose';
import type { CustomerAiPhase } from '../customer-ai.types';

export type CustomerAiSessionDocument = HydratedDocument<CustomerAiSession> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Conversation-level AI coordination state shared by all runs for that chat.
 * Today it primarily supplies a distributed lease and fence. Summary,
 * constraints, selections, and optimistic versioning are the durable shape for
 * later phases without giving the current shadow worker mutation authority.
 */
@Schema({
  collection: 'customer_ai_sessions',
  timestamps: true,
  versionKey: false,
})
export class CustomerAiSession {
  @Prop({ type: String, required: true, unique: true, index: true })
  conversationId!: string;

  @Prop({
    type: String,
    enum: ['off', 'shadow', 'active_read_only', 'active_draft'],
    required: true,
  })
  mode!: CustomerAiMode;

  @Prop({
    type: String,
    enum: ['discovery', 'selection', 'checkout_draft', 'handoff'],
    default: 'discovery',
    required: true,
  })
  phase!: CustomerAiPhase;

  @Prop({ type: String, trim: true, maxlength: 2000, default: null })
  summary?: string | null;

  @Prop({ type: Object, default: () => ({}) })
  constraints!: Record<string, unknown>;

  @Prop({ type: Object, default: () => ({}) })
  selectedRefs!: Record<string, unknown>;

  // Increment when persistent session reasoning state changes. This is distinct
  // from the fencing token, which changes whenever lease ownership changes.
  @Prop({ type: Number, min: 0, default: 0, required: true })
  version!: number;

  @Prop({ type: Number, min: 0, default: 0, required: true })
  observedInputVersion!: number;

  @Prop({ type: String, default: null, index: true })
  lastRunId?: string | null;

  @Prop({ type: String, default: null, index: true })
  activeRunId?: string | null;

  // Only the current owner/fence pair may release or later mutate this session.
  @Prop({ type: String, default: null })
  leaseOwner?: string | null;

  @Prop({ type: Date, default: null, index: true })
  leaseExpiresAt?: Date | null;

  @Prop({ type: Number, min: 0, default: 0, required: true })
  fencingToken!: number;

  @Prop({ type: String, trim: true, maxlength: 120, default: null })
  pausedReason?: string | null;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const CustomerAiSessionSchema =
  SchemaFactory.createForClass(CustomerAiSession);

// Sessions are temporary coordination/context records, not permanent customer
// profiles. MongoDB removes them after the refreshed expiry time.
CustomerAiSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
