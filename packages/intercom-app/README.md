# @overturn-ai/intercom-app

Overturn capture adapter for Intercom (Canvas Kit, inbox surface).
Addresses [Issue #21: Bounty $100: capture adapter for Intercom](https://github.com/overturn-ai/overturn/issues/21).

## Capabilities
1. **Draft Detection**: Monitors composer and detects Fin AI or inserted macro drafts, displaying `Draft inserted · N words` or `Draft from Fin AI · N words`.
2. **Reason Picker**: Built-in `support` reason pack codes by default (and `claims` pack support), with optional freeform rationale notes.
3. **Capture Payload**: On send, constructs `POST /v1/capture` with:
   - `source: "intercom"`
   - `externalId: "ic:<conversation_id>"`
   - `context`: cleaned conversation history
   - `draft` and `sent` answers
4. **Honours `require_reason`**: Validates reason requirements when draft is edited.
5. **Non-blocking Execution**: Never interrupts teammate messaging flow. Distinguishes `draft:ai` (Fin assists) from `draft:manual` (human typed/edited).

## Test Suite
Run local vitest tests:
```bash
npm test
```
