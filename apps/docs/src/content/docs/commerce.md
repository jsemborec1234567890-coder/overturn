---
title: "Commerce pack: refunds as regression tests"
description: A refund is a receipt for something that went wrong. Capture it from Stripe, Rye or Zinc, attribute it, replay the decision, and block the release that would repeat it.
---

A buying agent's mistakes have a receipt. When someone refunds an order, disputes a charge or
cancels a cart, the money says what the mistake was worth. The commerce pack turns those events
into the same correction records a Zendesk edit makes, so they replay, gate a release and show up
on the scorecard with nothing commerce-specific downstream.

Four pieces: **capture** the event, **attribute** it, **replay** the decision, **gate** the
release.

## What a refund is and is not

Most refunds are not agent errors. People change their minds, boxes arrive damaged, cards get
declined, parcels go missing. A webhook has no human on it, so it cannot tell you which kind this
one is, and a provider's reason code is an accounting category rather than a verdict:
`requested_by_customer` covers every changed mind *and* every wrong purchase.

So the pack never guesses. A captured refund arrives with the reason `unattributed`, and its case
is **archived**: kept with the money on it, shown on the scorecard as pending, and left out of the
suite, the gate and any export. It becomes a regression test when a person says the agent was at
fault and writes the line that says why — the same thing a Zendesk reviewer does, with a different
trigger. Until then it is a record of money, not evidence.

That keeps commerce records the same class of object as claims records. A correction in this
corpus always has a human behind it.

## 1. Record the purchase

The pack needs what the agent saw. Record the decision with the snapshot, and put the ids it
returns on the payment so the refund can find its way back:

```ts
import { Overturn } from "@overturn-ai/sdk";
const ov = new Overturn({ apiKey: process.env.OVERTURN_API_KEY });

const { runId, metadata } = await ov.recordPurchase({
  externalId: order.id,
  agent: "purchasing-agent",
  snapshot: {
    instruction: "Reorder the blue mugs, nothing over $30 each",
    cart: [{ sku: "MUG-B", title: "Blue mug", quantity: 2, unitPriceCents: 1200 }],
    catalogue,                       // what the agent could choose from
    budgetCents: 5000,
  },
  decision: { action: "buy", items: [{ sku: "MUG-R", quantity: 2 }] },
  model: "openai/gpt-4.1-mini",
  agentVersion: "buyer-2.1",
});

await stripe.paymentIntents.create({ ...params, metadata }); // overturn_run_id, overturn_external_id
```

`metadata` is three strings. Stripe, Rye and Zinc all hand metadata back on their events, which is
how a refund two weeks later finds the run. Without it the pack falls back to matching the payment
intent or order id against the run's `externalId`.

If your agent already records its runs with the SDK you do not need `recordPurchase` — any run
with a model step and a matching `externalId` works. What the pack will never do is invent a run:
an event with nothing recorded behind it is answered `200` and counted as unmatched, because a
case with no snapshot is a case that cannot be replayed.

## 2. Point the provider at the webhook

One endpoint per provider, per project:

```
POST https://api.overturn.run/v1/commerce/webhooks/stripe/<project-id>
POST https://api.overturn.run/v1/commerce/webhooks/rye/<project-id>
POST https://api.overturn.run/v1/commerce/webhooks/zinc/<project-id>
```

These are the only endpoints in the API with no API key: a refund arrives from Stripe with no
credentials of yours on it. The signing secret is what authorises the call, so set it first in
**Settings → Commerce**, or:

```bash
curl -X PATCH https://api.overturn.run/v1/project \
  -H "authorization: Bearer $OVERTURN_API_KEY" -H "content-type: application/json" \
  -d '{"settings":{"commerce":{"stripeWebhookSecret":"whsec_…"}}}'
```

A read of your settings returns `__set__` in place of a secret, never the secret itself. Writing
`__set__` back leaves it alone; writing `""` clears it.

| Provider | Header | Signature |
|---|---|---|
| Stripe | `Stripe-Signature` | `t=…,v1=…`, HMAC-SHA256 of `<t>.<body>`, 5-minute tolerance |
| Rye | `X-Rye-Signature` | HMAC-SHA256 of the raw body, hex or base64 |
| Zinc | `X-Zinc-Signature` | HMAC-SHA256 of the raw body, hex or base64 |

Stripe's scheme is checked exactly, replay window included. **Confirm the Rye and Zinc header
names against their current docs before you point a live endpoint at one.** Both sign the raw body
with a shared secret, but the header and the encoding have moved between their API versions, and a
check against the wrong header fails closed with a 401 — safe, but silent.

