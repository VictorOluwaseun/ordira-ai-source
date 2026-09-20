import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createStableStringifier } from '@common/utils/json.util';
import { customerAiConfig } from '@config/customer-ai.config';
import {
  CUSTOMER_AI_PROVIDER,
  type CustomerAiProvider,
  type CustomerAiProviderResult,
  type CustomerAiProviderToolResult,
  type CustomerAiProviderUsage,
  type CustomerAiRunScopedFact,
} from './customer-ai.types';
import { CustomerAiPolicyService } from './customer-ai-policy.service';
import { CustomerAiPolicyEvidenceService } from './customer-ai-policy-evidence.service';
import { CustomerAiMetricsService } from './customer-ai-metrics.service';
import { CustomerAiProviderHealthService } from './customer-ai-provider-health.service';
import { validateCustomerAiProviderResult } from './customer-ai-provider-result.validator';
import { CustomerAiReadToolsService } from './customer-ai-read-tools.service';
import { CustomerAiRepository } from './customer-ai.repository';
import { CustomerAiResponseCompilerService } from './customer-ai-response-compiler.service';

const stableStringify = createStableStringifier({
  undefinedValue: 'null',
  omitUndefinedObjectProperties: true,
});

/**
 * Coordinates one durable customer-AI run from claim to terminal status.
 *
 * The flow is intentionally defensive and layered:
 * 1. claim the run with a new fencing token;
 * 2. re-check shadow-only configuration and causal conversation versions;
 * 3. serialize work with a conversation lease;
 * 4. alternate bounded provider calls and read-only tools;
 * 5. compile model-selected refs through authoritative Ordira facts;
 * 6. re-check causality before recording the shadow outcome.
 *
 * This implementation never sends the compiled response to WhatsApp and never
 * calls a draft-write or commit tool.
 */
@Injectable()
export class CustomerAiOrchestratorService {
  constructor(
    @Inject(CUSTOMER_AI_PROVIDER)
    private readonly provider: CustomerAiProvider,
    private readonly repository: CustomerAiRepository,
    private readonly readToolsService: CustomerAiReadToolsService,
    private readonly compiler: CustomerAiResponseCompilerService,
    private readonly policyEvidence: CustomerAiPolicyEvidenceService,
    private readonly policy: CustomerAiPolicyService,
    private readonly metrics: CustomerAiMetricsService,
    private readonly providerHealth: CustomerAiProviderHealthService,
    @Inject(customerAiConfig.KEY)
    private readonly config: ConfigType<typeof customerAiConfig>,
  ) {}

