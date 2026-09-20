import {
  callProviderWithTimeout,
  callToolWithTimeout,
  CustomerAiOrchestratorService,
  safetyIdentifierForConversation,
} from './customer-ai-orchestrator.service';
import { CustomerAiPolicyEvidenceService } from './customer-ai-policy-evidence.service';
import { CustomerAiPolicyService } from './customer-ai-policy.service';
import { CustomerAiResponseCompilerService } from './customer-ai-response-compiler.service';

describe('customer AI provider timeout', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('aborts a provider call when its bounded timeout expires', async () => {
    jest.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    const operation = callProviderWithTimeout((signal) => {
      receivedSignal = signal;

      return new Promise<string>(() => undefined);
    }, 50);
    const rejection = expect(operation).rejects.toThrow(
      'CUSTOMER_AI_PROVIDER_TIMEOUT',
    );

    await jest.advanceTimersByTimeAsync(50);

    await rejection;
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('derives a stable non-identifying safety identifier', () => {
    const identifier = safetyIdentifierForConversation('conversation-123');

    expect(identifier).toMatch(/^ordira_[a-f0-9]{56}$/);
    expect(identifier).toBe(
      safetyIdentifierForConversation('conversation-123'),
    );
    expect(identifier).not.toContain('conversation-123');
  });

  it('bounds a read tool by the remaining turn time', async () => {
    jest.useFakeTimers();
    const operation = callToolWithTimeout(
      () => new Promise<string>(() => undefined),
      40,
    );
    const rejection = expect(operation).rejects.toThrow(
      'CUSTOMER_AI_TOOL_TIMEOUT',
    );

    await jest.advanceTimersByTimeAsync(40);

    await rejection;
  });
});

describe('CustomerAiOrchestratorService runtime shadow boundary', () => {
  it.each([
    ['off', 'fake', 'fake', 'shadow_safety_boundary_violation'],
    ['shadow', 'openai', 'fake', 'provider_config_changed'],
  ] as const)(
    'does not call the provider when mode/provider state changed',
    async (mode, selectedProvider, runProvider, errorCategory) => {
      const createTurn = jest.fn();
      const failRun = jest.fn().mockResolvedValue(true);
      const repository = {
        claimRun: jest.fn().mockResolvedValue({
          fencingToken: 4,
          mode: 'shadow',
          sideEffectCommitted: false,
          provider: runProvider,
        }),
        failRun,
      };
      const service = new CustomerAiOrchestratorService(
        { name: selectedProvider, createTurn },
        repository as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { increment: jest.fn() } as never,
        {} as never,
        { mode, turnDeadlineMs: 15000 } as never,
      );

      await service.processRun('507f1f77bcf86cd799439011', 'worker-1');

      expect(createTurn).not.toHaveBeenCalled();
      expect(failRun).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: '507f1f77bcf86cd799439011',
          leaseOwner: 'worker-1',
          fencingToken: 4,
          errorCategory,
        }),
      );
    },
  );

  it('does not execute a queued run after its implementation contract changes', async () => {
    const createTurn = jest.fn();
    const repository = createRunnableRepository({
      claimRun: jest.fn().mockResolvedValue({
        ...runnableRun(),
        promptVersion: 'prompt-v0',
      }),
    });
    const service = createRunnableOrchestrator({ repository, createTurn });

    await service.processRun('507f1f77bcf86cd799439011', 'worker-1');

    expect(createTurn).not.toHaveBeenCalled();
    expect(repository.findInboundEvent).not.toHaveBeenCalled();
    expect(repository.failRun).toHaveBeenCalledWith(
      expect.objectContaining({ errorCategory: 'execution_contract_changed' }),
    );
  });

  it('persists a provider-requested handoff as a policy outcome', async () => {
    const completeShadowRun = jest
      .fn<Promise<boolean>, [CompleteShadowRunInput]>()
      .mockResolvedValue(true);
    const repository = createRunnableRepository({ completeShadowRun });
    const service = createRunnableOrchestrator({
      repository,
      createTurn: jest.fn().mockResolvedValue({
        kind: 'response_plan',
        responsePlan: { responseType: 'handoff', reasonCode: 'unclear' },
      }),
    });

    await service.processRun('507f1f77bcf86cd799439011', 'worker-1');

    const completion = completeShadowRun.mock.calls[0]?.[0].completion;

    expect(completion?.policyAction).toBe('handoff');
    expect(completion?.policyReasonCode).toBe('provider_requested_handoff');
    expect(completion?.policySignals.providerRequestedHandoff).toBe(true);
    expect(completion?.outcomeCode).toBe(
      'shadow_handoff_provider_requested_handoff',
    );
  });

  it('passes bounded chronological customer context to the stateless provider', async () => {
    const createTurn = jest.fn().mockResolvedValue({
      kind: 'response_plan',
      responsePlan: {
        responseType: 'low_risk_text',
        text: 'What would you like to find?',
      },
    });
    const repository = createRunnableRepository({
      findRecentCustomerMessages: jest
        .fn()
        .mockResolvedValue(['I want a burger', 'Help me choose']),
    });
    const service = createRunnableOrchestrator({ repository, createTurn });

    await service.processRun('507f1f77bcf86cd799439011', 'worker-1');

    expect(createTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        customerMessage: 'Help me choose',
        contextMessages: ['I want a burger', 'Help me choose'],
      }),
    );
    expect(repository.findRecentCustomerMessages).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Help me choose' }),
      'conversation-1',
      4,
    );
  });

  it('feeds the final causal mismatch into policy before superseding', async () => {
    const supersedeRun = jest
      .fn<Promise<boolean>, [SupersedeRunInput]>()
      .mockResolvedValue(true);
    const repository = createRunnableRepository({
      isRunCausallyCurrent: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      supersedeRun,
    });
    const service = createRunnableOrchestrator({
      repository,
      createTurn: jest.fn().mockResolvedValue({
        kind: 'response_plan',
        responsePlan: {
          responseType: 'low_risk_text',
          text: 'What would you like to find?',
        },
      }),
    });

    await service.processRun('507f1f77bcf86cd799439011', 'worker-1');

    const policySignals = supersedeRun.mock.calls[0]?.[0].policySignals;

    expect(policySignals?.staleVersionConflict).toBe(true);
    expect(repository.completeShadowRun).not.toHaveBeenCalled();
  });

  it('persists partial usage and latency when a turn fails after provider work', async () => {
    const failRun = jest
      .fn<Promise<boolean>, [FailRunInput]>()
      .mockResolvedValue(true);
    const repository = createRunnableRepository({ failRun });
    const service = createRunnableOrchestrator({
      repository,
      createTurn: jest.fn().mockResolvedValue({
        kind: 'tool_calls',
        toolCalls: [
          {
            callId: 'call-1',
            toolName: 'search_menu_items',
            arguments: { q: 'burger' },
          },
        ],
        usage: {
          inputTokens: 120,
          cachedInputTokens: 20,
          outputTokens: 15,
          estimatedCostMinorUnit: 3,
        },
      }),
      executeTool: jest.fn().mockRejectedValue(new Error('search unavailable')),
    });

    await service.processRun('507f1f77bcf86cd799439011', 'worker-1');

    const failure = failRun.mock.calls[0]?.[0];

    expect(failure?.errorCategory).toBe('provider_call_limit_exceeded');
    expect(failure?.telemetry).toMatchObject({
      providerCallCount: 1,
      toolCallCount: 1,
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 15,
      estimatedCostMinorUnit: 3,
    });
    expect(failure?.telemetry?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('treats audit persistence failure separately from a domain tool failure', async () => {
    const repository = createRunnableRepository({
      createToolExecution: jest
        .fn()
        .mockRejectedValue(new Error('mongo audit unavailable')),
    });
    const service = createRunnableOrchestrator({
      repository,
      createTurn: jest.fn().mockResolvedValue({
        kind: 'tool_calls',
        toolCalls: [
          {
            callId: 'call-1',
            toolName: 'search_menu_items',
            arguments: { q: 'burger' },
          },
        ],
      }),
      executeTool: jest.fn().mockResolvedValue({
        providerResult: {
          callId: 'call-1',
          toolName: 'search_menu_items',
          status: 'succeeded',
          output: { results: [] },
        },
        resultCardinality: 0,
        returnedRefs: [],
      }),
    });

    await service.processRun('507f1f77bcf86cd799439011', 'worker-1');

    expect(repository.failRun).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCategory: 'tool_audit_persistence_failed',
      }),
    );
    expect(repository.createToolExecution).toHaveBeenCalledTimes(1);
  });

  it('stops an obsolete worker when its fenced tool audit is rejected', async () => {
    const repository = createRunnableRepository({
      createToolExecution: jest.fn().mockResolvedValue(false),
    });
    const service = createRunnableOrchestrator({
      repository,
      createTurn: jest.fn().mockResolvedValue({
        kind: 'tool_calls',
        toolCalls: [
          {
            callId: 'call-1',
            toolName: 'search_menu_items',
            arguments: { q: 'burger' },
          },
        ],
      }),
      executeTool: jest.fn().mockRejectedValue(new Error('search failed')),
    });

    await service.processRun('507f1f77bcf86cd799439011', 'worker-old');

    expect(repository.failRun).not.toHaveBeenCalled();
    expect(repository.completeShadowRun).not.toHaveBeenCalled();
  });

  it('rejects an identical repeated tool call before executing it twice', async () => {
    const createTurn = jest
      .fn()
      .mockResolvedValueOnce({
        kind: 'tool_calls',
        toolCalls: [
          {
            callId: 'call-1',
            toolName: 'search_menu_items',
            arguments: { q: 'burger', limit: 4 },
          },
        ],
      })
      .mockResolvedValueOnce({
        kind: 'tool_calls',
        toolCalls: [
          {
            callId: 'call-2',
            toolName: 'search_menu_items',
            arguments: { limit: 4, q: 'burger' },
          },
        ],
      });
    const executeTool = jest.fn().mockResolvedValue({
      providerResult: {
        callId: 'call-1',
        toolName: 'search_menu_items',
        status: 'succeeded',
        output: { results: [] },
      },
      resultCardinality: 0,
      returnedRefs: [],
    });
    const repository = createRunnableRepository({
      claimRun: jest.fn().mockResolvedValue({
        ...runnableRun(),
        maxProviderCalls: 2,
        maxToolCalls: 4,
      }),
    });
    const service = createRunnableOrchestrator({
      repository,
      createTurn,
      executeTool,
    });

    await service.processRun('507f1f77bcf86cd799439011', 'worker-1');

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(repository.failRun).toHaveBeenCalledWith(
      expect.objectContaining({ errorCategory: 'duplicate_tool_call' }),
    );
  });
});

