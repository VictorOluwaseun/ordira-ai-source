# WhatsApp intent interpreter

Known commands, buttons, checkout codes, and collected address/email/restaurant-name input use the existing handlers. Other text in navigation, discovery, and order-viewing states can make one GPT-5.4 classification call.

The classifier returns an allowlisted intent and optional restaurant name/city or displayed-option index. It never produces the WhatsApp message itself. Existing handlers recheck customer ownership, query current data, create access links, and render their usual messages. Confirmation, cancellation, refunds, charging, and order edits are not classifier actions. A selected branch can open the existing draft-menu flow; it cannot submit an order.

Provider failures, refusals, invalid schemas, unsupported actions, ambiguous requests, and exhausted budgets lead to the existing clarification buttons. Responses are discarded if another inbound message or state transition superseded the conversation while classification ran. Accepted live interpretations do not also run the ordinary unknown-message response or shadow inference.

## Configuration

Set these in `.env`, then restart the server/WhatsApp inbound worker:

```dotenv
CUSTOMER_AI_INTERPRETER_ENABLED=true
CUSTOMER_AI_PROVIDER=openai
CUSTOMER_AI_MODEL=gpt-5.4
CUSTOMER_AI_REASONING_EFFORT=none
OPENAI_API_KEY=<configured server credential>
CUSTOMER_AI_DAILY_SPEND_LIMIT_MINOR_UNIT=1500
CUSTOMER_AI_MONTHLY_SPEND_LIMIT_MINOR_UNIT=5000
CUSTOMER_AI_OPENAI_INPUT_COST_PER_MILLION_MINOR_UNIT=250
CUSTOMER_AI_OPENAI_OUTPUT_COST_PER_MILLION_MINOR_UNIT=1500
```

These example limits are $15/day and $50/month, measured in USD cents. Adjust them independently in `.env`. Positive limits, credentials, a model, and token-cost rates are required before enabling. Zero never means unlimited. Set `CUSTOMER_AI_INTERPRETER_ENABLED=false` to disable paid live interpretation. This flag is independent of `CUSTOMER_AI_MODE`, whose existing shadow pipeline remains unchanged.

The rates above reflect GPT-5.4 standard input/output pricing of $2.50/$15 per million tokens in the [official model documentation](https://developers.openai.com/api/docs/models/gpt-5.4). Update rates if model/provider pricing changes. The existing Redis spend guard shares daily/monthly counters across workers and the shadow provider, reserves conservatively before each call, and reconciles reported token usage afterward. Indeterminate network failures retain their reservation because billing is unknown. Cached-input discounts are conservatively ignored.

`CUSTOMER_AI_API_TIMEOUT_MS`, `CUSTOMER_AI_TURN_DEADLINE_MS`, and `CUSTOMER_AI_MAX_OUTPUT_TOKENS` bound the provider request. The existing provider circuit breaker also applies, with a separate interpreter health key. SDK retries are disabled. Inputs are limited to 1,000 characters and ten displayed choices; the model receives no internal order IDs, phone numbers from records, receipt tokens, payment amounts, or unbounded chat history. Customer-written text can still contain personal information.

Structured output follows the [OpenAI structured-output contract](https://developers.openai.com/api/docs/guides/structured-outputs), with an additional backend validator. Local tests mock the provider and cover bypass behavior, option scoping, forbidden actions, stale responses, configuration, spend failures, and single-response dispatch. They do not establish real-model accuracy or WhatsApp delivery; verify those with a development conversation after restart.