  async processRun(runId: string, leaseOwner: string): Promise<void> {
    const startedAt = Date.now();
    // Claiming atomically changes queued/stale-running work to running and
    // increments its fencing token. A null result means another worker won.
    const run = await this.repository.claimRun({
      runId,
      leaseOwner,
      now: new Date(startedAt),
      leaseExpiresAt: new Date(startedAt + this.config.turnDeadlineMs + 5000),
    });
    if (!run) {
      return;
    }
    const fenced = {
      runId,
      leaseOwner,
      fencingToken: run.fencingToken,
    };
    let conversationLeaseFencingToken: number | null = null;
    // Keep partial usage outside the main try block so terminal failure and
    // supersession records include work already performed before the error.
    const usage = emptyUsage();
    let providerCallCount = 0;
    let toolCallCount = 0;
    let toolErrorCount = 0;
    const currentTelemetry = () => ({
      providerCallCount,
      toolCallCount,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostMinorUnit: usage.estimatedCostMinorUnit,
      latencyMs: Date.now() - startedAt,
    });

    try {
      // Re-check the kill switch at execution time. A run queued before an
      // operator disables shadow mode must not continue under stale settings.
      if (
        this.config.mode !== 'shadow' ||
        run.mode !== 'shadow' ||
        run.sideEffectCommitted
      ) {
        await this.repository.failRun({
          ...fenced,
          errorCategory: 'shadow_safety_boundary_violation',
          telemetry: currentTelemetry(),
        });
        return;
      }
      // Provider identity is part of the run snapshot. Changing it while work
      // is queued requires a new run rather than silently changing behavior.
      if (this.provider.name !== run.provider) {
        await this.repository.failRun({
          ...fenced,
          errorCategory: 'provider_config_changed',
          telemetry: currentTelemetry(),
        });
        return;
      }
      // Prompt, policy, tool, and compiler implementations are deployed with
      // one current version each. An older queued run must fail closed instead
      // of executing new code under its stale snapshot labels.
      if (
        run.promptVersion !== this.config.promptVersion ||
        run.policyVersion !== this.config.policyVersion ||
        run.toolContractVersion !== this.config.toolContractVersion ||
        run.responseContractVersion !== this.config.responseContractVersion
      ) {
        await this.repository.failRun({
          ...fenced,
          errorCategory: 'execution_contract_changed',
          telemetry: currentTelemetry(),
        });
        return;
      }
      const inboundEvent = await this.repository.findInboundEvent(
        run.inboundEventId,
      );
      const customerMessage = inboundEvent?.text?.trim();
      if (!inboundEvent || !customerMessage) {
        await this.repository.failRun({
          ...fenced,
          errorCategory: 'customer_message_missing',
          telemetry: currentTelemetry(),
        });
        return;
      }
      // First causal guard: do not spend provider budget on an answer to an old
      // customer message or deterministic conversation state.
      if (!(await this.repository.isRunCausallyCurrent(run))) {
        this.metrics.increment('stale_responses_suppressed');
        await this.repository.supersedeRun({
          ...fenced,
          telemetry: currentTelemetry(),
        });
        return;
      }
      // OpenAI storage stays disabled, so each call receives a small,
      // customer-only history ending at this exact inbound event. The limit is
      // snapshotted on the run to keep recovered work reproducible.
      const contextMessages = await this.repository.findRecentCustomerMessages(
        inboundEvent,
        run.conversationId,
        run.maxContextMessages,
      );
      await this.repository.ensureSession(run);
      // The run lease protects one durable job; the conversation lease also
      // prevents two different inbound runs from reasoning concurrently.
      conversationLeaseFencingToken =
        await this.repository.claimConversationLease({
          conversationId: run.conversationId,
          runId,
          leaseOwner,
          now: new Date(),
          leaseExpiresAt: new Date(
            startedAt + this.config.turnDeadlineMs + 5000,
          ),
        });
      if (conversationLeaseFencingToken === null) {
        await this.repository.requeueRun(fenced);
        return;
      }

      const healthKey = `${run.provider}:${run.model ?? 'default'}`;
      const factsByRef = new Map<string, CustomerAiRunScopedFact>();
      const priorToolResults: CustomerAiProviderToolResult[] = [];
      const executedToolSignatures = new Set<string>();
      // A turn may alternate provider -> tools -> provider, but both provider
      // and tool counts are capped by the immutable run snapshot.
      while (providerCallCount < run.maxProviderCalls) {
        assertBeforeDeadline(startedAt, run.turnDeadlineMs);
        providerCallCount += 1;
        // Every provider round trip needs its own distributed breaker permit.
        // The returned generation follows the request through completion so a
        // late half-open outcome cannot alter a newer breaker generation.
        const healthPermit = await this.providerHealth.acquirePermit(healthKey);
        if (!healthPermit) {
          await this.repository.failRun({
            ...fenced,
            errorCategory: 'provider_circuit_open',
            telemetry: currentTelemetry(),
          });
          return;
        }
        let providerResult: CustomerAiProviderResult;
        try {
          // Each call receives only the smaller of the provider timeout and the
          // remaining whole-turn budget.
          const timeoutMs = Math.max(
            1,
            Math.min(
              this.config.apiTimeoutMs,
              run.turnDeadlineMs - (Date.now() - startedAt),
            ),
          );
          providerResult = validateCustomerAiProviderResult(
            await callProviderWithTimeout(
              (signal) =>
                this.provider.createTurn({
                  runId,
                  // Includes the run fence and call number, making spend
                  // reservation idempotent for this exact provider attempt.
                  budgetReservationId: `${runId}:${run.fencingToken}:${providerCallCount}`,
                  safetyIdentifier: safetyIdentifierForConversation(
                    run.conversationId,
                  ),
                  model: run.model ?? null,
                  reasoningEffort: run.reasoningEffort ?? null,
                  customerMessage,
                  contextMessages,
                  phase: run.phase,
                  promptVersion: run.promptVersion,
                  policyVersion: run.policyVersion,
                  toolContractVersion: run.toolContractVersion,
                  responseContractVersion: run.responseContractVersion,
                  priorToolResults,
                  maxOutputTokens: run.maxOutputTokens,
                  signal,
                }),
              timeoutMs,
            ),
          );
          await this.providerHealth.recordSuccess(healthPermit);
          addUsage(usage, providerResult.usage);
        } catch (error) {
          this.metrics.increment('provider_failures');
          recordProviderFailureMetric(this.metrics, error);
          if (isProviderHealthFailure(error)) {
            await this.providerHealth.recordFailure(healthPermit);
          }
          throw error;
        }

        if (providerResult.kind === 'tool_calls') {
          // Tool calls are executed sequentially. This keeps sequence numbers,
          // audit records, and the run-scoped fact map deterministic.
          for (const call of providerResult.toolCalls) {
            const toolSignature = `${call.toolName}:${hashArguments(call.arguments)}`;
            // Repeating the same read cannot add evidence and wastes both the
            // tool budget and turn deadline. Fail explicitly so evaluations
            // expose the routing defect instead of hiding it behind call caps.
            if (executedToolSignatures.has(toolSignature)) {
              throw new Error('CUSTOMER_AI_DUPLICATE_TOOL_CALL');
            }
            executedToolSignatures.add(toolSignature);
            if (toolCallCount >= run.maxToolCalls) {
              throw new Error('CUSTOMER_AI_TOOL_CALL_LIMIT');
            }
            toolCallCount += 1;
            const toolStartedAt = Date.now();
            let audit: Omit<
              Parameters<CustomerAiRepository['createToolExecution']>[0],
              'runId' | 'leaseOwner' | 'fencingToken'
            >;
            try {
              // Read tools share the whole-turn deadline. Promise timeout does
              // not make the underlying domain query authoritative after the
              // fence expires; only the later fenced audit can accept it.
              const remainingTurnMs = Math.max(
                1,
                run.turnDeadlineMs - (Date.now() - startedAt),
              );
              const result = await callToolWithTimeout(
                () =>
                  this.readToolsService.execute(call, {
                    runId,
                    sequence: toolCallCount,
                    factsByRef,
                  }),
                remainingTurnMs,
              );
              priorToolResults.push(result.providerResult);
              audit = {
                sequence: toolCallCount,
                toolName: call.toolName,
                contractVersion: run.toolContractVersion,
                sideEffectClass: 'read',
                argumentsHash: hashArguments(call.arguments),
                sanitizedArgumentSummary: summarizeArguments(call.arguments),
                status: 'succeeded',
                domainResponseCode: 'ok',
                latencyMs: Date.now() - toolStartedAt,
                retryCount: 0,
                resultCardinality: result.resultCardinality,
                returnedRefs: result.returnedRefs,
                idempotencyKeyHash: null,
                expectedVersion: null,
                committedVersion: null,
                expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              };
            } catch (error) {
              // A tool failure becomes structured provider context and an audit
              // row. The model may reason again, while deterministic policy will
              // still require handoff before a response is accepted.
              const errorCode = toolExecutionErrorCode(error);
              toolErrorCount += 1;
              this.metrics.increment('tool_failures');
              priorToolResults.push({
                callId: call.callId,
                toolName: call.toolName,
                status: 'failed',
                errorCode,
              });
              audit = {
                sequence: toolCallCount,
                toolName: call.toolName,
                contractVersion: run.toolContractVersion,
                sideEffectClass: 'read',
                argumentsHash: hashArguments(call.arguments),
                sanitizedArgumentSummary: summarizeArguments(call.arguments),
                status: 'failed',
                domainResponseCode: errorCode,
                latencyMs: Date.now() - toolStartedAt,
                retryCount: 0,
                resultCardinality: 0,
                returnedRefs: [],
                idempotencyKeyHash: null,
                expectedVersion: null,
                committedVersion: null,
                expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              };
            }

            // Audit persistence is deliberately outside the domain-tool catch.
            // A storage failure is an orchestrator failure, not evidence that
            // the restaurant/menu lookup itself failed.
            let auditRecorded: boolean;
            try {
              auditRecorded = await this.repository.createToolExecution({
                ...fenced,
                ...audit,
              });
            } catch {
              throw new Error('CUSTOMER_AI_TOOL_AUDIT_PERSIST_FAILED');
            }
            if (!auditRecorded) {
              // Ownership changed while the tool was in flight. The obsolete
              // worker stops without writing a terminal state for its successor.
              this.metrics.increment('stale_responses_suppressed');
              return;
            }
          }
          continue;
        }

        // The model proposes refs/copy; the compiler renders authoritative
        // facts and rejects free-form transactional claims.
        const compiled = this.compiler.compile(
          providerResult.responsePlan,
          factsByRef,
        );
        // Customer input may have arrived while the provider or tools were in
        // flight. Feed that fact into policy before deciding the run outcome.
        const causallyCurrent = await this.repository.isRunCausallyCurrent(run);
        // Policy evidence is derived from compiler/tool/domain state. The model
        // never supplies or clears these safety signals.
        const policySignals = this.policyEvidence.collect({
          customerMessage,
          phase: run.phase,
          responsePlan: providerResult.responsePlan,
          compiled,
          factsByRef,
          toolErrorCount,
          staleVersionConflict: !causallyCurrent,
        });
        const decision = this.policy.decide(policySignals);
        // Final causal guard: customer input may have arrived while provider or
        // tool calls were in flight. Stale output is never recorded as usable.
        if (!causallyCurrent) {
          this.metrics.increment('stale_responses_suppressed');
          await this.repository.supersedeRun({
            ...fenced,
            policySignals,
            telemetry: currentTelemetry(),
          });
          return;
        }
        const completed = await this.repository.completeShadowRun({
          ...fenced,
          completion: {
            providerCallCount,
            toolCallCount,
            inputTokens: usage.inputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            outputTokens: usage.outputTokens,
            estimatedCostMinorUnit: usage.estimatedCostMinorUnit,
            latencyMs: Date.now() - startedAt,
            responseType: providerResult.responsePlan.responseType,
            compilerReasonCode:
              compiled.status === 'rejected' ? compiled.reasonCode : null,
            policyAction: decision.action,
            policyReasonCode:
              decision.action === 'handoff' ? decision.reasonCode : null,
            policySignals,
            outcomeCode:
              decision.action === 'continue'
                ? compiled.status === 'compiled'
                  ? 'shadow_compiled'
                  : 'shadow_compile_rejected'
                : `shadow_handoff_${decision.reasonCode}`,
          },
        });
        // compiled.text is deliberately neither persisted nor dispatched in
        // shadow mode. Only its safety outcome and response type are measured.
        this.metrics.increment(
          // A failed fenced completion means ownership changed after the final
          // causal read; treat that output as stale rather than retrying a write.
          completed ? 'shadow_runs_completed' : 'stale_responses_suppressed',
        );
        return;
      }

      throw new Error('CUSTOMER_AI_PROVIDER_CALL_LIMIT');
    } catch (error) {
      // Error categories are stable, sanitized operational labels. Provider
      // response bodies and raw customer data are never stored here.
      this.metrics.increment('shadow_runs_failed');
      await this.repository.failRun({
        ...fenced,
        errorCategory: categorizeError(error),
        telemetry: currentTelemetry(),
      });
    } finally {
      if (conversationLeaseFencingToken !== null) {
        // Release is itself fenced. Failure is safe: the lease expires and the
        // recovery sweep can proceed after the deadline.
        await this.repository
          .releaseConversationLease({
            conversationId: run.conversationId,
            leaseOwner,
            fencingToken: conversationLeaseFencingToken,
          })
          .catch(() => undefined);
      }
    }
  }
}

