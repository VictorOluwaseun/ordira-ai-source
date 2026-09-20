import { CustomerAiRepository } from './customer-ai.repository';
import { Types } from 'mongoose';

describe('CustomerAiRepository fencing', () => {
  function createRepository() {
    const runModel = {
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn<
        unknown,
        [Record<string, unknown>, { $set?: Record<string, unknown> }]
      >(),
    };
    const sessionModel = {
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn(),
    };
    const toolExecutionModel = {
      create: jest.fn().mockResolvedValue(undefined),
    };
    const inboundEventModel = {
      find: jest.fn(),
    };
    const repository = new CustomerAiRepository(
      runModel as never,
      sessionModel as never,
      toolExecutionModel as never,
      inboundEventModel as never,
      {} as never,
    );

    return {
      repository,
      runModel,
      sessionModel,
      toolExecutionModel,
      inboundEventModel,
    };
  }

  it('loads bounded customer-only context ending at the current inbound event', async () => {
    const { repository, inboundEventModel } = createRepository();
    const earlierId = new Types.ObjectId('507f1f77bcf86cd799439010');
    const currentId = new Types.ObjectId('507f1f77bcf86cd799439011');
    const exec = jest.fn().mockResolvedValue([
      { _id: currentId, text: 'How much is it?' },
      { _id: earlierId, text: 'I want a chicken burger' },
    ]);
    const select = jest.fn().mockReturnValue({ exec });
    const limit = jest.fn().mockReturnValue({ select });
    const sort = jest.fn().mockReturnValue({ limit });
    inboundEventModel.find.mockReturnValue({ sort });

    await expect(
      repository.findRecentCustomerMessages(
        {
          _id: currentId,
          conversationId: 'conversation-1',
          channelId: 'channel-1',
          platformCustomerIdentityId: 'customer-1',
          text: 'How much is it?',
        } as never,
        'conversation-1',
        4,
      ),
    ).resolves.toEqual(['I want a chicken burger', 'How much is it?']);

    expect(inboundEventModel.find).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      channelId: 'channel-1',
      platformCustomerIdentityId: 'customer-1',
      _id: { $lte: currentId },
      status: 'processed',
      text: { $type: 'string' },
    });
    expect(sort).toHaveBeenCalledWith({ _id: -1 });
    expect(limit).toHaveBeenCalledWith(4);
  });

  it('increments a monotonic fence whenever a run is claimed', async () => {
    const { repository, runModel } = createRepository();
    runModel.findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });
    const now = new Date('2026-09-01T00:00:00.000Z');
    const leaseExpiresAt = new Date('2026-09-01T00:00:20.000Z');

    await repository.claimRun({
      runId: '507f1f77bcf86cd799439011',
      leaseOwner: 'worker-a',
      now,
      leaseExpiresAt,
    });

    expect(runModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: '507f1f77bcf86cd799439011',
      }),
      expect.objectContaining({
        $inc: { attemptCount: 1, fencingToken: 1 },
      }),
      expect.any(Object),
    );
  });

  it('requires the current lease owner and fence for completion', async () => {
    const { repository, runModel } = createRepository();
    runModel.updateOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    });

    await expect(
      repository.completeShadowRun({
        runId: '507f1f77bcf86cd799439011',
        leaseOwner: 'worker-b',
        fencingToken: 9,
        completion: {
          providerCallCount: 2,
          toolCallCount: 1,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          estimatedCostMinorUnit: 0,
          latencyMs: 30,
          responseType: 'menu_recommendation',
          compilerReasonCode: null,
          policyAction: 'continue',
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
        },
      }),
    ).resolves.toBe(true);

    expect(runModel.updateOne).toHaveBeenCalledWith(
      {
        _id: '507f1f77bcf86cd799439011',
        status: 'running',
        leaseOwner: 'worker-b',
        fencingToken: 9,
      },
      expect.any(Object),
    );
  });

  it('serializes runs for one conversation with a separate session fence', async () => {
    const { repository, sessionModel } = createRepository();
    const now = new Date('2026-09-01T00:00:00.000Z');
    const leaseExpiresAt = new Date('2026-09-01T00:00:20.000Z');
    sessionModel.findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ fencingToken: 4 }),
    });

    await expect(
      repository.claimConversationLease({
        conversationId: 'conversation-1',
        runId: 'run-2',
        leaseOwner: 'worker-c',
        now,
        leaseExpiresAt,
      }),
    ).resolves.toBe(4);

    expect(sessionModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        conversationId: 'conversation-1',
        $or: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { $exists: false } },
          { leaseExpiresAt: { $lte: now } },
          { activeRunId: 'run-2', leaseOwner: 'worker-c' },
        ],
      },
      {
        $set: {
          activeRunId: 'run-2',
          leaseOwner: 'worker-c',
          leaseExpiresAt,
        },
        $inc: { fencingToken: 1 },
      },
      { returnDocument: 'after', runValidators: true },
    );
  });

  it('persists final stale-version evidence when superseding a run', async () => {
    const { repository, runModel } = createRepository();
    runModel.updateOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    });
    const policySignals = {
      schemaValid: true,
      toolErrorCount: 0,
      ambiguousResultCount: 0,
      missingRequiredFacts: [],
      staleVersionConflict: true,
      unavailableSelectedItem: false,
      scopeMismatch: false,
      contradictoryConstraints: false,
      supportedIntent: true,
      providerRequestedHandoff: false,
    };

    await repository.supersedeRun({
      runId: '507f1f77bcf86cd799439011',
      leaseOwner: 'worker-b',
      fencingToken: 9,
      policySignals,
      telemetry: {
        providerCallCount: 2,
        toolCallCount: 1,
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 30,
        estimatedCostMinorUnit: 4,
        latencyMs: 900,
      },
    });

    const update = runModel.updateOne.mock.calls[0]?.[1];

    expect(update?.$set).toEqual(
      expect.objectContaining({
        status: 'superseded',
        policyAction: 'handoff',
        policyReasonCode: 'stale_version_conflict',
        policySignals,
        providerCallCount: 2,
        estimatedCostMinorUnit: 4,
        latencyMs: 900,
      }),
    );
  });

  it('persists partial telemetry when a run fails', async () => {
    const { repository, runModel } = createRepository();
    runModel.updateOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    });

    await repository.failRun({
      runId: '507f1f77bcf86cd799439011',
      leaseOwner: 'worker-b',
      fencingToken: 9,
      errorCategory: 'provider_timeout',
      telemetry: {
        providerCallCount: 1,
        toolCallCount: 0,
        inputTokens: 80,
        cachedInputTokens: 10,
        outputTokens: 0,
        estimatedCostMinorUnit: 2,
        latencyMs: 8000,
      },
    });

    const update = runModel.updateOne.mock.calls[0]?.[1];

    expect(update?.$set).toEqual(
      expect.objectContaining({
        status: 'failed',
        errorCategory: 'provider_timeout',
        providerCallCount: 1,
        inputTokens: 80,
        estimatedCostMinorUnit: 2,
        latencyMs: 8000,
      }),
    );
  });

  it('rejects a tool audit from an obsolete fenced worker', async () => {
    const { repository, runModel, toolExecutionModel } = createRepository();
    runModel.updateOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    });

    await expect(
      repository.createToolExecution({
        runId: '507f1f77bcf86cd799439011',
        leaseOwner: 'worker-a',
        fencingToken: 4,
        sequence: 1,
      } as never),
    ).resolves.toBe(false);

    expect(runModel.updateOne).toHaveBeenCalledWith(
      {
        _id: '507f1f77bcf86cd799439011',
        status: 'running',
        leaseOwner: 'worker-a',
        fencingToken: 4,
      },
      { $inc: { toolAuditRevision: 1 } },
    );
    expect(toolExecutionModel.create).not.toHaveBeenCalled();
  });

  it('records the current worker audit under its fencing generation', async () => {
    const { repository, runModel, toolExecutionModel } = createRepository();
    runModel.updateOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    });
    const audit = {
      runId: '507f1f77bcf86cd799439011',
      leaseOwner: 'worker-b',
      fencingToken: 5,
      sequence: 1,
    };

    await expect(repository.createToolExecution(audit as never)).resolves.toBe(
      true,
    );

    expect(toolExecutionModel.create).toHaveBeenCalledWith(audit);
  });
});
