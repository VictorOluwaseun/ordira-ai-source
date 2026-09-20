import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { WhatsappConversation } from '@modules/whatsapp-conversations/schemas/whatsapp-conversation.schema';
import {
  WhatsappInboundEvent,
  type WhatsappInboundEventDocument,
} from '@modules/whatsapp-conversations/schemas/whatsapp-inbound-event.schema';
import { Types, type Model } from 'mongoose';
import type {
  CustomerAiPolicyDecision,
  CustomerAiPolicySignals,
} from './customer-ai-policy.service';
import type { CustomerAiRunConfigSnapshot } from './customer-ai.types';
import {
  CustomerAiRun,
  type CustomerAiRunDocument,
} from './schemas/customer-ai-run.schema';
import { CustomerAiSession } from './schemas/customer-ai-session.schema';
import { CustomerAiToolExecution } from './schemas/customer-ai-tool-execution.schema';

export type CreateCustomerAiRunInput = CustomerAiRunConfigSnapshot & {
  conversationId: string;
  inboundEventId: string;
  workspaceId?: string | null;
  restaurantId?: string | null;
  branchId?: string | null;
  causalInputVersion: number;
  observedConversationVersion: number;
  deterministicPostConversationVersion: number;
  expectedConversationVersion: number;
};

export type CustomerAiRunTelemetry = {
  providerCallCount: number;
  toolCallCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  estimatedCostMinorUnit: number;
  latencyMs: number;
};

export type CustomerAiRunCompletion = CustomerAiRunTelemetry & {
  responseType?: string | null;
  compilerReasonCode?: string | null;
  policyAction: CustomerAiPolicyDecision['action'];
  policyReasonCode?: string | null;
  policySignals: CustomerAiPolicySignals;
  outcomeCode: string;
};

/**
 * Persistence boundary for AI runs, sessions, tool audits, and causal checks.
 *
 * Concurrency-sensitive writes are expressed as atomic MongoDB filters rather
 * than read-then-write sequences. A worker may write a running job only while
 * its lease owner and fencing token still match the durable run. This prevents
 * a stalled worker from waking after lease expiry and overwriting newer work.
 */
@Injectable()
export class CustomerAiRepository {
  constructor(
    @InjectModel(CustomerAiRun.name)
    private readonly runModel: Model<CustomerAiRun>,
    @InjectModel(CustomerAiSession.name)
    private readonly sessionModel: Model<CustomerAiSession>,
    @InjectModel(CustomerAiToolExecution.name)
    private readonly toolExecutionModel: Model<CustomerAiToolExecution>,
    @InjectModel(WhatsappInboundEvent.name)
    private readonly inboundEventModel: Model<WhatsappInboundEvent>,
    @InjectModel(WhatsappConversation.name)
    private readonly conversationModel: Model<WhatsappConversation>,
  ) {}

  async createRunIfAbsent(
    input: CreateCustomerAiRunInput,
  ): Promise<CustomerAiRunDocument> {
    const now = new Date();
    // Upsert on the unique inbound event makes WhatsApp webhook redelivery and
    // repeated shadow observation return the same durable run.
    const run = await this.runModel
      .findOneAndUpdate(
        { inboundEventId: input.inboundEventId },
        {
          $setOnInsert: {
            ...input,
            phase: 'discovery',
            status: 'queued',
            expectedSessionVersion: 0,
            expectedCheckoutVersion: null,
            sideEffectCommitted: false,
            expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
          },
        },
        {
          upsert: true,
          returnDocument: 'after',
          runValidators: true,
          setDefaultsOnInsert: true,
        },
      )
      .exec();
    if (!run) {
      throw new Error('CUSTOMER_AI_RUN_CREATE_FAILED');
    }

    return run;
  }

