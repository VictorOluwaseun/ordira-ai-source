# WhatsApp order modifications

Implementation design for the agreed customer flow. This document describes
proposed behavior; submitted-order amendments are not implemented yet.

## Customer interaction

An utterance such as “I want to modify the order above to…” refers to the order
currently selected in the conversation. Resolve that reference using the saved
selection and recheck ownership against the customer's WhatsApp identity. With
no selected order, ask the customer to select one; never guess from global order
history or let the interpreter supply an arbitrary order ID.

The interpreter may propose changes, but cannot save an amended order, mark a
payment successful, charge a card, or issue a refund. Item names must resolve to
the selected branch's menu. Ambiguous items, variants, modifier quantities, or
conflicting instructions require clarification.

Show the proposed item changes, old and new totals, and any amount due or refund
before customer confirmation. Confirmation refers to a specific saved proposal
version, not a generic “yes” interpreted outside that step.

## Eligibility

| Current order | Proposed behavior |
| --- | --- |
| Completed, cancelled, rejected | Explain that this order cannot change; offer a separate new order, My orders, and Home. |
| Submitted and unpaid | Preview changes and request customer confirmation before applying an eligible amendment. |
| Submitted and paid | Require restaurant approval as well as customer confirmation, even before the restaurant accepts the order and even when the total is unchanged. |
| Accepted | Require restaurant approval as well as customer confirmation. |
| Preparing, ready, out for delivery | Do not apply automatic item edits; direct the customer to the restaurant. |

For a completed order, clarify whether the customer wants to order it again with
the requested changes. Offer Order again, My orders, and Home. Only after the
customer chooses to reorder should a separate draft be created. The previous
order's paid status does not make this an amendment requiring approval; the new
order follows the restaurant's normal payment and acceptance settings.

Starting a new order must preserve the historical order. Revalidate copied menu
items, modifiers, current prices, branch availability, and timing. Do not copy
old payment status or reuse a completed checkout session. Review the new basket
before the normal submission/payment flow.

## Amendment lifecycle

1. Store a proposal linked to the owned order and its current revision. Include
   requested changes, a freshly validated quote, expiry, and the original total.
2. Ask the customer to review and confirm that proposal. Declining or expiry
   leaves the original order untouched.
3. For a paid active order or an accepted order, expose the proposal in the
   restaurant console for approval or rejection before applying changes or
   initiating a payment adjustment. This includes paid orders still awaiting
   acceptance. A customer must not be told that changes were accepted merely
   because a request was created.
4. Handle a positive price difference through an amendment-specific payment
   request. A negative difference needs an explicit refund workflow. Neither
   result can be inferred from the customer's text or a payment redirect.
5. Apply only a still-valid, approved and financially settled proposal. Recheck
   the order state, proposal revision, menu availability, inventory, and payment
   records at the transition. Prevent preparation from racing a pending change.
6. Publish the updated order, invalidate order/receipt caches, and notify the
   customer and restaurant after the durable transition succeeds.

The exact reservation and expiry rules for an amendment awaiting payment or a
refund must be defined with that financial workflow. Do not hold a database
transaction open across a network payment call. Repeated confirmations,
approvals, callbacks, and queue retries must produce one application of a
proposal, one inventory adjustment, and one financial adjustment.

## Existing components and missing capabilities

- `whatsapp-standard-flow.service.ts` already resolves selected orders and checks
  customer ownership. The new interaction can use those checks.
- `customer-ai-intent.service.ts` currently excludes edit actions. Add a bounded
  proposal contract and validation before expanding its capabilities.
- `OrdersService.quoteCheckoutSessionOrder` provides pricing and availability
  checks, but is designed for new submissions. Amendments need to account for
  the original order's existing inventory reservations and delivery terms.
- `orders.controller.ts` exposes status and cancellation updates, with no item
  amendment or restaurant amendment-approval endpoint.
- `PaymentsService.refundPayment` supports full manual-payment refunds. It does
  not implement partial Paystack refunds. Do not mark a Paystack refund complete
  through this manual transition.
- The vendor console needs proposal review, price differences, approval/rejection,
  and payment/refund progress before accepted-order amendments can ship.

## Verification required

Exercise ownership isolation, missing/ambiguous references, unavailable items,
modifier quantity behavior, changed pricing, expired previews, duplicate
confirmations, and order-state races. Test unpaid, same-price paid, extra-payment,
and partial-refund cases, including provider failure and replayed callbacks.
Verify a paid submitted order requires approval even for a same-price change,
and a completed-order reorder creates a separate unpaid draft without modifying
the original order or copying its payment status.
Verify inventory and cache changes occur exactly once. A live test must use an
explicitly approved test recipient and must not charge/refund a real customer
merely to demonstrate the conversation flow.
