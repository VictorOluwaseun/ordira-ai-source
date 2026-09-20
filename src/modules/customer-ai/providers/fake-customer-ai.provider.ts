import { Injectable } from '@nestjs/common';
import type {
  CustomerAiProvider,
  CustomerAiProviderRequest,
  CustomerAiProviderResult,
} from '../customer-ai.types';

/**
 * Deterministic local provider used for wiring tests and zero-cost shadow runs.
 * It exercises the same tool-call -> tool-result -> response-plan loop as a
 * remote model without network access or probabilistic behavior.
 */
@Injectable()
export class FakeCustomerAiProvider implements CustomerAiProvider {
  readonly name = 'fake' as const;

  createTurn(
    request: CustomerAiProviderRequest,
  ): Promise<CustomerAiProviderResult> {
    if (request.priorToolResults.length === 0) {
      return Promise.resolve({
        kind: 'tool_calls',
        toolCalls: [
          {
            callId: 'fake-call-1',
            toolName: 'search_menu_items',
            arguments: {
              q: request.customerMessage,
              limit: 4,
            },
          },
        ],
      });
    }

    const refs = readRefs(request.priorToolResults[0]?.output);
    if (refs.length === 0) {
      return Promise.resolve({
        kind: 'response_plan',
        responsePlan: {
          responseType: 'low_risk_text',
          text: 'I could not find a close menu match. Try another dish or restaurant name.',
        },
      });
    }

    return Promise.resolve({
      kind: 'response_plan',
      responsePlan: {
        responseType: 'menu_recommendation',
        itemRefs: refs.slice(0, 4),
        introduction: 'Here are the closest menu matches:',
      },
    });
  }
}

function readRefs(output?: Record<string, unknown>): string[] {
  if (!output || !Array.isArray(output.results)) {
    return [];
  }

  const refs: string[] = [];
  const results: unknown[] = output.results;
  for (const result of results) {
    if (isRecord(result) && typeof result.ref === 'string') {
      refs.push(result.ref);
    }
  }

  return refs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
