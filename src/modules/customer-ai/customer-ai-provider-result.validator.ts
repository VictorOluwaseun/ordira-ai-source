import type {
  CustomerAiProviderResult,
  CustomerAiResponsePlan,
  CustomerAiToolCall,
} from './customer-ai.types';

/**
 * Runtime validation at the provider boundary.
 *
 * TypeScript types disappear at runtime, and provider SDK structured output is
 * not treated as trusted input. This validator rejects unknown properties,
 * unbounded strings, duplicate refs, unsupported tools, and malformed usage
 * before orchestration or domain services see the result.
 */
export function validateCustomerAiProviderResult(
  value: unknown,
): CustomerAiProviderResult {
  if (!isRecord(value)) {
    throw new Error('CUSTOMER_AI_PROVIDER_SCHEMA_INVALID');
  }
  if (value.kind === 'tool_calls' && Array.isArray(value.toolCalls)) {
    assertNoExtraProperties(value, ['kind', 'toolCalls', 'usage']);
    const toolCalls = value.toolCalls.map(validateToolCall);
    if (toolCalls.length === 0) {
      throw new Error('CUSTOMER_AI_PROVIDER_SCHEMA_INVALID');
    }

    return { kind: 'tool_calls', toolCalls, usage: validateUsage(value.usage) };
  }
  if (value.kind === 'response_plan') {
    assertNoExtraProperties(value, ['kind', 'responsePlan', 'usage']);
    return {
      kind: 'response_plan',
      responsePlan: validateResponsePlan(value.responsePlan),
      usage: validateUsage(value.usage),
    };
  }

  throw new Error('CUSTOMER_AI_PROVIDER_SCHEMA_INVALID');
}

function validateToolCall(value: unknown): CustomerAiToolCall {
  if (
    !isRecord(value) ||
    !boundedString(value.callId, 1, 120) ||
    (value.toolName !== 'search_restaurants' &&
      value.toolName !== 'search_menu_items') ||
    !isRecord(value.arguments)
  ) {
    throw new Error('CUSTOMER_AI_PROVIDER_SCHEMA_INVALID');
  }
  assertNoExtraProperties(value, ['callId', 'toolName', 'arguments']);

  return {
    callId: value.callId,
    toolName: value.toolName,
    arguments: value.arguments,
  };
}

function validateResponsePlan(value: unknown): CustomerAiResponsePlan {
  if (!isRecord(value)) {
    throw new Error('CUSTOMER_AI_PROVIDER_SCHEMA_INVALID');
  }
  if (value.responseType === 'low_risk_text') {
    assertNoExtraProperties(value, ['responseType', 'text']);
    if (!boundedString(value.text, 1, 600)) {
      throw new Error('CUSTOMER_AI_PROVIDER_SCHEMA_INVALID');
    }

    return { responseType: 'low_risk_text', text: value.text };
  }
  if (value.responseType === 'handoff') {
    assertNoExtraProperties(value, ['responseType', 'reasonCode']);
    if (!boundedString(value.reasonCode, 1, 120)) {
      throw new Error('CUSTOMER_AI_PROVIDER_SCHEMA_INVALID');
    }

    return { responseType: 'handoff', reasonCode: value.reasonCode };
  }
  if (value.responseType === 'menu_recommendation') {
    assertNoExtraProperties(value, [
      'responseType',
      'itemRefs',
      'introduction',
    ]);
    return {
      responseType: 'menu_recommendation',
      itemRefs: validateRefs(value.itemRefs),
      introduction: validateIntroduction(value.introduction),
    };
  }
  if (value.responseType === 'restaurant_recommendation') {
    assertNoExtraProperties(value, [
      'responseType',
      'restaurantRefs',
      'introduction',
    ]);
    return {
      responseType: 'restaurant_recommendation',
      restaurantRefs: validateRefs(value.restaurantRefs),
      introduction: validateIntroduction(value.introduction),
    };
  }

  throw new Error('CUSTOMER_AI_PROVIDER_SCHEMA_INVALID');
}

function validateRefs(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 4 ||
    value.some((ref) => !boundedString(ref, 1, 80))
  ) {
    throw new Error('CUSTOMER_AI_PROVIDER_SCHEMA_INVALID');
  }
  const refs = value as string[];
  // Duplicate refs would produce repeated recommendations and misleading fact
  // counts, so they are rejected rather than silently deduplicated.
  if (new Set(refs).size !== refs.length) {
    throw new Error('CUSTOMER_AI_PROVIDER_SCHEMA_INVALID');
  }

  return refs;
}

function validateIntroduction(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!boundedString(value, 1, 160)) {
    throw new Error('CUSTOMER_AI_PROVIDER_SCHEMA_INVALID');
  }

  return value;
}

function validateUsage(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('CUSTOMER_AI_PROVIDER_SCHEMA_INVALID');
  }
  assertNoExtraProperties(value, [
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'totalTokens',
    'estimatedCostMinorUnit',
  ]);
  const result: Record<string, number> = {};
  // Usage is telemetry and billing data: accept only non-negative integers and
  // never coerce strings supplied by an adapter.
  for (const key of [
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'totalTokens',
    'estimatedCostMinorUnit',
  ]) {
    const item = value[key];
    if (item === undefined) {
      continue;
    }
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0) {
      throw new Error('CUSTOMER_AI_PROVIDER_SCHEMA_INVALID');
    }
    result[key] = item;
  }

  return result;
}

function boundedString(
  value: unknown,
  minLength: number,
  maxLength: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length >= minLength &&
    value.length <= maxLength
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertNoExtraProperties(
  value: Record<string, unknown>,
  allowedProperties: string[],
): void {
  // Exact shapes keep contract evolution explicit and prevent ignored fields
  // from acquiring accidental meaning later.
  const allowed = new Set(allowedProperties);
  if (Object.keys(value).some((property) => !allowed.has(property))) {
    throw new Error('CUSTOMER_AI_PROVIDER_SCHEMA_INVALID');
  }
}
