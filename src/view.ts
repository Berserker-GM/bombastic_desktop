import { savedIds } from "./actions.ts";
import type { EventDetail, RowAction, ScanSource } from "./api.ts";
import {
  COUNTS,
  SECTIONS,
  chipLabel,
  confidenceLine,
  formatDeadline,
  formatDiff,
  formatMatch,
  formatScanLine,
  formatSourceLine,
  type CountKey,
  type FeedItem,
  type ParsedFeed,
  type SectionId,
} from "./feed.ts";

const COUNT_LABEL: Record<CountKey, string> = {
  important_updates: "Updates",
  deadlines_soon: "Soon",
  new: "New",
  saved: "Saved",
};

const TAB_LABEL: Record<SectionId, string> = {
  updates: "Updates",
  soon: "Soon",
  new: "New",
  contests: "Contests",
  hackathons: "Hackathons",
  saved: "Saved",
};

type Report = (message: string | null, pending: boolean, hint?: string | null) => void;

export interface FeedChrome {
  added: ReadonlySet<number>;
  busy: ReadonlySet<number>;
  errors: ReadonlyMap<number, string>;
  openWhy: ReadonlySet<number>;
  details: ReadonlyMap<number, EventDetail>;
  whyLoading: ReadonlySet<number>;
  whyErrors: ReadonlyMap<number, string>;
}

export interface FooterState {
  scanning: boolean;
  message: string | null;
  sources: readonly ScanSource[];
  note: string | null;
}

export interface FeedHandlers {
  onScan: () => void;
  onTab: (tab: SectionId) => void;
  onAction: (item: FeedItem, action: RowAction) => void;
  onOpen: (item: FeedItem) => void;
  onWhy: (item: FeedItem) => void;
}

export function renderSetup(
  root: HTMLElement,
  initial: { apiUrl: string; token: string; message: string | null },
  onTest: (apiUrl: string, token: string, report: Report) => void,
): void {
  const form = document.createElement("form");
  form.className = "setup";

  const urlInput = document.createElement("input");
  urlInput.name = "apiUrl";
  urlInput.type = "url";
  urlInput.required = true;
  urlInput.spellcheck = false;
  urlInput.placeholder = "http://127.0.0.1:8000";
  urlInput.value = initial.apiUrl;
  urlInput.autocomplete = "off";

  const tokenInput = document.createElement("input");
  tokenInput.name = "token";
  tokenInput.type = "password";
  tokenInput.required = true;
  tokenInput.autocomplete = "off";
  tokenInput.value = initial.token;

  const button = document.createElement("button");
  button.className = "primary";
  button.type = "submit";
  button.textContent = "Test";

  const error = document.createElement("p");
  error.className = "form-error";
  error.setAttribute("role", "alert");

  const status = document.createElement("p");
  status.className = "form-hint";
  status.setAttribute("role", "status");

  const report: Report = (message, pending, hint = null) => {
    error.textContent = message ?? "";
    error.hidden = message === null || message === "";
    status.textContent = hint ?? "";
    status.hidden = hint === null || hint === "";
    button.disabled = pending;
    button.textContent = pending ? "Testing…" : "Test";
  };
  report(initial.message, false);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (button.disabled) return;
    onTest(urlInput.value, tokenInput.value, report);
  });

  form.append(
    el("h1", "setup-title", "Radar"),
    labeled("API URL", urlInput),
    labeled("Token", tokenInput),
    button,
    status,
    error,
  );
  root.replaceChildren(form);
  if (initial.apiUrl === "") urlInput.focus();
  else tokenInput.focus();
}

export function renderLoading(root: HTMLElement, text = "Loading…"): void {
  const line = el("p", "loading", text);
  line.setAttribute("role", "status");
  root.replaceChildren(line);
}

