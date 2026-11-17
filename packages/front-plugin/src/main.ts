import Front from "@frontapp/plugin-sdk";
import { type AppSettings, quickReasons, settingsFrom } from "./capture";
import { FrontCaptureAdapter } from "./front-adapter";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function loadSettings(): AppSettings {
  const raw: Record<string, unknown> = {};

  try {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of params.entries()) {
      raw[k] = v;
    }
  } catch {
    // URLSearchParams not available or restricted
  }

  try {
    const stored = window.localStorage.getItem("overturn_settings");
    if (stored) {
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      Object.assign(raw, parsed);
    }
    const key = window.localStorage.getItem("overturn_api_key");
    if (key && !raw.overturn_api_key) raw.overturn_api_key = key;
  } catch {
    // localStorage restricted in some iframe sandboxes
  }

  return settingsFrom(raw);
}

export function initFrontPlugin(): FrontCaptureAdapter {
  const settings = loadSettings();
  const root = document.getElementById("app") ?? document.body;

  const status = el("div", { class: "status" }, "Waiting for a draft");
  const quick = el("div", {
    class: "quick",
    role: "radiogroup",
    "aria-label": "Why did you change it?",
  });

  const chips: HTMLButtonElement[] = [];
  for (const q of quickReasons(settings)) {
    const b = el("button", { type: "button", class: "chip", "data-code": q.code }, q.label);
    chips.push(b);
    quick.appendChild(b);
  }

  const reason = el("textarea", {
    class: "reason",
    rows: "2",
    placeholder: "Anything else? Optional.",
  });

  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const note = el("div", { class: "note" }, "");

  root.append(status, quick, reason, mark, note);

  const adapter = new FrontCaptureAdapter({
    front: Front,
    settings,
  });

  for (const chip of chips) {
    const code = chip.dataset.code;
    if (!code) continue;
    chip.addEventListener("click", () => {
      adapter.selectReasonCode(code);
    });
  }

  reason.addEventListener("input", () => {
    adapter.setReasonNote(reason.value);
  });

  mark.addEventListener("click", () => {
    void adapter.markCurrentDraft();
  });

  adapter.subscribe((state) => {
    status.textContent = state.statusText;
    status.classList.toggle("pending", Boolean(state.pendingCapture));

    for (const chip of chips) {
      chip.classList.toggle("on", chip.dataset.code === state.reasonCode);
      chip.classList.toggle("pending-pulse", Boolean(state.pendingCapture));
    }

    if (reason.value !== state.reasonNote) {
      reason.value = state.reasonNote;
    }

    note.textContent = state.noteText;
    note.classList.toggle("error", state.noteText.includes("could not save"));

    const inScope = state.inScope;
    quick.style.display = inScope ? "flex" : "none";
    reason.style.display = inScope ? "block" : "none";
    mark.style.display = inScope ? "inline-block" : "none";
  });

  adapter.start();
  return adapter;
}

if (typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => {
    initFrontPlugin();
  });
}
