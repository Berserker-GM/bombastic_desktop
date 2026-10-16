import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ignoreEvent, saveEvent, unsaveEvent } from "./actions.ts";
import {
  ActionError,
  FeedError,
  actionMessage,
  fetchEvent,
  fetchFeed,
  normalizeApiUrl,
  postAction,
  type EventDetail,
  type FeedProblem,
  type RowAction,
} from "./api.ts";
import type { FeedItem, ParsedFeed, SectionId } from "./feed.ts";
import { readSettings, writeSettings, type Settings } from "./settings.ts";
import { renderFeed, renderLoading, renderProblem, renderSetup, type FeedChrome } from "./view.ts";

const root = document.querySelector("#app");
if (!(root instanceof HTMLElement)) {
  throw new Error("missing app root");
}

const app = root;

let saved: Settings | null = null;
let feed: ParsedFeed | null = null;
let tab: SectionId = "updates";
let screen: "setup" | "feed" | "problem" | "loading" = "setup";
let generation = 0;
const added = new Set<number>();
const busy = new Set<number>();
const errors = new Map<number, string>();
const openWhy = new Set<number>();
const details = new Map<number, EventDetail>();
const whyLoading = new Set<number>();
const whyErrors = new Map<number, string>();

function messageFor(problem: FeedProblem): string {
  switch (problem) {
    case "unauthorized":
      return "That token was rejected.";
    case "bad-url":
      return "Enter a full API URL, like http://127.0.0.1:8000.";
    case "unreadable":
      return "The feed didn't look right.";
    case "unreachable":
      return "Can't reach Radar";
  }
}

function showSetup(message: string | null): void {
  screen = "setup";
  renderSetup(
    app,
    {
      apiUrl: saved?.apiUrl ?? "",
      token: saved?.token ?? "",
      message,
    },
    (apiUrl, token, report) => {
      const base = normalizeApiUrl(apiUrl);
      const secret = token.trim();
      if (base === null || secret === "") {
        report(messageFor("bad-url"), false);
        return;
      }
      report(null, true);
      const id = ++generation;
      void (async () => {
        try {
          const feed = await fetchFeed(base, secret);
          if (id !== generation) return;
          try {
            await writeSettings({ apiUrl: base, token: secret });
          } catch {
            if (id !== generation) return;
            report("Couldn't save these settings.", false);
            return;
          }
          if (id !== generation) return;
          saved = { apiUrl: base, token: secret };
          resetRowState();
          showFeed(feed);
        } catch (error) {
          if (id !== generation) return;
          const problem = error instanceof FeedError ? error.problem : "unreachable";
          report(messageFor(problem), false);
        }
      })();
    },
  );
}

function chrome(): FeedChrome {
  return { added, busy, errors, openWhy, details, whyLoading, whyErrors };
}

function showFeed(next: ParsedFeed): void {
  feed = next;
  screen = "feed";
  const list = app.querySelector(".list");
  const scroll = list instanceof HTMLElement ? list.scrollTop : 0;
  renderFeed(app, next, tab, new Date(), chrome(), {
    onTab: (section) => {
      if (section === tab || feed === null) return;
      tab = section;
      showFeed(feed);
    },
    onAction: (item, action) => {
      void runAction(item, action);
    },
    onOpen: (item) => {
      void openSource(item);
    },
    onWhy: (item) => {
      void toggleWhy(item);
    },
  });
  const nextList = app.querySelector(".list");
  if (nextList instanceof HTMLElement) nextList.scrollTop = scroll;
}

function resetRowState(): void {
  added.clear();
  busy.clear();
  errors.clear();
  openWhy.clear();
  details.clear();
  whyLoading.clear();
  whyErrors.clear();
}

async function runAction(item: FeedItem, action: RowAction): Promise<void> {
  if (saved === null || feed === null || busy.has(item.event_id)) return;
  const epoch = generation;
  const snapshot = feed;
  const wasAdded = added.has(item.event_id);
  busy.add(item.event_id);
  errors.delete(item.event_id);
  if (action === "ignore") feed = ignoreEvent(feed, item.event_id);
  else if (action === "save") feed = saveEvent(feed, item);
  else if (action === "unsave") feed = unsaveEvent(feed, item.event_id);
  else added.add(item.event_id);
  showFeed(feed);
  try {
    await postAction(saved.apiUrl, saved.token, item.event_id, action);
    if (epoch !== generation) return;
  } catch (error) {
    if (epoch !== generation) return;
    feed = snapshot;
    if (wasAdded) added.add(item.event_id);
    else added.delete(item.event_id);
    if (error instanceof ActionError && error.status === 401) {
      showSetup(messageFor("unauthorized"));
      return;
    }
    const status = error instanceof ActionError ? error.status : null;
    errors.set(item.event_id, actionMessage(status));
    showFeed(feed);
  } finally {
    busy.delete(item.event_id);
    if (epoch === generation && feed !== null && screen === "feed") showFeed(feed);
  }
}

async function openSource(item: FeedItem): Promise<void> {
  if (item.url === null || feed === null) return;
  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  try {
    await openUrl(url.toString());
  } catch {
    if (feed === null) return;
    errors.set(item.event_id, actionMessage(null));
    showFeed(feed);
  }
}

async function toggleWhy(item: FeedItem): Promise<void> {
  if (feed === null) return;
  if (openWhy.has(item.event_id)) {
    openWhy.delete(item.event_id);
    showFeed(feed);
    return;
  }
  openWhy.add(item.event_id);
  whyErrors.delete(item.event_id);
  if (details.has(item.event_id) || saved === null) {
    showFeed(feed);
    return;
  }
  whyLoading.add(item.event_id);
  showFeed(feed);
  const epoch = generation;
  const current = saved;
  try {
    const detail = await fetchEvent(current.apiUrl, current.token, item.event_id);
    if (epoch !== generation) return;
    details.set(item.event_id, detail);
  } catch (error) {
    if (epoch !== generation) return;
    if (error instanceof ActionError && error.status === 401) {
      showSetup(messageFor("unauthorized"));
      return;
    }
    whyErrors.set(item.event_id, actionMessage(error instanceof ActionError ? error.status : null));
  } finally {
    whyLoading.delete(item.event_id);
  }
  if (epoch === generation && feed !== null && screen === "feed") showFeed(feed);
}

async function loadSavedFeed(): Promise<void> {
  if (saved === null) return;
  const id = ++generation;
  const current = saved;
  resetRowState();
  screen = "loading";
  renderLoading(app);
  try {
    const feed = await fetchFeed(current.apiUrl, current.token);
    if (id !== generation) return;
    showFeed(feed);
  } catch (error) {
    if (id !== generation) return;
    const problem = error instanceof FeedError ? error.problem : "unreachable";
    if (problem === "unauthorized" || problem === "bad-url") {
      showSetup(messageFor(problem));
      return;
    }
    screen = "problem";
    renderProblem(app, messageFor(problem), () => {
      void loadSavedFeed();
    });
  }
}

async function boot(): Promise<void> {
  try {
    saved = await readSettings();
  } catch {
    saved = null;
  }
  if (saved === null) showSetup(null);
  else await loadSavedFeed();

  try {
    await listen("refresh", () => {
      if (screen === "setup") return;
      void loadSavedFeed();
    });
  } catch {
    // The tray menu is only available inside the app.
  }
}

void boot();