type MutableUsage = Required<CustomerAiProviderUsage>;

function emptyUsage(): MutableUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostMinorUnit: 0,
  };
}

function addUsage(total: MutableUsage, usage?: CustomerAiProviderUsage): void {
  // Provider usage is accumulated across every reasoning/tool round trip.
  total.inputTokens += usage?.inputTokens ?? 0;
  total.cachedInputTokens += usage?.cachedInputTokens ?? 0;
  total.outputTokens += usage?.outputTokens ?? 0;
  total.totalTokens += usage?.totalTokens ?? 0;
  total.estimatedCostMinorUnit += usage?.estimatedCostMinorUnit ?? 0;
}

function assertBeforeDeadline(startedAt: number, deadlineMs: number): void {
  if (Date.now() - startedAt >= deadlineMs) {
    throw new Error('CUSTOMER_AI_TURN_DEADLINE');
  }
}

function hashArguments(value: Record<string, unknown>): string {
  // Hashes support correlation/deduplication without persisting raw arguments.
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function safetyIdentifierForConversation(
  conversationId: string,
): string {
  // The provider receives a stable abuse-monitoring identifier that cannot be
  // reversed into Ordira's internal conversation ID.
  return `ordira_${createHash('sha256')
    .update(conversationId)
    .digest('hex')
    .slice(0, 56)}`;
}

function summarizeArguments(
  value: Record<string, unknown>,
): Record<string, unknown> {
  // Keep only structural metadata useful for debugging and evaluation.
  return {
    argumentNames: Object.keys(value).sort(),
    queryLength: typeof value.q === 'string' ? value.q.length : 0,
    hasLocation: value.lat !== undefined && value.lng !== undefined,
    requestedLimit: typeof value.limit === 'number' ? value.limit : null,
  };
}

function categorizeError(error: unknown): string {
  // Convert internal/provider errors to a finite set safe for persistence and
  // metrics. Unknown exceptions collapse to a generic orchestrator failure.
  const message = error instanceof Error ? error.message : '';
  if (message.includes('DEADLINE')) {
    return 'turn_deadline_exceeded';
  }
  if (message.includes('TOOL_CALL_LIMIT')) {
    return 'tool_call_limit_exceeded';
  }
  if (message.includes('DUPLICATE_TOOL_CALL')) {
    return 'duplicate_tool_call';
  }
  if (message.includes('TOOL_TIMEOUT')) {
    return 'tool_timeout';
  }
  if (message.includes('TOOL_AUDIT_PERSIST_FAILED')) {
    return 'tool_audit_persistence_failed';
  }
  if (message.includes('PROVIDER_CALL_LIMIT')) {
    return 'provider_call_limit_exceeded';
  }
  if (message.includes('PROVIDER_TIMEOUT')) {
    return 'provider_timeout';
  }
  if (message.includes('PROVIDER_SCHEMA_INVALID')) {
    return 'provider_schema_invalid';
  }
  if (message.includes('PROVIDER_RATE_LIMITED')) {
    return 'provider_rate_limited';
  }
  if (message.includes('PROVIDER_REFUSAL')) {
    return 'provider_refusal';
  }
  if (message.includes('PROVIDER_OUTPUT_LIMIT')) {
    return 'provider_output_limit';
  }
  if (message.includes('PROVIDER_AUTH_FAILED')) {
    return 'provider_auth_failed';
  }
  if (message.includes('PROVIDER_REQUEST_REJECTED')) {
    return 'provider_request_rejected';
  }
  if (message.includes('PROVIDER_UNAVAILABLE')) {
    return 'provider_unavailable';
  }
  if (message.includes('PROVIDER_TRANSPORT_ERROR')) {
    return 'provider_transport_error';
  }
  if (message.includes('PROVIDER_ABORTED')) {
    return 'provider_aborted';
  }
  if (message.includes('PROVIDER_INCOMPLETE')) {
    return 'provider_incomplete';
  }
  if (message.includes('PROVIDER_NOT_CONFIGURED')) {
    return 'provider_not_configured';
  }
  if (message.includes('PROVIDER_HEALTH_UNAVAILABLE')) {
    return 'provider_health_unavailable';
  }
  if (message.includes('SPEND_LIMIT')) {
    return 'spend_limit_exceeded';
  }
  if (message.includes('SPEND_')) {
    return 'spend_guard_failure';
  }

  return 'orchestrator_failure';
}

function isProviderHealthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';

  // Refusals and spend denials do not imply provider instability, so they do
  // not contribute to opening the circuit.
  return [
    'CUSTOMER_AI_PROVIDER_TIMEOUT',
    'CUSTOMER_AI_PROVIDER_RATE_LIMITED',
    'CUSTOMER_AI_PROVIDER_UNAVAILABLE',
    'CUSTOMER_AI_PROVIDER_TRANSPORT_ERROR',
    'CUSTOMER_AI_PROVIDER_ABORTED',
    'CUSTOMER_AI_PROVIDER_AUTH_FAILED',
    'CUSTOMER_AI_PROVIDER_REQUEST_REJECTED',
    'CUSTOMER_AI_PROVIDER_SCHEMA_INVALID',
    'CUSTOMER_AI_PROVIDER_OUTPUT_LIMIT',
    'CUSTOMER_AI_PROVIDER_INCOMPLETE',
  ].includes(message);
}

