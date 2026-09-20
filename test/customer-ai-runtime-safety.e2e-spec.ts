import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Queue } from 'bullmq';
import { createConnection, type Connection, type Model, Types } from 'mongoose';
import { AppLogger } from '@common/logger/app.logger';
import type { ConfigType } from '@nestjs/config';
import { customerAiConfig } from '@config/customer-ai.config';
import { validateEnv } from '@config/env.schema';
import { redisConfig as applicationRedisConfig } from '@config/redis.config';
import { RedisService } from '@database/redis.service';
import { CustomerAiProviderHealthService } from '@modules/customer-ai/customer-ai-provider-health.service';
import { CustomerAiQueueService } from '@modules/customer-ai/customer-ai-queue.service';
import { CustomerAiRepository } from '@modules/customer-ai/customer-ai.repository';
import { CustomerAiShadowService } from '@modules/customer-ai/customer-ai-shadow.service';
import { CustomerAiSpendGuardService } from '@modules/customer-ai/customer-ai-spend-guard.service';
import { CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS } from '@modules/customer-ai/customer-ai-runtime-safety-evidence';
import { resolveCustomerAiSourceRevision } from '@modules/customer-ai/customer-ai-source-revision';
import {
  assertCustomerAiRuntimeSafetyDatabaseName,
  resolveCustomerAiRuntimeSafetyEnvironment,
} from '@modules/customer-ai/customer-ai-runtime-safety-environment';
import {
  CustomerAiRun,
  CustomerAiRunSchema,
} from '@modules/customer-ai/schemas/customer-ai-run.schema';
import {
  CustomerAiSession,
  CustomerAiSessionSchema,
} from '@modules/customer-ai/schemas/customer-ai-session.schema';
import {
  CustomerAiToolExecution,
  CustomerAiToolExecutionSchema,
} from '@modules/customer-ai/schemas/customer-ai-tool-execution.schema';
import {
  WhatsappConversation,
  WhatsappConversationSchema,
  WhatsappConversationSource,
  WhatsappConversationState,
  WhatsappConversationStatus,
} from '@modules/whatsapp-conversations/schemas/whatsapp-conversation.schema';
import {
  WhatsappOutboundMessage,
  WhatsappOutboundMessageSchema,
  WhatsappOutboundMessageStatus,
  WhatsappOutboundMessageType,
} from '@modules/whatsapp-conversations/schemas/whatsapp-outbound-message.schema';
import { WhatsappConversationsRepository } from '@modules/whatsapp-conversations/whatsapp-conversations.repository';
import {
  WhatsappOutboundDispatchOutcome,
  WhatsappOutboundDispatcherService,
} from '@modules/whatsapp-conversations/whatsapp-outbound-dispatcher.service';
import { ManualWhatsappProvider } from '@modules/whatsapp-conversations/providers/manual-whatsapp.provider';
import {
  WhatsappConnectionProvider,
  WhatsappConnectionStatus,
} from '@modules/whatsapp-connections/types/whatsapp-connection.type';
import {
  WhatsappChannelMode,
  type WhatsappChannelRecord,
} from '@modules/whatsapp-connections/schemas/whatsapp-channel.schema';
import {
  CUSTOMER_AI_QUEUE_NAME,
  CUSTOMER_AI_SWEEP_JOB,
} from '@modules/customer-ai/customer-ai-queue.constants';
import { describeWithInfrastructure } from './infra-e2e.util';

const CONTRACT_VERSION = 'customer-ai-runtime-safety-v2';

// Atlas connection establishment and the intentional Redis outage probe can
// exceed Jest's unit-test default on a cold developer machine or CI runner.
jest.setTimeout(30_000);

/**
 * This is intentionally one end-to-end test. The report is written only after
 * every real Mongo/Redis/BullMQ assertion succeeds, so a partial Jest run can
 * never leave behind promotable runtime evidence.
 */
