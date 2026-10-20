import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ignoreEvent, saveEvent, unsaveEvent } from "./actions.ts";
import {
  ActionError,
  FeedError,
  actionMessage,
  fetchEvent,
  fetchFeed,
  fetchScanStatus,
  normalizeApiUrl,
  postAction,
  startScan,
  type EventDetail,
  type FeedProblem,
  type RowAction,
  type ScanRun,
  type ScanStart,
} from "./api.ts";
import type { FeedItem, ParsedFeed, SectionId } from "./feed.ts";
import { checkImportant } from "./notify.ts";
import { readSettings, writeSettings, type Settings } from "./settings.ts";
import {
  renderFeed,
  renderLoading,
  renderProblem,
  renderSetup,
  type FeedChrome,
  type FooterState,
} from "./view.ts";

/** Background feed fetch cadence; the only timer that runs while idle. */
const POLL_MS = 30 * 60_000;
/** Opening the popup refetches when the data is older than this. */
const STALE_MS = 5 * 60_000;
const SCAN_POLL_MS = 3_000;
const SCAN_LIMIT_MS = 30 * 60_000;
const SCAN_MISSES = 5;
/** Render's free instance sleeps after 15 minutes without traffic; assume it has after this. */
const IDLE_MS = 10 * 60_000;
/** After an idle spell, a feed request still pending after this long is probably a cold start. */
const WAKING_AFTER_MS = 2_500;
const WAKING = "Waking the server… (the free host can take up to a minute)";

type ScanState = Omit<FooterState, "note">;
const IDLE_SCAN: ScanState = { scanning: false, message: null, sources: [] };

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

let lastContactAt = 0;
let popupOpen = false;
let pollTimer: number | undefined;
let lastAttemptAt = 0;
let lastSuccessAt = 0;
let lastFailed = false;
let refreshing = false;
let refreshAgain = false;
let refreshNote: string | null = null;

