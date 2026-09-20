import type {
  CustomerAiMode,
  CustomerAiProviderName,
  CustomerAiReasoningEffort,
} from '@config/types/env.types';

/**
 * Shared contracts for the customer-AI pipeline.
 *
 * The important boundary in this file is between a provider's proposal and
 * Ordira's authoritative data. The model may request read-only tools and may
 * select opaque references returned by those tools, but it does not own prices,
 * availability, fulfillment state, or any committed order state.
 */

/** The broad part of the customer journey the AI is reasoning about. */
export type CustomerAiPhase =
  | 'discovery'
  | 'selection'
  | 'checkout_draft'
  | 'handoff';

export type CustomerAiRunStatus =
  | 'queued'
  | 'running'
  | 'shadow_completed'
  | 'failed'
  | 'timed_out'
  | 'superseded'
  | 'handed_off';

export type CustomerAiSideEffectClass = 'read' | 'draft_write' | 'commit';

/**
 * A provider returns a response plan, not final transactional copy.
 * Recommendation refs are resolved by CustomerAiResponseCompilerService so
 * Ordira—not the model—renders facts such as prices and availability.
 */
export type CustomerAiResponsePlan =
  | {
      responseType: 'menu_recommendation';
      itemRefs: string[];
      introduction?: string;
    }
  | {
      responseType: 'restaurant_recommendation';
      restaurantRefs: string[];
      introduction?: string;
    }
  | {
      responseType: 'low_risk_text';
      text: string;
    }
  | {
      responseType: 'handoff';
      reasonCode: string;
    };

export type CustomerAiToolCall = {
  callId: string;
  toolName: 'search_restaurants' | 'search_menu_items';
  arguments: Record<string, unknown>;
};

/** A sanitized tool result that is safe to send back to the provider. */
export type CustomerAiProviderToolResult = {
  callId: string;
  toolName: string;
  status: 'succeeded' | 'failed';
  output?: Record<string, unknown>;
  errorCode?: string;
};

/**
 * Everything needed for one stateless provider call. Contract versions are
 * snapshotted on the run so a queued run cannot silently change behavior after
 * a deployment.
 */
export type CustomerAiProviderRequest = {
  runId: string;
  budgetReservationId: string;
  safetyIdentifier: string;
  model: string | null;
  reasoningEffort: CustomerAiReasoningEffort | null;
  customerMessage: string;
  /**
   * Recent customer messages in chronological order, including
   * customerMessage as the final entry. Keeping this provider-neutral and
   * bounded lets a stateless provider resolve follow-ups without receiving an
   * unbounded conversation transcript or provider-side stored state.
   */
  contextMessages: string[];
  phase: CustomerAiPhase;
  promptVersion: string;
  policyVersion: string;
  toolContractVersion: string;
  responseContractVersion: string;
  priorToolResults: CustomerAiProviderToolResult[];
  maxOutputTokens: number;
  signal: AbortSignal;
};

export type CustomerAiProviderResult =
  | {
      kind: 'tool_calls';
      toolCalls: CustomerAiToolCall[];
      usage?: CustomerAiProviderUsage;
    }
  | {
      kind: 'response_plan';
      responsePlan: CustomerAiResponsePlan;
      usage?: CustomerAiProviderUsage;
    };

export type CustomerAiProviderUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostMinorUnit?: number;
};

export interface CustomerAiProvider {
  readonly name: CustomerAiProviderName;
  createTurn(
    request: CustomerAiProviderRequest,
  ): Promise<CustomerAiProviderResult>;
}

/**
 * Authoritative facts collected during one run. These never come from model
 * prose: read tools create them directly from Ordira domain services.
 */
export type CustomerAiRunScopedFact =
  | {
      kind: 'menu_item';
      ref: string;
      name: string;
      description?: string | null;
      priceMinorUnit: number;
      currency: string;
      orderable: boolean;
      restaurantName: string;
      branchName: string;
      pickupEnabled: boolean;
      deliveryEnabled: boolean;
    }
  | {
      kind: 'restaurant';
      ref: string;
      name: string;
      restaurantName: string;
      branchName?: string | null;
      cuisines: string[];
      pickupEnabled: boolean;
      deliveryEnabled: boolean;
      distanceKm?: number;
    };

export type CustomerAiToolExecutionContext = {
  runId: string;
  sequence: number;
  factsByRef: Map<string, CustomerAiRunScopedFact>;
};

export type CustomerAiToolExecutionResult = {
  providerResult: CustomerAiProviderToolResult;
  resultCardinality: number;
  returnedRefs: string[];
};

export type CustomerAiRunConfigSnapshot = {
  mode: CustomerAiMode;
  provider: CustomerAiProviderName;
  model: string | null;
  reasoningEffort: CustomerAiReasoningEffort | null;
  promptVersion: string;
  policyVersion: string;
  toolContractVersion: string;
  responseContractVersion: string;
  maxProviderCalls: number;
  maxToolCalls: number;
  maxOutputTokens: number;
  maxContextMessages: number;
  turnDeadlineMs: number;
};

/** Nest injection token used to select the configured provider at startup. */
export const CUSTOMER_AI_PROVIDER = Symbol('CUSTOMER_AI_PROVIDER');
