import { Injectable } from '@nestjs/common';
import type { CustomerAiCompiledResponse } from './customer-ai-response-compiler.service';
import type {
  CustomerAiPhase,
  CustomerAiResponsePlan,
  CustomerAiRunScopedFact,
} from './customer-ai.types';
import type { CustomerAiPolicySignals } from './customer-ai-policy.service';

export type CustomerAiPolicyEvidenceInput = {
  customerMessage: string;
  phase: CustomerAiPhase;
  responsePlan: CustomerAiResponsePlan;
  compiled: CustomerAiCompiledResponse;
  factsByRef: ReadonlyMap<string, CustomerAiRunScopedFact>;
  toolErrorCount: number;
  staleVersionConflict: boolean;
};

/**
 * Derives safety signals from data Ordira can verify at runtime.
 *
 * The provider does not submit these booleans. They come from compiler results,
 * server-owned facts, the current phase, tool outcomes, and a narrow set of
 * deterministic intent rules. The rules intentionally recognize only strong
 * evidence; model confidence can neither clear nor override a signal.
 */
@Injectable()
export class CustomerAiPolicyEvidenceService {
  collect(input: CustomerAiPolicyEvidenceInput): CustomerAiPolicySignals {
    const selectedFacts = resolveSelectedFacts(
      input.responsePlan,
      input.factsByRef,
    );

    return {
      schemaValid: input.compiled.status === 'compiled',
      toolErrorCount: input.toolErrorCount,
      ambiguousResultCount: countAmbiguousSelectedFacts(selectedFacts),
      missingRequiredFacts: findMissingRequiredFacts(input, selectedFacts),
      staleVersionConflict: input.staleVersionConflict,
      unavailableSelectedItem: selectedFacts.some(
        (fact) => fact.kind === 'menu_item' && !fact.orderable,
      ),
      scopeMismatch:
        input.compiled.status === 'rejected' &&
        (input.compiled.reasonCode === 'invalid_menu_item_ref' ||
          input.compiled.reasonCode === 'invalid_restaurant_ref'),
      contradictoryConstraints: hasFulfillmentConflict(
        input.customerMessage,
        selectedFacts,
      ),
      supportedIntent: !containsRestrictedIntent(input.customerMessage),
      providerRequestedHandoff: input.responsePlan.responseType === 'handoff',
    };
  }
}

function resolveSelectedFacts(
  plan: CustomerAiResponsePlan,
  factsByRef: ReadonlyMap<string, CustomerAiRunScopedFact>,
): CustomerAiRunScopedFact[] {
  if (plan.responseType === 'menu_recommendation') {
    return plan.itemRefs
      .map((ref) => factsByRef.get(ref))
      .filter(
        (
          fact,
        ): fact is Extract<CustomerAiRunScopedFact, { kind: 'menu_item' }> =>
          fact?.kind === 'menu_item',
      );
  }
  if (plan.responseType === 'restaurant_recommendation') {
    return plan.restaurantRefs
      .map((ref) => factsByRef.get(ref))
      .filter(
        (
          fact,
        ): fact is Extract<CustomerAiRunScopedFact, { kind: 'restaurant' }> =>
          fact?.kind === 'restaurant',
      );
  }

  return [];
}

function countAmbiguousSelectedFacts(facts: CustomerAiRunScopedFact[]): number {
  const counts = new Map<string, number>();
  for (const fact of facts) {
    const key = `${fact.kind}:${normalizeName(fact.name)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.values()].reduce(
    (ambiguous, count) => ambiguous + (count > 1 ? count : 0),
    0,
  );
}

function findMissingRequiredFacts(
  input: CustomerAiPolicyEvidenceInput,
  facts: CustomerAiRunScopedFact[],
): string[] {
  const missing = new Set<string>();
  const message = input.customerMessage.toLowerCase();

  // Current read tools expose no allergen/medical guarantees, checkout totals,
  // or address-specific delivery quotes. Requests for those facts must hand off
  // until an authoritative tool exists.
  if (
    /\b(?:allerg(?:y|ies|en|ens|ic)|peanut|gluten|dairy[- ]free|nut[- ]free)\b/i.test(
      message,
    )
  ) {
    missing.add('allergen_data');
  }
  if (/\b(?:subtotal|total)\b/i.test(message)) {
    missing.add('checkout_total');
  }
  if (/\b(?:delivery fee|delivery charge)\b/i.test(message)) {
    missing.add('delivery_fee');
  }
  if (/\bdeliver(?:y|ed)?\b.*\b(?:my address|to me|here)\b/i.test(message)) {
    missing.add('delivery_eligibility');
  }
  if (
    input.phase === 'selection' &&
    facts.some((fact) => fact.kind === 'restaurant' && !fact.branchName)
  ) {
    missing.add('selected_branch');
  }

  return [...missing].sort();
}

function hasFulfillmentConflict(
  customerMessage: string,
  facts: CustomerAiRunScopedFact[],
): boolean {
  const requestsDelivery = /\bdeliver(?:y|ed)?\b/i.test(customerMessage);
  const requestsPickup = /\b(?:pickup|pick-up|pick up|collect)\b/i.test(
    customerMessage,
  );

  return facts.some(
    (fact) =>
      (requestsDelivery && !fact.deliveryEnabled) ||
      (requestsPickup && !fact.pickupEnabled),
  );
}

function containsRestrictedIntent(customerMessage: string): boolean {
  return /\b(?:refund|chargeback|payment status|order status|track (?:my |the )?order|cancel(?: (?:my |the )?order)?|confirm (?:my |the )?order|place (?:my |the )?order|submit (?:my |the )?order)\b/i.test(
    customerMessage,
  );
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase('en-NG').replace(/\s+/g, ' ');
}
