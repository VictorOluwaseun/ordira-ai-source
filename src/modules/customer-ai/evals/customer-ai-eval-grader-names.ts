/**
 * Version-controlled grader vocabulary accepted by the customer-AI corpus.
 *
 * Keeping the names in one closed registry prevents a misspelled JSONL grader
 * from silently becoming an ungraded requirement. The executable grader map
 * imports this list and the fixture loader checks it before any paid provider
 * request can begin.
 */
export const CUSTOMER_AI_EVAL_GRADER_NAMES = [
  'allergen_unknown',
  'ambiguity',
  'availability_authority',
  'availability_guard',
  'budget',
  'cancellation_precedence',
  'causal_ordering',
  'causal_send_guard',
  'checkout_scope',
  'circuit_breaker',
  'code_switching',
  'commit_forbidden',
  'compiler_facts',
  'compiler_intro_safety',
  'confirmation_guard',
  'confirmation_precedence',
  'contradictory_constraints',
  'currency_authority',
  'daily_spend_guard',
  'delivery_fee_authority',
  'deterministic_commit',
  'deterministic_fallback',
  'emoji_understanding',
  'empty_results',
  'encoded_prompt_injection',
  'fencing',
  'fragment_understanding',
  'fresh_confirmation',
  'fresh_fact_lookup',
  'fulfillment',
  'fulfillment_authority',
  'ignore_customer_price',
  'instruction_hierarchy',
  'intent',
  'invalid_option',
  'language_understanding',
  'lease_takeover',
  'location',
  'location_arguments',
  'location_bounds',
  'missing_allergen_data',
  'missing_location',
  'modifier_constraint',
  'money_traceability',
  'monthly_spend_guard',
  'mutation_idempotency',
  'network_scope',
  'no_commit',
  'no_guarantee',
  'no_invention',
  'no_mutation',
  'no_shadow_write',
  'normalization',
  'objective_handoff',
  'obsolete_write_rejected',
  'opaque_ref_validation',
  'optimistic_concurrency',
  'order_scope',
  'order_state_authority',
  'output_limit',
  'payment_state_authority',
  'private_data_protection',
  'prompt_injection',
  'provider_unavailable',
  'quantity_ambiguity',
  'rate_limit',
  'refusal_handling',
  'reload_required',
  'response_plan',
  'role_boundary',
  'routing',
  'routing_precedence',
  'run_idempotency',
  'safe_ambiguity',
  'safety_sensitive',
  'schema_validation',
  'secret_protection',
  'side_effect_class',
  'single_effect',
  'spend_guard_fail_closed',
  'stale_reply_suppression',
  'state_traceability',
  'strict_tool_schema',
  'tenant_scope',
  'timeout',
  'tool_allowlist',
  'tool_arguments',
  'tool_error',
  'tool_scope',
  'tool_timeout',
  'total_authority',
  'typo_tolerance',
  'unsupported_discount',
  'unsupported_intent',
  'untrusted_customer_data',
  'untrusted_tool_output',
  'version_conflict',
  'zero_ai_tools',
  'zero_provider_calls',
] as const;

export type CustomerAiEvalGraderName =
  (typeof CUSTOMER_AI_EVAL_GRADER_NAMES)[number];

const CUSTOMER_AI_EVAL_GRADER_NAME_SET = new Set<string>(
  CUSTOMER_AI_EVAL_GRADER_NAMES,
);

/** Fail the corpus before execution when any grader has no implementation. */
export function assertCustomerAiEvalGradersRegistered(
  fixtures: ReadonlyArray<{ id: string; graders: readonly string[] }>,
): void {
  for (const fixture of fixtures) {
    for (const grader of fixture.graders) {
      if (!CUSTOMER_AI_EVAL_GRADER_NAME_SET.has(grader)) {
        throw new Error(
          `Unknown customer AI eval grader "${grader}" in fixture ${fixture.id}`,
        );
      }
    }
  }
}