export function renderProblem(root: HTMLElement, message: string, onRetry: () => void): void {
  const retry = document.createElement("button");
  retry.className = "primary";
  retry.type = "button";
  retry.textContent = "Retry";
  retry.addEventListener("click", onRetry);

  const wrap = document.createElement("div");
  wrap.className = "blocker";
  wrap.append(el("p", "blocker-title", message), retry);
  root.replaceChildren(wrap);
}

export function renderFeed(
  root: HTMLElement,
  feed: ParsedFeed,
  tab: SectionId,
  now: Date,
  chrome: FeedChrome,
  footer: FooterState,
  handlers: FeedHandlers,
): void {
  const shell = document.createElement("div");
  shell.className = "shell";
  shell.append(
    renderCounts(feed, tab, handlers.onTab),
    el("p", "scan", formatScanLine(feed.lastScanAt, feed.nextScanAt, now)),
  );

  if (feed.sourceHealth.length > 0) {
    const banner = document.createElement("div");
    banner.className = "banner";
    banner.setAttribute("role", "status");
    for (const source of feed.sourceHealth) {
      banner.append(el("p", undefined, formatSourceLine(source, now)));
    }
    shell.append(banner);
  }

  shell.append(
    renderTabs(tab, handlers.onTab),
    renderList(feed, tab, now, chrome, handlers),
    renderFooter(footer, handlers.onScan),
  );
  root.replaceChildren(shell);
}

function renderFooter(state: FooterState, onScan: () => void): HTMLElement {
  const footer = document.createElement("footer");
  footer.className = "footer";

  const bar = document.createElement("div");
  bar.className = "footer-bar";
  const status = document.createElement("p");
  status.className = "footer-status";
  status.setAttribute("role", "status");
  if (state.scanning) {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    status.append(spinner);
  }
  const text = [state.message, state.note].filter((part): part is string => part !== null && part !== "");
  status.append(text.join(" · "));

  const button = document.createElement("button");
  button.type = "button";
  button.className = "action scan-now";
  button.textContent = "Scan now";
  button.disabled = state.scanning;
  button.addEventListener("click", onScan);
  bar.append(status, button);
  footer.append(bar);

  if (state.sources.length > 0) {
    const list = document.createElement("ul");
    list.className = "scan-sources";
    for (const source of state.sources) list.append(el("li", source.failed ? "failed" : undefined, source.line));
    footer.append(list);
  }
  return footer;
}

function renderCounts(feed: ParsedFeed, tab: SectionId, onTab: (tab: SectionId) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "counts";
  for (const count of COUNTS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = count.tab === tab ? "count active" : "count";
    const value = feed.counts[count.key];
    button.append(
      el("strong", undefined, value === null ? "–" : String(value)),
      el("span", undefined, COUNT_LABEL[count.key]),
    );
    button.addEventListener("click", () => onTab(count.tab));
    row.append(button);
  }
  return row;
}

function renderTabs(tab: SectionId, onTab: (tab: SectionId) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "tabs";
  row.setAttribute("role", "tablist");
  for (const section of SECTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = section.id === tab ? "tab active" : "tab";
    button.textContent = TAB_LABEL[section.id];
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", section.id === tab ? "true" : "false");
    button.addEventListener("click", () => onTab(section.id));
    row.append(button);
  }
  return row;
}

function renderList(
  feed: ParsedFeed,
  tab: SectionId,
  now: Date,
  chrome: FeedChrome,
  handlers: FeedHandlers,
): HTMLElement {
  const section = SECTIONS.find((item) => item.id === tab) ?? SECTIONS[0];
  const list = document.createElement("div");
  list.className = "list";
  const items = feed.sections[section.id];
  if (items.length === 0) {
    list.append(el("p", "empty", section.empty));
    return list;
  }
  const saved = savedIds(feed);
  for (const item of items) list.append(renderRow(item, now, saved.has(item.event_id), chrome, handlers));
  return list;
}