interface CompleteShadowRunInput {
  completion: {
    policyAction: string;
    policyReasonCode: string | null;
    policySignals: {
      providerRequestedHandoff: boolean;
    };
    outcomeCode: string;
  };
}

interface SupersedeRunInput {
  policySignals?: {
    staleVersionConflict: boolean;
  };
}

interface FailRunInput {
  errorCategory: string;
  telemetry?: {
    providerCallCount: number;
    toolCallCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    estimatedCostMinorUnit: number;
    latencyMs: number;
  };
}

interface RunnableRepository {
  claimRun: jest.Mock;
  failRun: jest.Mock;
  findInboundEvent: jest.Mock;
  findRecentCustomerMessages: jest.Mock;
  isRunCausallyCurrent: jest.Mock;
  ensureSession: jest.Mock;
  claimConversationLease: jest.Mock;
  releaseConversationLease: jest.Mock;
  createToolExecution: jest.Mock;
  completeShadowRun: jest.Mock;
  supersedeRun: jest.Mock;
}

function createRunnableRepository(
  overrides: Partial<RunnableRepository> = {},
): RunnableRepository {
  return {
    claimRun: jest.fn().mockResolvedValue(runnableRun()),
    failRun: jest.fn().mockResolvedValue(true),
    findInboundEvent: jest.fn().mockResolvedValue({ text: 'Help me choose' }),
    findRecentCustomerMessages: jest.fn().mockResolvedValue(['Help me choose']),
    isRunCausallyCurrent: jest.fn().mockResolvedValue(true),
    ensureSession: jest.fn().mockResolvedValue(undefined),
    claimConversationLease: jest.fn().mockResolvedValue(7),
    releaseConversationLease: jest.fn().mockResolvedValue(undefined),
    createToolExecution: jest.fn().mockResolvedValue(true),
    completeShadowRun: jest.fn().mockResolvedValue(true),
    supersedeRun: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function runnableRun() {
  return {
    fencingToken: 4,
    mode: 'shadow',
    sideEffectCommitted: false,
    provider: 'fake',
    model: null,
    reasoningEffort: null,
    inboundEventId: '507f1f77bcf86cd799439012',
    conversationId: 'conversation-1',
    phase: 'discovery',
    promptVersion: 'prompt-v1',
    policyVersion: 'policy-v1',
    toolContractVersion: 'tools-v1',
    responseContractVersion: 'response-v1',
    maxProviderCalls: 1,
    maxToolCalls: 1,
    maxOutputTokens: 100,
    maxContextMessages: 4,
    turnDeadlineMs: 15000,
  };
}

function createRunnableOrchestrator(input: {
  repository: RunnableRepository;
  createTurn: jest.Mock;
  executeTool?: jest.Mock;
}): CustomerAiOrchestratorService {
  return new CustomerAiOrchestratorService(
    { name: 'fake', createTurn: input.createTurn },
    input.repository as never,
    { execute: input.executeTool ?? jest.fn() } as never,
    new CustomerAiResponseCompilerService(),
    new CustomerAiPolicyEvidenceService(),
    new CustomerAiPolicyService(),
    { increment: jest.fn() } as never,
    {
      acquirePermit: jest.fn().mockResolvedValue({
        key: 'fake:default',
        requestId: 'permit-1',
        generation: 1,
        halfOpenProbe: false,
      }),
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    } as never,
    {
      mode: 'shadow',
      turnDeadlineMs: 15000,
      apiTimeoutMs: 8000,
      promptVersion: 'prompt-v1',
      policyVersion: 'policy-v1',
      toolContractVersion: 'tools-v1',
      responseContractVersion: 'response-v1',
    } as never,
  );
}
