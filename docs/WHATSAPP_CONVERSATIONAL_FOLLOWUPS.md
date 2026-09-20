# WhatsApp conversational follow-ups

Implemented September 2026. The rules recognise bounded phrases first; the AI
interpreter can route unfamiliar hunger, cheaper-option, ETA, payment-status,
support and reorder requests into the same checked handlers. It never supplies
an order ID or authorises a financial or order-state transition.

## Supported interactions

| Customer request | Behaviour |
| --- | --- |
| “I'm hungry” | Ask for a craving or nearby restaurants. |
| “₦5,000 for two people” | Clarify total versus per-person budget before searching. Serving sizes remain a customer choice. |
| “Rice delivered to Lekki” | Retain food and area, then request a precise location. An area name does not prove delivery coverage. |
| “Do they have chicken?” | Search the selected branch's current menu, or ask for a restaurant first. |
| “Something cheaper” | Retain the current restaurant and food query, with a lower total cap. |
| “No chicken, fish instead” | Refine discovery; basket/order changes are routed to review or restaurant assistance. |
| “The second one” | Resolve the displayed suggestion; ambiguous references show meal buttons or a selection list. Typing a number still works. |
| “Not spicy” | Ask which meal if necessary, look for current matching modifier options, and link to the menu. Nothing is automatically applied. |
| “I'm allergic to peanuts” | Explain that ingredients and cross-contact require restaurant confirmation. Never infer safety from dish names. |
| “I paid already” | Read the owned checkout/payment or selected order records. Never create another payment request or treat the statement as payment proof. |
| “Where is my food?” / “How long will it take?” | Read an owned order; ask which one when several exist. Saved estimates are identified as estimates, not live countdowns. |
| “Same as last time” | Offer review, then create a separate draft using current item/modifier prices and availability. Never copy payment or change the historical order. |
| “Change my order” | Open a draft for editing, explain restaurant approval for active orders, or offer a new draft for ended orders. |
| “Someone should help me” | Mark the conversation for staff review and retain request context without promising a response time. |

## Questions with definite answers

The backend builds interactive questions from known answers. Up to three choices
use reply buttons; four to ten use a selection list. The shared question renderer
is `whatsapp-question.util.ts`. Group-budget questions use it, as do meal-reference
and preference clarifications. Existing restaurant/order lists, pickup/delivery
buttons, location requests and direct menu/payment/receipt URL buttons continue
to use their respective interactive formats. Open-ended questions still accept text.

Meal questions include actual discovery labels with numbered choices. Customers
can tap a choice or type its number (1–10, including ordinals). Each generated
meal question has a conversation-local ID, expires within 15 minutes and no later
than its discovery snapshot, and is checked again on selection. Replaced or stale
questions cannot select the same index from a newer meal list. Selection resumes
the pending preference question or opens a direct menu button; it does not place
an order or apply a modifier. URLs come from existing backend flows, not AI output.

## State and ownership

English, Nigerian Pidgin and common spelling variants are supported through
whole-phrase rules plus the bounded GPT-5.4 interpreter. Examples include “abeg
where my food dey”, “I wan talk to person”, and “can they delivr to Lekki?”.
Less familiar wording uses the model; rules still run first. The classifier sees
fresh restaurant/meal labels, a budget, the selected suggestion and the pending
question, without customer contact data, internal IDs or access links.

Delivery enquiries retain the selected branch, ask for a precise WhatsApp pin,
then use public branch availability and delivery-zone rules. A place name alone
does not establish coverage. Minimum orders and delivery fees are disclosed
where available; checkout still rechecks them. Missing restaurant context asks
for a restaurant first.

Numbered meal references and short acceptance are resolved against the current
suggestions; multiple choices need clarification. Explicit pickup/delivery
corrections, including “I go collect am” and “no, delivery instead”, work before
submission and still require checkout confirmation. A new delivery choice
clears the old address. Search substitutions preserve restaurant/budget context;
submitted-order changes still require the separate approval workflow.

Suggestions expire within 30 minutes and no later than their checkout session.
Clarification and reorder actions expire after 15 minutes. Refinements only use
discovery context while the conversation remains in the menu-handoff state.
Home clears the saved suggestions and pending actions. Email and delivery-address
entry remain outside general phrase parsing, so field values are not
reinterpreted as commands. An explicit full request for a person can interrupt
data entry. Normal input routing and customer-service-window checks still apply.

Order reads use the conversation's customer phone and tenant scope. Checkout
payment reads independently check both. An explicit selected order takes
precedence; otherwise a current checkout is checked before historical orders.
Reorders recheck ownership when the button is pressed and reprice the copied
selection. Unavailable items produce an explanation rather than silent swaps.

## Boundaries

Submitted-order amendment proposals, restaurant approval screens, payment
adjustments and refunds are not implemented by these handlers. See
[the amendment design](WHATSAPP_ORDER_MODIFICATIONS.md). Draft edits happen in
the storefront. Preferences are not sent to the kitchen automatically. A staff
review flag does not itself send an external notification or guarantee an agent.

Unit coverage includes ambiguous/expired context, cross-customer access,
payment reads without writes, repricing failures, modifier clarification and
multi-order choice. An isolated real-catalog run also checked meal references,
cheaper options, preferences, unavailable budgets and delivery constraints;
outbound messages and checkout writes were captured in memory for that run.