function renderRow(
  item: FeedItem,
  now: Date,
  saved: boolean,
  chrome: FeedChrome,
  handlers: FeedHandlers,
): HTMLElement {
  const row = document.createElement("article");
  row.className = "row";
  row.append(el("h2", "title", item.title));

  const meta = [formatMatch(item.relevance), formatDeadline(item.key_at, now)].filter(
    (part): part is string => part !== null,
  );
  if (meta.length > 0) row.append(el("p", "meta", meta.join(" · ")));

  const diff = formatDiff(item.diff);
  if (diff !== null) row.append(el("p", "diff", diff));

  const confidence = confidenceLine(item.confidence_label);
  if (confidence !== null) row.append(el("p", "confidence", confidence));

  if (item.reasons.length > 0) {
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const reason of item.reasons) chips.append(el("span", "chip", chipLabel(reason)));
    row.append(chips);
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  const locked = chrome.busy.has(item.event_id);
  const added = chrome.added.has(item.event_id);
  actions.append(
    actionButton(added ? "Added" : "Add to Calendar", locked || added, () => handlers.onAction(item, "add_to_calendar")),
    actionButton("Ignore", locked, () => handlers.onAction(item, "ignore")),
    actionButton(saved ? "Unsave" : "Save", locked, () => handlers.onAction(item, saved ? "unsave" : "save")),
  );
  const source = httpUrl(item.url);
  if (source) actions.append(actionButton("View Source", false, () => handlers.onOpen(item)));
  const why = actionButton("Why?", false, () => handlers.onWhy(item));
  why.classList.add("why");
  why.setAttribute("aria-expanded", chrome.openWhy.has(item.event_id) ? "true" : "false");
  actions.append(why);
  row.append(actions);

  const error = chrome.errors.get(item.event_id);
  if (error) {
    const note = el("p", "row-error", error);
    note.setAttribute("role", "alert");
    row.append(note);
  }

  if (chrome.openWhy.has(item.event_id)) row.append(renderWhy(item.event_id, chrome));
  return row;
}

function renderWhy(eventId: number, chrome: FeedChrome): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "why-panel";
  const whyError = chrome.whyErrors.get(eventId);
  if (chrome.whyLoading.has(eventId)) {
    panel.append(el("p", undefined, "Loading…"));
    return panel;
  }
  if (whyError) {
    const note = el("p", "row-error", whyError);
    note.setAttribute("role", "alert");
    panel.append(note);
    return panel;
  }
  const detail = chrome.details.get(eventId);
  if (!detail || (detail.reasons.length === 0 && detail.evidence.length === 0)) {
    panel.append(el("p", undefined, "Nothing more to show."));
    return panel;
  }
  if (detail.reasons.length > 0) panel.append(detailBlock("Reasons", detail.reasons));
  if (detail.evidence.length > 0) panel.append(detailBlock("Evidence", detail.evidence));
  return panel;
}

function detailBlock(title: string, lines: string[]): HTMLElement {
  const block = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = title;
  const list = document.createElement("ul");
  for (const line of lines) list.append(el("li", undefined, line));
  block.append(heading, list);
  return block;
}

function actionButton(label: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "action";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function httpUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function labeled(text: string, input: HTMLInputElement): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "field";
  label.append(el("span", undefined, text), input);
  return label;
}

function el(tag: "h1", className: string | undefined, text: string): HTMLHeadingElement;
function el(tag: "h2", className: string | undefined, text: string): HTMLHeadingElement;
function el(tag: "p", className: string | undefined, text: string): HTMLParagraphElement;
function el(tag: "span", className: string | undefined, text: string): HTMLSpanElement;
function el(tag: "li", className: string | undefined, text: string): HTMLLIElement;
function el(tag: "strong", className: string | undefined, text: string): HTMLElement;
function el(
  tag: "h1" | "h2" | "p" | "span" | "li" | "strong",
  className: string | undefined,
  text: string,
): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}
