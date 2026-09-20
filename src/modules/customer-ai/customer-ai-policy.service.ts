import { Injectable } from '@nestjs/common';

export type CustomerAiPolicySignals = {
  schemaValid: boolean;
  toolErrorCount: number;
  ambiguousResultCount: number;
  missingRequiredFacts: string[];
  staleVersionConflict: boolean;
  unavailableSelectedItem: boolean;
  scopeMismatch: boolean;
  contradictoryConstraints: boolean;
  supportedIntent: boolean;
  providerRequestedHandoff: boolean;
};

export type CustomerAiPolicyDecision =
  | { action: 'continue' }
  | { action: 'handoff'; reasonCode: string };

/**
 * Converts objective runtime signals into a deterministic safety decision.
 *
 * Model-reported confidence is intentionally absent: handoff is driven by
 * facts Ordira can verify, such as schema validity, tool failures, stale state,
 * and missing domain data. Checks are ordered so the first reason is stable and
 * useful in metrics and evaluations.
 */
@Injectable()
export class CustomerAiPolicyService {
  decide(signals: CustomerAiPolicySignals): CustomerAiPolicyDecision {
    if (signals.staleVersionConflict) {
      return { action: 'handoff', reasonCode: 'stale_version_conflict' };
    }
    if (signals.scopeMismatch) {
      return { action: 'handoff', reasonCode: 'scope_mismatch' };
    }
    if (!signals.schemaValid) {
      return { action: 'handoff', reasonCode: 'response_schema_invalid' };
    }
    if (signals.contradictoryConstraints) {
      return { action: 'handoff', reasonCode: 'contradictory_constraints' };
    }
    if (!signals.supportedIntent) {
      return { action: 'handoff', reasonCode: 'unsupported_intent' };
    }
    if (signals.unavailableSelectedItem) {
      return { action: 'handoff', reasonCode: 'selected_item_unavailable' };
    }
    if (signals.missingRequiredFacts.length > 0) {
      return { action: 'handoff', reasonCode: 'required_fact_missing' };
    }
    if (signals.toolErrorCount > 0) {
      return { action: 'handoff', reasonCode: 'tool_error' };
    }
    if (signals.ambiguousResultCount > 0) {
      return { action: 'handoff', reasonCode: 'ambiguous_results' };
    }
    if (signals.providerRequestedHandoff) {
      return { action: 'handoff', reasonCode: 'provider_requested_handoff' };
    }

    return { action: 'continue' };
  }
}
