# Commerce pack example

A buying agent orders the wrong mug. The customer refunds it. The refund becomes a regression
test that blocks the next release if the agent would do it again.

```bash
OVERTURN_API_KEY=ov_live_... pnpm --filter @overturn-ai/example-commerce-pack demo
```

What `src/demo.ts` does, in the order it happens:

1. Sets a Stripe signing secret on the project, the way you would in **Settings → Commerce**.
2. `ov.recordPurchase(...)` records the decision and the snapshot the agent saw — the instruction,
   the catalogue, the budget — and hands back the metadata to put on the payment.
3. Posts a signed `charge.refunded` to `/v1/commerce/webhooks/stripe/<project>`, exactly as
   Stripe would, with `overturn_corrected_sku` saying what should have been bought instead.
4. Reads the scorecard: $22.00 lost, against `gpt-4.1-mini` / `buyer-2.1`.

Then the case is in the suite:

```bash
npx overturn replay --model openai/gpt-5.1-mini --tag commerce
```

`src/demo.e2e.test.ts` runs the whole thing against a real API and a real database, and checks
the three things the pack promises: the snapshot is frozen, the same mistake fails the scorer, and
declining to buy passes.

See [the commerce pack docs](https://docs.overturn.run/docs/commerce/) for the webhook setup.