describeWithInfrastructure('Customer AI runtime safety evidence (e2e)', () => {
  let connection: Connection;
  let redis: RedisService;
  let runModel: Model<CustomerAiRun>;
  let sessionModel: Model<CustomerAiSession>;
  let toolModel: Model<CustomerAiToolExecution>;
  let conversationModel: Model<WhatsappConversation>;
  let outboundModel: Model<WhatsappOutboundMessage>;
  let runtimeRedisUrl: string;
  const cleanupIds: string[] = [];
  const redisCleanupKeys = new Set<string>();

  beforeAll(async () => {
    // Exercise the exact configuration path used by the API. In particular,
    // this resolves <MONGODB_USERNAME>/<MONGODB_PASSWORD> placeholders before
    // the test opens MongoDB, rather than testing the raw URI template.
    const configuredEnvironment = validateEnv(process.env);
    const environment = runtimeSafetyEnvironment(configuredEnvironment);
    runtimeRedisUrl = environment.REDIS_URL;
    connection = await createConnection(environment.MONGODB_URI).asPromise();
    if (process.env.CUSTOMER_AI_RUNTIME_SAFETY_REPORT_OUTPUT) {
      assertCustomerAiRuntimeSafetyDatabaseName(connection.db.databaseName);
    }
    runModel = connection.model(CustomerAiRun.name, CustomerAiRunSchema);
    sessionModel = connection.model(
      CustomerAiSession.name,
      CustomerAiSessionSchema,
    );
    toolModel = connection.model(
      CustomerAiToolExecution.name,
      CustomerAiToolExecutionSchema,
    );
    conversationModel = connection.model(
      WhatsappConversation.name,
      WhatsappConversationSchema,
    );
    outboundModel = connection.model(
      WhatsappOutboundMessage.name,
      WhatsappOutboundMessageSchema,
    );
    redis = new RedisService({ url: environment.REDIS_URL }, new AppLogger());
  });

  afterAll(async () => {
    // Jest still runs afterAll when infrastructure setup fails. Guard each
    // resource so the original connection error remains visible to operators.
    if (runModel && cleanupIds.length > 0) {
      await Promise.all([
        runModel.deleteMany({ conversationId: { $in: cleanupIds } }),
        sessionModel.deleteMany({ conversationId: { $in: cleanupIds } }),
        conversationModel.deleteMany({ _id: { $in: cleanupIds } }),
        outboundModel.deleteMany({ conversationId: { $in: cleanupIds } }),
      ]);
    }
    if (toolModel) {
      await toolModel.deleteMany({ runId: { $in: cleanupIds } });
    }
    if (redis) {
      await redis.deleteMany([...redisCleanupKeys]);
      await redis.onModuleDestroy();
    }
    if (connection) await connection.close();
  });

  it('executes every required runtime check before producing evidence', async () => {
    const attempts = new Map<string, number>();
    await verifyMongoFencingAndCausality(attempts);
    await verifySpendGuard(attempts);
    await verifyBreakerGeneration(attempts);
    await verifyQueueStartupRecovery(attempts);

    expect([...attempts.keys()].sort()).toEqual(
      [...CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS].sort(),
    );
    writeReportIfRequested(attempts);
  });

  async function verifyMongoFencingAndCausality(
    attempts: Map<string, number>,
  ): Promise<void> {
    const conversationId = new Types.ObjectId().toHexString();
    cleanupIds.push(conversationId);
    await conversationModel.create({
      _id: conversationId,
      channelId: new Types.ObjectId().toHexString(),
      customerPhoneNumber: '+2348000000000',
      customerPhoneNumberNormalized: '2348000000000',
      status: WhatsappConversationStatus.Open,
      source: WhatsappConversationSource.Whatsapp,
      state: WhatsappConversationState.New,
      inputVersion: 1,
      stateVersion: 2,
      metadata: {},
    });
    const repository = new CustomerAiRepository(
      runModel,
      sessionModel,
      toolModel,
      {} as never,
      conversationModel,
    );
    const queue = { enqueueProcessJob: jest.fn().mockResolvedValue(true) };
    const shadow = new CustomerAiShadowService(
      { isShadowEligible: jest.fn().mockReturnValue(true) } as never,
      repository,
      queue as never,
      { increment: jest.fn() } as never,
      runtimeConfig(),
    );
    await conversationModel.updateOne(
      { _id: conversationId },
      { $set: { stateVersion: 3 } },
    );
    await expect(
      shadow.observeInbound({
        inboundEventId: new Types.ObjectId().toHexString(),
        customerMessage: 'Find jollof rice',
        deterministicInput: false,
        conversation: {
          id: conversationId,
          inputVersion: 1,
          stateVersion: 2,
        } as never,
      }),
    ).resolves.toBe(true);
    const run = await runModel.findOne({ conversationId }).exec();
    expect(run).toMatchObject({
      observedConversationVersion: 2,
      deterministicPostConversationVersion: 3,
      expectedConversationVersion: 3,
    });
    attempts.set('causal_shadow_post_state', 1);
    if (!run) throw new Error('Runtime test run was not created');

    const claimedA = await repository.claimRun({
      runId: run._id.toHexString(),
      leaseOwner: 'runtime-worker-a',
      now: new Date('2026-09-01T10:00:00.000Z'),
      leaseExpiresAt: new Date('2026-09-01T10:00:01.000Z'),
    });
    const claimedB = await repository.claimRun({
      runId: run._id.toHexString(),
      leaseOwner: 'runtime-worker-b',
      now: new Date('2026-09-01T10:00:02.000Z'),
      leaseExpiresAt: new Date('2026-09-01T10:00:20.000Z'),
    });
    expect(claimedA?.fencingToken).toBe(1);
    expect(claimedB?.fencingToken).toBe(2);

    const audit = toolAudit(run._id.toHexString());
    await expect(
      repository.createToolExecution({
        ...audit,
        leaseOwner: 'runtime-worker-a',
        fencingToken: 1,
      }),
    ).resolves.toBe(false);
    await expect(
      repository.createToolExecution({
        ...audit,
        leaseOwner: 'runtime-worker-b',
        fencingToken: 2,
      }),
    ).resolves.toBe(true);
    cleanupIds.push(run._id.toHexString());
    attempts.set('tool_audit_fencing_after_takeover', 2);

    await expect(
      repository.completeShadowRun({
        runId: run._id.toHexString(),
        leaseOwner: 'runtime-worker-a',
        fencingToken: 1,
        completion: completion(),
      }),
    ).resolves.toBe(false);
    await expect(
      repository.completeShadowRun({
        runId: run._id.toHexString(),
        leaseOwner: 'runtime-worker-b',
        fencingToken: 2,
        completion: completion(),
      }),
    ).resolves.toBe(true);
    attempts.set('run_fencing_after_lease_takeover', 2);

    const outboundRepository = new WhatsappConversationsRepository(
      {} as never,
      conversationModel,
      outboundModel,
      {} as never,
      {} as never,
      {} as never,
    );
    const outbound = await outboundRepository.createOutboundMessage({
      conversationId,
      sourceRunId: run._id.toHexString(),
      causalInputVersion: 1,
      causalConversationVersion: 3,
      toPhoneNumber: '+2348000000000',
      toPhoneNumberNormalized: '2348000000000',
      messageType: WhatsappOutboundMessageType.Text,
      text: 'Stale AI reply',
      payload: { source: 'customer_ai' },
      status: WhatsappOutboundMessageStatus.Queued,
      attemptCount: 0,
      maxAttempts: 1,
    });
    await conversationModel.updateOne(
      { _id: conversationId },
      { $inc: { inputVersion: 1, stateVersion: 1 } },
    );
    const claimedOutbound = await outboundRepository.claimQueuedMessageById({
      outboundMessageId: outbound.id,
      now: new Date(),
    });
    if (!claimedOutbound) throw new Error('Outbound message was not claimed');
    await expect(
      outboundRepository.isClaimedOutboundMessageCausallyCurrent(
        claimedOutbound,
      ),
    ).resolves.toBe(false);
    await expect(
      outboundRepository.cancelStaleClaimedOutboundMessage(claimedOutbound),
    ).resolves.toBe(true);
    expect((await outboundModel.findById(outbound.id))?.status).toBe(
      WhatsappOutboundMessageStatus.Cancelled,
    );
    attempts.set('causal_outbound_dispatch_guard', 1);

    await verifyOutboundDispatchRace({
      attempts,
      repository: outboundRepository,
      conversationId,
      sourceRunId: run._id.toHexString(),
    });
  }

  async function verifyOutboundDispatchRace(input: {
    attempts: Map<string, number>;
    repository: WhatsappConversationsRepository;
    conversationId: string;
    sourceRunId: string;
  }): Promise<void> {
    const conversation = await conversationModel
      .findById(input.conversationId)
      .lean()
      .exec();
    if (!conversation?.channelId) {
      throw new Error('Runtime conversation channel was not created');
    }
    const outbound = await input.repository.createOutboundMessage({
      channelId: conversation.channelId,
      conversationId: input.conversationId,
      sourceRunId: input.sourceRunId,
      causalInputVersion: conversation.inputVersion,
      causalConversationVersion: conversation.stateVersion,
      toPhoneNumber: '+2348000000000',
      toPhoneNumberNormalized: '2348000000000',
      messageType: WhatsappOutboundMessageType.Text,
      text: 'AI reply racing newer input',
      payload: { source: 'customer_ai' },
      status: WhatsappOutboundMessageStatus.Queued,
      attemptCount: 0,
      maxAttempts: 1,
    });
    let announceLookup!: () => void;
    const lookupStarted = new Promise<void>((resolvePromise) => {
      announceLookup = resolvePromise;
    });
    let releaseLookup!: () => void;
    const lookupBarrier = new Promise<void>((resolvePromise) => {
      releaseLookup = resolvePromise;
    });
    const channel: WhatsappChannelRecord = {
      id: conversation.channelId,
      mode: WhatsappChannelMode.SharedPlatform,
      marketCode: 'NG',
      provider: WhatsappConnectionProvider.MetaCloud,
      status: WhatsappConnectionStatus.Connected,
      phoneNumber: '+2348000000000',
      phoneNumberNormalized: '2348000000000',
      providerPhoneNumberId: 'runtime-phone-id',
      providerBusinessAccountId: 'runtime-business-id',
      lastStatusChangedAt: new Date(),
      isDefaultForMarket: true,
      settings: {},
      disabledAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const provider = {
      sendText: jest.fn().mockResolvedValue({ ok: true }),
    };
    const channels = {
      findChannelById: jest.fn(async () => {
        announceLookup();
        await lookupBarrier;
        return channel;
      }),
    };
    const dispatcher = new WhatsappOutboundDispatcherService(
      input.repository,
      { prepare: (message: unknown) => Promise.resolve(message) } as never,
      new ManualWhatsappProvider(),
      provider as never,
      { record: jest.fn() } as never,
      channels as never,
    );

    const processing = dispatcher.processOutboundMessageJob(outbound.id);
    await lookupStarted;
    // The first causal check has passed and provider identity resolution is
    // waiting. Advance the conversation before the external send can begin.
    await conversationModel.updateOne(
      { _id: input.conversationId },
      { $inc: { inputVersion: 1, stateVersion: 1 } },
    );
    releaseLookup();

    await expect(processing).resolves.toEqual({
      outcome: WhatsappOutboundDispatchOutcome.Skipped,
    });
    expect(provider.sendText).not.toHaveBeenCalled();
    expect((await outboundModel.findById(outbound.id))?.status).toBe(
      WhatsappOutboundMessageStatus.Cancelled,
    );
    input.attempts.set('causal_outbound_dispatch_race', 1);
  }

  async function verifySpendGuard(
    attempts: Map<string, number>,
  ): Promise<void> {
    const guard = new CustomerAiSpendGuardService(redis, {
      ...runtimeConfig(),
      spendKeyNamespace: `runtime-${randomUUID()}`,
    });
    const reservationId = `runtime-safety:${randomUUID()}`;
    // Race the same logical reservation to prove Redis admits it exactly once,
    // then prove a distinct reservation cannot cross the daily hard limit.
    const [first, second] = await Promise.all([
      guard.reserve({ reservationId, amountMinorUnit: 600 }),
      guard.reserve({ reservationId, amountMinorUnit: 600 }),
    ]);
    // Register cleanup before assertions so a failed expectation cannot leave
    // even the UUID-scoped evidence counters behind.
    redisCleanupKeys.add(first.dailyKey);
    redisCleanupKeys.add(first.monthlyKey);
    redisCleanupKeys.add(first.reservationKey);
    expect(second.reservationKey).toBe(first.reservationKey);
    expect(await redis.get(first.dailyKey)).toBe('600');
    await expect(
      guard.reserve({
        reservationId: `runtime-safety:${randomUUID()}`,
        amountMinorUnit: 401,
      }),
    ).rejects.toThrow('CUSTOMER_AI_SPEND_LIMIT');
    attempts.set('spend_guard_atomic_idempotency', 3);
  }

  async function verifyBreakerGeneration(
    attempts: Map<string, number>,
  ): Promise<void> {
    const breaker = new CustomerAiProviderHealthService(redis, runtimeConfig());
    const key = `runtime:${randomUUID()}`;
    const first = await breaker.acquirePermit(key, 1000);
    const second = await breaker.acquirePermit(key, 1001);
    if (!first || !second) throw new Error('Initial breaker permits missing');
    await breaker.recordFailure(first, 1100);
    await breaker.recordFailure(second, 1101);
    expect(await breaker.getState(key)).toBe('open');
    const probeA = await breaker.acquirePermit(key, 2101);
    const probeB = await breaker.acquirePermit(key, 2102);
    if (!probeA || !probeB) throw new Error('Half-open probes missing');
    await breaker.recordSuccess(probeA, 2200);
    expect(await breaker.getState(key)).toBe('half_open');
    await breaker.recordFailure(probeB, 2201);
    expect(await breaker.getState(key)).toBe('open');
    for (const redisKey of breakerRedisKeys(key))
      redisCleanupKeys.add(redisKey);
    attempts.set('provider_breaker_generation_concurrency', 2);
  }

  async function verifyQueueStartupRecovery(
    attempts: Map<string, number>,
  ): Promise<void> {
    const suffix = randomUUID();
    const config: ConfigType<typeof customerAiConfig> = {
      ...runtimeConfig(),
      queuePrefix: `ordira-runtime-${suffix}`,
      queueReadyTimeoutMs: 20,
      queueUnavailableRetryDelayMs: 100,
      sweepIntervalMs: 1000,
      removeOnCompleteCount: 10,
      removeOnFailCount: 10,
    };
    const queueRedisConfig: ConfigType<typeof applicationRedisConfig> = {
      url: 'redis://127.0.0.1:1',
    };
    const service = new CustomerAiQueueService(config, queueRedisConfig);

    expect(await service.scheduleSweepJob()).toBe(false);
    service.onApplicationBootstrap();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    queueRedisConfig.url = runtimeRedisUrl;

    const cleanupQueue = new Queue(CUSTOMER_AI_QUEUE_NAME, {
      connection: { url: runtimeRedisUrl },
      prefix: config.queuePrefix,
    });
    await cleanupQueue.waitUntilReady();
    await waitFor(async () =>
      (await cleanupQueue.getRepeatableJobs()).some(
        (job) => job.name === CUSTOMER_AI_SWEEP_JOB,
      ),
    );
    await service.onModuleDestroy();
    await cleanupQueue.obliterate({ force: true });
    await cleanupQueue.close();
    attempts.set('queue_recovery_after_startup_redis_outage', 2);
  }
});

function runtimeConfig(): ConfigType<typeof customerAiConfig> {
  return {
    mode: 'shadow',
    queueEnabled: true,
    provider: 'fake',
    model: null,
    reasoningEffort: null,
    promptVersion: 'customer-ai-v3',
    policyVersion: 'customer-ai-policy-v2',
    toolContractVersion: 'customer-ai-tools-v2',
    responseContractVersion: 'customer-ai-response-v1',
    maxProviderCalls: 2,
    maxToolCalls: 4,
    maxOutputTokens: 300,
    turnDeadlineMs: 15000,
    dailySpendLimitMinorUnit: 1000,
    monthlySpendLimitMinorUnit: 10000,
    spendReservationTtlSeconds: 120,
    breakerMinRequests: 2,
    breakerFailurePercent: 50,
    breakerOpenMs: 1000,
    breakerWindowMs: 5000,
    breakerHalfOpenProbes: 2,
  } as ConfigType<typeof customerAiConfig>;
}

function toolAudit(runId: string) {
  return {
    runId,
    sequence: 1,
    toolName: 'search_menu_items',
    contractVersion: 'customer-ai-tools-v2',
    sideEffectClass: 'read' as const,
    argumentsHash: 'a'.repeat(64),
    sanitizedArgumentSummary: { argumentNames: ['q'] },
    status: 'succeeded' as const,
    domainResponseCode: 'ok',
    latencyMs: 1,
    retryCount: 0,
    resultCardinality: 0,
    returnedRefs: [],
    idempotencyKeyHash: null,
    expectedVersion: null,
    committedVersion: null,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

function runtimeSafetyEnvironment(
  configured: ReturnType<typeof validateEnv>,
): ReturnType<typeof validateEnv> {
  // Ordinary developer test runs may use configured infrastructure because
  // every record/key is UUID-scoped and cleaned. Promotion evidence is held to
  // a stricter boundary: it must never connect to the application's normal
  // MongoDB or Redis endpoints, even in staging.
  if (!process.env.CUSTOMER_AI_RUNTIME_SAFETY_REPORT_OUTPUT) {
    return configured;
  }
  return resolveCustomerAiRuntimeSafetyEnvironment(configured, process.env);
}

function completion() {
  return {
    providerCallCount: 1,
    toolCallCount: 1,
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    estimatedCostMinorUnit: 1,
    latencyMs: 1,
    responseType: 'menu_recommendation',
    compilerReasonCode: null,
    policyAction: 'continue' as const,
    policyReasonCode: null,
    policySignals: {
      schemaValid: true,
      toolErrorCount: 0,
      ambiguousResultCount: 0,
      missingRequiredFacts: [],
      staleVersionConflict: false,
      unavailableSelectedItem: false,
      scopeMismatch: false,
      contradictoryConstraints: false,
      supportedIntent: true,
      providerRequestedHandoff: false,
    },
    outcomeCode: 'shadow_compiled',
  };
}

function breakerRedisKeys(key: string): string[] {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 32);
  const slot = `{customer-ai-breaker:${digest}}`;
  return [
    `ordira:${slot}:state`,
    `ordira:${slot}:requests`,
    `ordira:${slot}:failures`,
  ];
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for runtime safety condition');
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function writeReportIfRequested(attempts: Map<string, number>): void {
  const output = process.env.CUSTOMER_AI_RUNTIME_SAFETY_REPORT_OUTPUT;
  if (!output) return;
  const absolutePath = resolve(output);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const sourceRevision = resolveCleanSourceRevision();
  const report = {
    contractVersion: CONTRACT_VERSION,
    sourceRevision,
    executedAt: new Date().toISOString(),
    environment: 'integration' as const,
    checks: CUSTOMER_AI_REQUIRED_RUNTIME_SAFETY_CHECKS.map((id) => ({
      id,
      passed: true,
      attempts: attempts.get(id) ?? 0,
    })),
  };
  writeFileSync(absolutePath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

function resolveCleanSourceRevision(): string {
  return resolveCustomerAiSourceRevision({ requireClean: true }).revision;
}
