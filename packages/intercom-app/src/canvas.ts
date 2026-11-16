import { type AppSettings, type DraftState, quickReasons, statusLine } from "./capture.js";

/**
 * Renders Intercom Canvas Kit card for the inbox conversation sidebar.
 * Ref: https://developers.intercom.com/docs/canvas-kit
 */
export function renderIntercomCanvas(opts: {
  draft: DraftState | null;
  settings: AppSettings;
  selectedReasonCode?: string | null;
  reasonNote?: string;
  lastResult?: { kind: string; changed: boolean; dedup: boolean } | null;
}) {
  const statusText = statusLine(opts.draft, opts.lastResult ?? null);
  const reasons = quickReasons(opts.settings);

  const components: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: `**Overturn Capture**`,
      style: "header",
    },
    {
      type: "text",
      text: statusText,
      style: opts.draft ? "body" : "muted",
    },
  ];

  if (opts.draft) {
    components.push({
      type: "dropdown",
      id: "reason_picker",
      label: "Reason for edit (if changed):",
      value: opts.selectedReasonCode ?? "",
      options: [
        { id: "", text: "Select a reason..." },
        ...reasons.map((r) => ({ id: r.code, text: r.label })),
      ],
    });

    components.push({
      type: "input",
      id: "reason_note",
      label: "Optional note for test suite:",
      placeholder: "e.g. Refund policy requires 14-day window",
      value: opts.reasonNote ?? "",
    });

    components.push({
      type: "button",
      id: "capture_action",
      label: "Sync Status",
      style: "secondary",
      action: { type: "submit" },
    });
  }

  return {
    canvas: {
      content: {
        components,
      },
    },
  };
}
