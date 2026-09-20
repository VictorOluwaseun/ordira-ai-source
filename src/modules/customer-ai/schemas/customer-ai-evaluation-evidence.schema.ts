import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type {
  CustomerAiProviderName,
  CustomerAiReasoningEffort,
} from '@config/types/env.types';
import type { HydratedDocument } from 'mongoose';
import { Types } from 'mongoose';

export type CustomerAiEvaluationEvidenceDocument =
  HydratedDocument<CustomerAiEvaluationEvidence> & {
    _id: Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
  };

export type CustomerAiEvaluationCaseEvidence = {
  fixtureId: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  trials: number;
  failures: number;
  failureRate: number;
  oneSided95FailureRateUpperBound: number;
};

/**
 * Durable, privacy-safe evidence for one variant in a repeated model bake-off.
 *
 * Each comparison writes one document per exact variant. Only aggregate grader
 * results and version identities are stored—never fixture turns, prompts,
 * provider output, customer messages, or tool payloads. Historical evidence is
 * retained for audit; readiness applies a configurable maximum age at read time
 * instead of deleting expired evidence.
 */
@Schema({
  collection: 'customer_ai_evaluation_evidence',
  timestamps: true,
  versionKey: false,
})
export class CustomerAiEvaluationEvidence {
  // comparisonId + variantId is the idempotency boundary for evaluator retry.
  @Prop({ type: String, required: true, trim: true, maxlength: 128 })
  comparisonId!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 128 })
  variantId!: string;

  @Prop({ type: String, required: true, enum: ['fake', 'openai'] })
  provider!: CustomerAiProviderName;

  @Prop({ type: String, required: true, trim: true, maxlength: 160 })
  model!: string;

  @Prop({
    type: String,
    required: true,
    enum: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  })
  reasoningEffort!: CustomerAiReasoningEffort;

  @Prop({ type: Number, min: 1, required: true })
  maxOutputTokens!: number;

  @Prop({ type: Number, min: 1, required: true })
  maxContextMessages!: number;

  // These are the reviewed billing-currency rates used to derive the recorded
  // estimated cost. Persisting them makes a historical comparison auditable
  // even after provider prices change.
  @Prop({ type: Number, min: 1, required: true })
  inputCostPerMillionMinorUnit!: number;

  @Prop({ type: Number, min: 1, required: true })
  outputCostPerMillionMinorUnit!: number;

  // These version fields form the exact behavioral identity matched to shadow
  // telemetry. Evidence for an older prompt or contract cannot approve a newer
  // deployment that happens to use the same model name.
  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  promptVersion!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  policyVersion!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  toolContractVersion!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  responseContractVersion!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  evaluationContractVersion!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  datasetVersion!: string;

  @Prop({
    type: String,
    required: true,
    lowercase: true,
    match: /^[a-f0-9]{64}$/,
  })
  datasetSha256!: string;

  @Prop({ type: Number, min: 1, required: true })
  fixtureCount!: number;

  @Prop({ type: Number, min: 1, required: true })
  trialCountPerFixture!: number;

  @Prop({ type: Number, min: 1, required: true })
  totalTrials!: number;

  @Prop({ type: Number, min: 0, required: true })
  failures!: number;

  @Prop({ type: Number, min: 0, max: 1, required: true })
  failureRate!: number;

  @Prop({ type: Number, min: 0, max: 1, required: true })
  oneSided95FailureRateUpperBound!: number;

  @Prop({ type: Number, min: 0, required: true })
  criticalFailures!: number;

  // Exact source exercised by both the model comparison and runtime suite.
  // Legacy records may omit it, but readiness treats that as insufficient.
  @Prop({
    type: String,
    trim: true,
    lowercase: true,
    match: /^[a-f0-9]{40,64}$/,
    default: null,
  })
  evaluationSourceRevision?: string | null;

  // Runtime safety is produced by the infrastructure/concurrency suite and is
  // deliberately separate from model fixture results. Older evidence rows may
  // omit these fields, but promotion readiness will treat them as insufficient.
  @Prop({ type: String, trim: true, maxlength: 120, default: null })
  runtimeSafetyContractVersion?: string | null;

  @Prop({
    type: String,
    lowercase: true,
    match: /^[a-f0-9]{64}$/,
    default: null,
  })
  runtimeSafetyReportSha256?: string | null;

  @Prop({
    type: String,
    trim: true,
    lowercase: true,
    match: /^[a-f0-9]{40,64}$/,
    default: null,
  })
  runtimeSafetySourceRevision?: string | null;

  @Prop({ type: Date, default: null })
  runtimeSafetyExecutedAt?: Date | null;

  @Prop({ type: [String], default: () => [] })
  runtimeSafetyChecks!: string[];

  @Prop({ type: Number, min: 0, default: null })
  averageLatencyMs?: number | null;

  @Prop({ type: Number, min: 0, required: true })
  totalEstimatedCostMinorUnit!: number;

  @Prop({ type: Number, required: true })
  failureRateDeltaFromCeiling!: number;

  @Prop({ type: String, required: true, trim: true, maxlength: 128 })
  qualityCeilingVariantId!: string;

  @Prop({ type: Boolean, required: true })
  promotable!: boolean;

  @Prop({ type: [String], default: () => [] })
  rejectionReasons!: string[];

  @Prop({ type: [Object], default: () => [] })
  cases!: CustomerAiEvaluationCaseEvidence[];

  // The hash covers the complete sanitized record. Retrying the same
  // comparison with altered content collides with the unique idempotency index
  // rather than silently overwriting approved evidence.
  @Prop({
    type: String,
    required: true,
    lowercase: true,
    match: /^[a-f0-9]{64}$/,
  })
  evidenceSha256!: string;

  @Prop({ type: Date, required: true, index: true })
  evaluatedAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const CustomerAiEvaluationEvidenceSchema = SchemaFactory.createForClass(
  CustomerAiEvaluationEvidence,
);

CustomerAiEvaluationEvidenceSchema.index(
  { comparisonId: 1, variantId: 1 },
  { unique: true },
);
// Supports the readiness query: locate every behavioral deployment for the
// same provider/model/reasoning base and select the newest exact contract row.
CustomerAiEvaluationEvidenceSchema.index({
  provider: 1,
  model: 1,
  reasoningEffort: 1,
  evaluatedAt: -1,
});
