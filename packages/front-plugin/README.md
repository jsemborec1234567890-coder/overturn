# Overturn for Front

QA for AI-drafted replies, in the Front sidebar. It watches Front for AI drafts, diffs them against what the agent actually sends, asks for a one-line reason, and posts the result to `POST /v1/capture` with `source: 'front'` and `externalId: 'fr:<conversationId>'`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change.

## What the agent sees

A small panel in the Front sidebar:

- **Draft inserted · 112 words** once an AI assist, macro or paste lands in the composer (anything reply-sized inserted in one change). If the drafting agent recorded its run with the Overturn SDK (`externalId: "fr:<conversationId>"`), the draft is taken from that run instead. "Use the current text as the draft" marks it by hand.
- A **reason** picker with quick-pick chips (support or claims pack).
- On **Send**: sent as drafted → an `approve` capture, no prompt; changed → an `edit` capture with the reason as the case's title and the judge's rubric. Because the Front Plugin SDK has no pre-send veto hook, `require_reason` is enforced by holding the capture in the panel until a reason is selected—Front's native Send is never blocked, and failures fail-open.

Overturn failing never blocks the agent's work; the panel surfaces errors cleanly without interrupting the workflow.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build the plugin: `pnpm --filter @overturn-ai/front-plugin build` → `dist/overturn-front-plugin.zip` (and static assets in `dist/app`).
3. In Front Settings → Developers → Plugins & API → **Create plugin**:
   - Provide the URL where `dist/app` is hosted (or configure your development endpoint).
   - Configure parameters via query parameters or preferences:
     - `overturn_api_key`: project API key
     - `overturn_base_url`: API base URL (default `https://api.overturn.run`)
     - `agent`: workflow name (default `support-reply`)
     - `reason_pack`: `support` (default) or `claims`
     - `require_reason`: `true` (default)
     - `capture_internal_notes`: `false` (default)
     - `decision_fields`: custom fields that are the decision, as `id:label` pairs
     - `scope_tag`: optional tag to restrict watching to specific conversations
     - `min_draft_chars`: minimum characters to count as draft (default `80`)

## Development

```bash
pnpm --filter @overturn-ai/front-plugin test      # unit tests mocking Front SDK
pnpm --filter @overturn-ai/front-plugin typecheck # strict typescript check
pnpm --filter @overturn-ai/front-plugin build     # tsup bundle + package script
```

- `src/capture.ts`: Pure domain logic (draft detection, context rendering, HTML stripping, diffs, send decisions).
- `src/front-adapter.ts`: Coordinates Front SDK `contextUpdates`, `fetchDraft`, outbound send detection, held reason capture, and fail-open API reporting.
- `src/main.ts`: Front plugin DOM entrypoint and UI binding.
- `app/`: HTML template, styles, and manifest.