let scan: ScanState = IDLE_SCAN;
let scanTimer: number | undefined;
let scanToken = 0;

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
  cancelScan();
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
          const feed = await fetchFeedWaking(base, secret, () => {
            if (id === generation) report(null, true, WAKING);
          });
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
          recordFetch(feed, base);
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
  renderFeed(app, next, tab, new Date(), chrome(), footer(), {
    onScan: () => {
      void runScan();
    },
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

function footer(): FooterState {
  return { ...scan, note: navigator.onLine ? refreshNote : "Offline" };
}

function rerender(): void {
  if (screen === "feed" && feed !== null) showFeed(feed);
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
    const feed = await fetchFeedWaking(current.apiUrl, current.token, () => {
      if (id === generation && screen === "loading") renderLoading(app, WAKING);
    });
    if (id !== generation) return;
    showFeed(feed);
    recordFetch(feed, current.apiUrl);
  } catch (error) {
    if (id !== generation) return;
    recordFetch(null, current.apiUrl);
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

/**
 * Fetches the feed, allowing for a sleeping free-tier host. After an idle spell it
 * calls `onWaking` if the request is slow, and retries once if the server can't be reached.
 */
async function fetchFeedWaking(apiUrl: string, token: string, onWaking: () => void): Promise<ParsedFeed> {
  const idle = Date.now() - lastContactAt > IDLE_MS;
  const slow = idle ? window.setTimeout(onWaking, WAKING_AFTER_MS) : undefined;
  try {
    try {
      return reached(await fetchFeed(apiUrl, token));
    } catch (error) {
      const problem = error instanceof FeedError ? error.problem : "unreachable";
      if (problem !== "unreachable") lastContactAt = Date.now();
      if (!idle || problem !== "unreachable") throw error;
    }
    window.clearTimeout(slow);
    onWaking();
    return reached(await fetchFeed(apiUrl, token));
  } finally {
    window.clearTimeout(slow);
  }
}

function reached(next: ParsedFeed): ParsedFeed {
  lastContactAt = Date.now();
  return next;
}

/** Refetches without blanking the feed. Overlapping calls collapse into one rerun. */
async function quietRefresh(): Promise<void> {
  if (saved === null) return;
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  const epoch = generation;
  const current = saved;
  try {
    const next = await fetchFeedWaking(current.apiUrl, current.token, () => {
      if (epoch !== generation) return;
      refreshNote = WAKING;
      rerender();
    });
    if (epoch !== generation) return;
    recordFetch(next, current.apiUrl);
    if (screen === "feed") showFeed(next);
  } catch (error) {
    if (epoch !== generation) return;
    recordFetch(null, current.apiUrl);
    const problem = error instanceof FeedError ? error.problem : "unreachable";
    if (problem === "unauthorized" || problem === "bad-url") {
      showSetup(messageFor(problem));
      return;
    }
    refreshNote = "Couldn't refresh";
    rerender();
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      refresh();
    }
  }
}

function refresh(): void {
  if (saved === null) return;
  if (screen === "feed") void quietRefresh();
  else if (screen === "problem") void loadSavedFeed();
}

function recordFetch(next: ParsedFeed | null, apiUrl: string): void {
  lastAttemptAt = Date.now();
  lastFailed = next === null;
  if (next !== null) {
    lastSuccessAt = lastAttemptAt;
    refreshNote = null;
    void checkImportant(next, apiUrl, popupOpen);
  }
  schedulePoll();
}

/** Keeps at most one pending fetch, due POLL_MS after the last attempt. Idle while open or offline. */
function schedulePoll(): void {
  window.clearTimeout(pollTimer);
  pollTimer = undefined;
  if (saved === null || popupOpen || !navigator.onLine) return;
  const wait = Math.max(0, lastAttemptAt + POLL_MS - Date.now());
  pollTimer = window.setTimeout(() => {
    pollTimer = undefined;
    refresh();
  }, wait);
}

function onPopupFocus(focused: boolean): void {
  popupOpen = focused;
  schedulePoll();
  if (focused && navigator.onLine && Date.now() - lastSuccessAt > STALE_MS) refresh();
}

function onOnline(): void {
  rerender();
  if (lastFailed || Date.now() - lastAttemptAt >= POLL_MS) refresh();
  else schedulePoll();
}

function onOffline(): void {
  schedulePoll();
  rerender();
}

function setScan(next: ScanState): void {
  scan = next;
  rerender();
}

function cancelScan(): void {
  scanToken += 1;
  window.clearTimeout(scanTimer);
  scanTimer = undefined;
  scan = IDLE_SCAN;
}

async function runScan(): Promise<void> {
  if (saved === null || scan.scanning) return;
  const token = ++scanToken;
  const current = saved;
  setScan({ scanning: true, message: "Starting scan…", sources: [] });
  let start: ScanStart;
  try {
    start = await startScan(current.apiUrl, current.token);
  } catch (error) {
    if (token !== scanToken) return;
    if (error instanceof ActionError && error.status === 401) {
      showSetup(messageFor("unauthorized"));
      return;
    }
    setScan({ scanning: false, message: navigator.onLine ? "Couldn't start a scan" : "Offline", sources: [] });
    return;
  }
  if (token !== scanToken) return;
  if (start === "recent") {
    setScan({ scanning: false, message: "Scanned a few minutes ago", sources: [] });
    return;
  }
  setScan({ scanning: true, message: start === "running" ? "A scan is already running" : "Scanning…", sources: [] });
  pollScan(token, current, Date.now(), 0);
}

function pollScan(token: number, current: Settings, startedAt: number, misses: number): void {
  scanTimer = window.setTimeout(() => {
    scanTimer = undefined;
    void checkScan(token, current, startedAt, misses);
  }, SCAN_POLL_MS);
}

async function checkScan(token: number, current: Settings, startedAt: number, misses: number): Promise<void> {
  if (token !== scanToken) return;
  if (!navigator.onLine) {
    pollScan(token, current, startedAt, misses);
    return;
  }
  let run: ScanRun | null;
  try {
    run = await fetchScanStatus(current.apiUrl, current.token);
  } catch (error) {
    if (token !== scanToken) return;
    if (error instanceof ActionError && error.status === 401) {
      showSetup(messageFor("unauthorized"));
      return;
    }
    if (misses + 1 >= SCAN_MISSES) {
      setScan({ scanning: false, message: "Lost track of the scan", sources: [] });
      refresh();
      return;
    }
    pollScan(token, current, startedAt, misses + 1);
    return;
  }
  if (token !== scanToken) return;
  if (run !== null && run.status === "running") {
    if (Date.now() - startedAt >= SCAN_LIMIT_MS) {
      setScan({ scanning: false, message: "Scan is taking a while, check back later", sources: [] });
      return;
    }
    pollScan(token, current, startedAt, 0);
    return;
  }
  finishScan(run);
}

function finishScan(run: ScanRun | null): void {
  const failed = run === null ? 0 : run.sources.filter((source) => source.failed).length;
  let message = "Scan finished";
  if (run !== null && run.status === "failed") message = "Scan failed";
  else if (failed === 1) message = "Scan finished, 1 source failed";
  else if (failed > 1) message = `Scan finished, ${failed} sources failed`;
  const sources = run !== null && (failed > 0 || run.status === "failed") ? run.sources : [];
  setScan({ scanning: false, message, sources });
  refresh();
}

async function boot(): Promise<void> {
  try {
    saved = await readSettings();
  } catch {
    saved = null;
  }
  if (saved === null) showSetup(null);
  else await loadSavedFeed();

  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  try {
    await listen("refresh", () => {
      refresh();
    });
    await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      onPopupFocus(focused);
    });
  } catch {
    // The tray menu and window events are only available inside the app.
  }
}

void boot();
