# WhatsApp Standard Shared Flow Acceptance

This checklist gates the Ordira Standard shared WhatsApp experience. Premium
dedicated-channel work must not begin until the Standard shared-channel pass is
green for automated coverage, real Meta Cloud transport, recovery, and privacy.

## Scope

Standard uses the Ordira shared Meta Cloud channel to let customers discover a
restaurant, open the scoped storefront, return to WhatsApp, confirm checkout,
and access order support without a restaurant-owned WhatsApp number.

Premium dedicated channels, restaurant-managed inboxes, and custom tenant
WhatsApp automations are out of scope for this pass.

## Customer Copy Rules

- Customer-facing defaults live in the WhatsApp Standard flow copy registry.
- Emojis are allowed only in message text and display labels.
- Action IDs, enum values, database keys, BullMQ job ids, and routing logic must
  remain text-only stable identifiers.
- Use one descriptive emoji per action or status in normal cases.
- Keep button and list labels short enough for Meta Cloud constraints.
- Platform experience metadata may override display labels later, but must not
  change backend action IDs.
- Keep a text-only fallback available for providers or contexts that cannot
  render emoji labels.

## Automated Acceptance Flow

Run this as an infra-backed e2e flow through the Nest HTTP server, MongoDB,
Redis, BullMQ worker, and signed Meta Cloud webhook handling.

1. Signed inbound `hello` webhook is accepted.
2. Platform customer identity is created or resolved.
3. Shared-platform conversation is created.
4. Home menu is queued with stable action IDs and customer-facing emoji labels.
5. `Place order` action is selected.
6. Location or text search is processed.
7. Restaurant and branch are selected.
8. Tenant context is stored on the conversation.
9. Empty internal checkout session is created.
10. Scoped storefront URL is queued.
11. Storefront restores the same checkout session.
12. Modifiers and basket updates write to the same checkout session.
13. Customer returns to WhatsApp.
14. Fulfillment is selected.
15. Delivery address is captured when delivery is required.
16. Confirmation creates exactly one order.
17. Order appears in `My orders`.
18. Status tracking works.
19. Payment link works when online payment is enabled.
20. Payment confirmation works.
21. Receipt access works.
22. Email verification works.
23. Notification preferences work.
24. Help/support path works.

## Current Backend Automation Coverage

The unit-level backend suite currently locks:

- Shared inbound greetings route to the Standard flow.
- Tenant-context `HOME` messages route back to Standard instead of checkout
  help.
- Home, order discovery, branch list, branch selection, tenant context storage,
  empty WhatsApp draft checkout-session creation, and scoped storefront CTA.
- Checkout-flow fulfillment, delivery address capture, confirmation,
  idempotent conversion replay, and blocked confirmation when branch/menu
  availability changes.
- `My orders` lists only orders for the current verified WhatsApp phone, scoped
  to the current restaurant once tenant context exists.
- Order status/payment/receipt actions use one-time order-access magic links
  and do not put phone numbers in URLs.
- Account help and notification preference actions use stable backend action
  IDs with customer-facing labels only.

The remaining launch gate work is infra-backed, not satisfied by unit tests
alone:

- Full HTTP e2e from signed Meta webhook through storefront restore, modifier
  basket update, return-to-WhatsApp confirmation, and order creation.
- Real Meta Cloud smoke with API, worker, Redis, MongoDB, public callback, and
  a real test recipient.
- Platform-customer email verification with a real verification token/OTP loop.
- Payment provider callback confirmation in the same end-to-end Standard flow.
- Recovery drills for Redis/worker/provider failures and rapid customer input.

## Real Meta Cloud Smoke

Run this before production launch with real infrastructure:

1. Start the API process.
2. Start the worker process.
3. Use the same MongoDB and Redis instances for API and worker.
4. Expose the public webhook through ngrok or the staging ingress.
5. Configure a verified shared Meta channel with provider phone-number id and
   WhatsApp Business Account id.
6. Configure `WHATSAPP_CLOUD_API_ACCESS_TOKEN`, `WHATSAPP_CLOUD_API_VERSION`,
   `META_APP_SECRET`, and `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
7. Set Meta webhook subscription to the public callback URL.
8. Send `hello` from a real test recipient phone.
9. Complete the full automated acceptance flow from the recipient phone.
10. Record the API logs, worker logs, order id, payment id when used, and final
    receipt URL in the launch checklist.

## Recovery And Edge Cases

Exercise these before accepting the Standard flow:

- Duplicate webhook delivery.
- Rapid consecutive customer replies.
- Stale button or list action.
- Expired checkout session.
- Customer closes and reopens storefront.
- Item price changes before confirmation.
- Modifier becomes unavailable before confirmation.
- Branch closes or pauses during checkout.
- Delivery location falls outside the delivery zone.
- WhatsApp outbound queue is temporarily unavailable.
- Redis restarts while messages are queued.
- Worker restarts while messages are queued or sending.
- Meta Cloud returns 429 or 5xx and retry is scheduled.
- Customer-service window expires.
- Payment fails.
- Customer sends `HOME` midway.
- Customer attempts to change restaurant with a populated basket.
- Two customers order concurrently.
- Same customer sends messages rapidly.

## Privacy Checks

- Shared conversations are not visible to restaurant dashboards before tenant
  context is assigned.
- One restaurant cannot see another restaurant's customer history.
- `My orders` returns only orders owned by the current platform identity.
- Customer messages never include provider IDs, access tokens, raw webhook
  payloads, secrets, or internal database identifiers.
- Flow analytics omit message text and unnecessary PII.
- Logs and audit events keep phone numbers, emails, tokens, OTPs, and provider
  secrets redacted.

## Repeatable Validation Commands

```bash
npm run lint:check
npm run build
npm test -- --runInBand
npm run test:e2e:infra
git diff --check
```

Record each run with:

- Environment name.
- Git commit or branch.
- API process command.
- Worker process command.
- MongoDB and Redis targets.
- Meta callback URL.
- Shared channel id.
- Test recipient phone alias.
- Pass/fail notes for every checklist section.