function recordProviderFailureMetric(
  metrics: CustomerAiMetricsService,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : '';
  if (message === 'CUSTOMER_AI_PROVIDER_RATE_LIMITED') {
    metrics.increment('provider_rate_limits');
  } else if (message === 'CUSTOMER_AI_PROVIDER_REFUSAL') {
    metrics.increment('provider_refusals');
  } else if (message === 'CUSTOMER_AI_PROVIDER_SCHEMA_INVALID') {
    metrics.increment('provider_schema_failures');
  } else if (message === 'CUSTOMER_AI_SPEND_LIMIT') {
    metrics.increment('spend_limit_denials');
  }
}

export async function callProviderWithTimeout<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  // Abort the SDK request as well as rejecting locally. The provider adapter
  // receives this signal and must pass it to its network client.
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('CUSTOMER_AI_PROVIDER_TIMEOUT'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([call(controller.signal), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function callToolWithTimeout<T>(
  call: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  // Current read tools do not expose an AbortSignal, so the timeout rejects the
  // turn locally. Any late result remains in the obsolete worker's memory and
  // cannot be audited or completed without its still-current fence.
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error('CUSTOMER_AI_TOOL_TIMEOUT')),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([call(), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function toolExecutionErrorCode(error: unknown): string {
  return error instanceof Error && error.message === 'CUSTOMER_AI_TOOL_TIMEOUT'
    ? 'tool_timeout'
    : 'tool_execution_failed';
}