Events the pack acts on: `charge.refunded`, `refund.created`, `refund.updated`,
`charge.dispute.created` and `payment_intent.canceled` from Stripe; any order body from Rye or Zinc
whose status reads as cancelled, refunded, failed, rejected or returned. Everything else gets a
`200` and is ignored, so the provider stops retrying. A retry of an event already handled is
ignored by event id.

### Saying what should have happened

By default a refund means *should not have bought*, and the case passes when the agent declines.
When you know the right answer, say so in the payment metadata and the case expects that instead:

```ts
metadata: {
  ...metadata,
  overturn_corrected_sku: "MUG-B",        // or overturn_corrected: JSON of a decision
  overturn_corrected_quantity: "2",
  overturn_reason_code: "wrong_variant",  // else mapped from the provider's own reason
}
```

Reason codes: `wrong_item`, `wrong_variant`, `wrong_quantity`, `overpaid`, `duplicate_order`,
`should_not_have_bought`, `out_of_policy`, `not_authorised`, `fraudulent`, `late_or_undeliverable`.

## 3. Attribute it

```bash
curl -X PATCH https://api.overturn.run/v1/corrections/<id>/attribution \
  -H "authorization: Bearer $OVERTURN_API_KEY" -H "content-type: application/json" \
  -d '{"reasonCode":"wrong_variant","note":"ordered the red one; the thread asked for blue"}'
```

The reason code comes from the commerce pack: `wrong_item`, `wrong_variant`, `wrong_quantity`,
`overpaid`, `duplicate_order`, `should_not_have_bought`, `out_of_policy`, `not_authorised` — those
move the case into the suite — or `fraudulent` and `late_or_undeliverable`, which are real reasons
the money went back that the agent could not have decided differently, so the case stays archived.

If you already collect the reason in your own system, skip the step: put
`overturn_reason_code` in the payment's metadata at refund time and the event arrives attributed.

## 4. What replay proves

Each event becomes a case scored by `purchase_decision`, re-running the frozen snapshot — the same
instruction, cart and catalogue — against whatever model or prompt you are about to ship.

It **passes** when the agent declines to buy, or buys what the correction said it should have. It
**fails** when it buys the refunded item again, buys something nobody sanctioned, gets the quantity
wrong, or goes over `commerce.maxUnitPriceCents`. Declining always passes: not spending the money
is never the expensive mistake.

```bash
npx overturn replay --model openai/gpt-5.1-mini --tag commerce --since 90d
```

## 5. Gate the release

The gate already fails on regressions. With the commerce pack those regressions carry their price,
so the check says what shipping would cost:

```
Gate: red — 2 regressions ($102.50 of past refunds would happen again)
```

```yaml
- uses: overturn-ai/overturn/packages/replay-action@main
  with:
    api-key: ${{ secrets.OVERTURN_API_KEY }}
    model: openai/gpt-5.1-mini
    tag: commerce
    max-money-at-risk: "5000"   # optional: a $50 budget instead of a count
```

Leave `max-money-at-risk` unset and the gate works as it always has: any regression over
`fail-on-regression` (default 0) fails the check. Set it and you are spending a budget instead of
counting, so it *replaces* that count — regressions pass until their past refunds add up to more
than the budget. The action exposes `money-at-risk` in cents as an output either way.

## 6. The scorecard

`/capture` shows what the mistakes cost, split by the model version that made them, so "this model
is cheaper per call" meets "and it lost $1,400 in refunds last month". The same numbers come from
`GET /v1/capture/stats` under `cost`:

```json
{ "cost": { "amountCents": 420000, "attributedCents": 140000,
  "pendingCents": 280000, "pending": 61, "currency": "usd", "priced": 99,
  "byModel": [ { "model": "gpt-4.1-mini", "agentVersion": "buyer-2.1", "captures": 220,
                 "edited": 38, "amountCents": 420000, "attributedCents": 140000 } ] } }
```

`attributedCents` is the headline, and the only figure that claims anything: refunds a person
said the agent caused. `amountCents` is every refund captured, most of which will not be the
agent's doing, and `pendingCents` is what nobody has looked at yet. Forward the scorecard and it
carries both, so the number with a currency symbol on it is one you can defend in the meeting.

Only corrections that carried money count, so a team that never sets an amount sees zeros rather
than a guess. Any correction can carry one: `amountCents` and `currency` are ordinary fields on
`POST /v1/capture` and `POST /v1/corrections`. The commerce pack is the adapter that fills them in
from a provider event.