  async claimRun(input: {
    runId: string;
    leaseOwner: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<CustomerAiRunDocument | null> {
    if (!Types.ObjectId.isValid(input.runId)) {
      return null;
    }
    // Only queued work or a running job with an expired lease is claimable.
    // Incrementing fencingToken in the same operation invalidates old holders.
    const run = await this.runModel
      .findOneAndUpdate(
        {
          _id: input.runId,
          $or: [
            { status: 'queued' },
            { status: 'running', leaseExpiresAt: { $lte: input.now } },
          ],
        },
        {
          $set: {
            status: 'running',
            leaseOwner: input.leaseOwner,
            leaseExpiresAt: input.leaseExpiresAt,
            startedAt: input.now,
          },
          $inc: { attemptCount: 1, fencingToken: 1 },
        },
        { returnDocument: 'after', runValidators: true },
      )
      .exec();

    return run ?? null;
  }

  async findInboundEvent(
    inboundEventId: string,
  ): Promise<WhatsappInboundEventDocument | null> {
    if (!Types.ObjectId.isValid(inboundEventId)) {
      return null;
    }

    return this.inboundEventModel.findById(inboundEventId).exec();
  }

  /**
   * Read a bounded, customer-only context window ending at the run's inbound
   * event. Channel plus customer identity prevents context crossing tenant or
   * WhatsApp-number boundaries; the ObjectId ceiling prevents a later inbound
   * event from leaking into an older run that is recovered after a delay.
   */
  async findRecentCustomerMessages(
    inboundEvent: WhatsappInboundEventDocument,
    conversationId: string,
    limit: number,
  ): Promise<string[]> {
    const currentText = inboundEvent.text?.trim();
    if (
      !currentText ||
      !inboundEvent.channelId ||
      inboundEvent.conversationId !== conversationId
    ) {
      return currentText ? [currentText] : [];
    }

    const customerIdentity = inboundEvent.platformCustomerIdentityId
      ? { platformCustomerIdentityId: inboundEvent.platformCustomerIdentityId }
      : inboundEvent.fromPhoneNumber
        ? { fromPhoneNumber: inboundEvent.fromPhoneNumber }
        : null;
    if (!customerIdentity) {
      return [currentText];
    }

    const events = await this.inboundEventModel
      .find({
        conversationId,
        channelId: inboundEvent.channelId,
        ...customerIdentity,
        _id: { $lte: inboundEvent._id },
        status: 'processed',
        text: { $type: 'string' },
      })
      .sort({ _id: -1 })
      .limit(limit)
      .select({ _id: 1, text: 1 })
      .exec();
    const chronological = [...events].reverse();
    const messages = chronological
      .map((event) => event.text?.trim())
      .filter((text): text is string => Boolean(text));
    const includesCurrent = chronological.some((event) =>
      event._id.equals(inboundEvent._id),
    );

    return (includesCurrent ? messages : [...messages, currentText]).slice(
      -limit,
    );
  }

  async findConversationVersions(conversationId: string): Promise<{
    inputVersion: number;
    stateVersion: number;
  } | null> {
    if (!Types.ObjectId.isValid(conversationId)) {
      return null;
    }
    const conversation = await this.conversationModel
      .findById(conversationId)
      .select({ inputVersion: 1, stateVersion: 1 })
      .exec();
    if (!conversation) {
      return null;
    }

    return {
      inputVersion: conversation.inputVersion ?? 0,
      stateVersion: conversation.stateVersion ?? 0,
    };
  }

  async isRunCausallyCurrent(run: CustomerAiRunDocument): Promise<boolean> {
    // Both versions must still match. inputVersion detects newer customer input;
    // stateVersion detects deterministic transitions such as cancellation.
    const conversation = await this.findConversationVersions(
      run.conversationId,
    );

    return Boolean(
      conversation &&
      conversation.inputVersion === run.causalInputVersion &&
      conversation.stateVersion === run.expectedConversationVersion,
    );
  }

  async ensureSession(run: CustomerAiRunDocument): Promise<void> {
    // Session creation is idempotent and stores only shadow metadata today. The
    // version/constraint fields reserve the shape needed for later draft modes.
    await this.sessionModel
      .findOneAndUpdate(
        { conversationId: run.conversationId },
        {
          $set: {
            mode: run.mode,
            phase: run.phase,
            lastRunId: run._id.toHexString(),
            observedInputVersion: run.causalInputVersion,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
          $setOnInsert: {
            version: 0,
            constraints: {},
            selectedRefs: {},
          },
        },
        {
          upsert: true,
          runValidators: true,
          setDefaultsOnInsert: true,
        },
      )
      .exec();
  }

  async claimConversationLease(input: {
    conversationId: string;
    runId: string;
    leaseOwner: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<number | null> {
    // A conversation lease serializes AI turns even when separate run jobs are
    // processed concurrently. Re-entrant ownership supports safe job recovery.
    const session = await this.sessionModel
      .findOneAndUpdate(
        {
          conversationId: input.conversationId,
          $or: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { $exists: false } },
            { leaseExpiresAt: { $lte: input.now } },
            { activeRunId: input.runId, leaseOwner: input.leaseOwner },
          ],
        },
        {
          $set: {
            activeRunId: input.runId,
            leaseOwner: input.leaseOwner,
            leaseExpiresAt: input.leaseExpiresAt,
          },
          $inc: { fencingToken: 1 },
        },
        { returnDocument: 'after', runValidators: true },
      )
      .exec();

    return session?.fencingToken ?? null;
  }

  async releaseConversationLease(input: {
    conversationId: string;
    leaseOwner: string;
    fencingToken: number;
  }): Promise<void> {
    // The fenced filter means an obsolete worker cannot release its successor's
    // lease after the old lease has expired and been reclaimed.
    await this.sessionModel
      .updateOne(
        {
          conversationId: input.conversationId,
          leaseOwner: input.leaseOwner,
          fencingToken: input.fencingToken,
        },
        {
          $set: {
            activeRunId: null,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        },
      )
      .exec();
  }

  async createToolExecution(
    input: Omit<CustomerAiToolExecution, 'createdAt' | 'updatedAt'>,
  ): Promise<boolean> {
    // Authorize the audit with an atomic fenced write on the run. An obsolete
    // worker cannot pass this filter after takeover, and the fencing token in
    // the audit identity prevents it from poisoning the replacement sequence.
    const ownership = await this.runModel
      .updateOne(fencedRunFilter(input), {
        $inc: { toolAuditRevision: 1 },
      })
      .exec();
    if (ownership.modifiedCount !== 1) {
      return false;
    }

    // The audit record stores hashes and summaries, not raw customer arguments.
    await this.toolExecutionModel.create(input);
    return true;
  }

  async completeShadowRun(input: {
    runId: string;
    leaseOwner: string;
    fencingToken: number;
    completion: CustomerAiRunCompletion;
  }): Promise<boolean> {
    // modifiedCount=false is a stale-worker signal, not a retry instruction.
    const result = await this.runModel
      .updateOne(fencedRunFilter(input), {
        $set: {
          ...input.completion,
          status: 'shadow_completed',
          completedAt: new Date(),
          leaseExpiresAt: null,
        },
      })
      .exec();

    return result.modifiedCount === 1;
  }

  async supersedeRun(
    input: FencedRunInput & {
      policySignals?: CustomerAiPolicySignals;
      telemetry?: CustomerAiRunTelemetry;
    },
  ): Promise<boolean> {
    // Superseded is a successful safety outcome: the run was valid when queued,
    // but newer conversation input made its eventual answer causally stale.
    const result = await this.runModel
      .updateOne(fencedRunFilter(input), {
        $set: {
          status: 'superseded',
          outcomeCode: 'causal_input_stale',
          ...(input.telemetry ?? {}),
          ...(input.policySignals
            ? {
                policyAction: 'handoff',
                policyReasonCode: 'stale_version_conflict',
                policySignals: input.policySignals,
              }
            : {}),
          completedAt: new Date(),
          leaseExpiresAt: null,
        },
      })
      .exec();

    return result.modifiedCount === 1;
  }

  async requeueRun(input: FencedRunInput): Promise<boolean> {
    // A busy conversation is retried by recovery rather than allowing two AI
    // turns to reason over the same conversation concurrently.
    const result = await this.runModel
      .updateOne(fencedRunFilter(input), {
        $set: {
          status: 'queued',
          outcomeCode: 'conversation_lease_busy',
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      })
      .exec();

    return result.modifiedCount === 1;
  }

  async failRun(
    input: FencedRunInput & {
      errorCategory: string;
      telemetry?: CustomerAiRunTelemetry;
    },
  ): Promise<boolean> {
    const result = await this.runModel
      .updateOne(fencedRunFilter(input), {
        $set: {
          status: 'failed',
          errorCategory: input.errorCategory,
          ...(input.telemetry ?? {}),
          completedAt: new Date(),
          leaseExpiresAt: null,
        },
      })
      .exec();

    return result.modifiedCount === 1;
  }

  async findRecoverableRunIds(input: {
    staleBefore: Date;
    limit: number;
  }): Promise<string[]> {
    // Recovery is intentionally bounded and oldest-first. claimRun remains the
    // final ownership check if multiple sweep workers observe the same record.
    const runs = await this.runModel
      .find({
        $or: [
          { status: 'queued', createdAt: { $lte: input.staleBefore } },
          { status: 'running', leaseExpiresAt: { $lte: input.staleBefore } },
        ],
      })
      .sort({ createdAt: 1, _id: 1 })
      .limit(input.limit)
      .select({ _id: 1 })
      .exec();

    return runs.map((run) => run._id.toHexString());
  }
}

type FencedRunInput = {
  runId: string;
  leaseOwner: string;
  fencingToken: number;
};

function fencedRunFilter(input: FencedRunInput): Record<string, unknown> {
  // Every terminal mutation uses this shared predicate. Never remove any field
  // without reconsidering stale-worker protection.
  return {
    _id: input.runId,
    status: 'running',
    leaseOwner: input.leaseOwner,
    fencingToken: input.fencingToken,
  };
}
