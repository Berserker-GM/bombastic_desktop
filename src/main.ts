import { listen } from "@tauri-apps/api/event";
import { FeedError, fetchFeed, normalizeApiUrl, type FeedProblem } from "./api.ts";
import type { ParsedFeed, SectionId } from "./feed.ts";
import { readSettings, writeSettings, type Settings } from "./settings.ts";
import { renderFeed, renderLoading, renderProblem, renderSetup } from "./view.ts";

const root = document.querySelector("#app");
if (!(root instanceof HTMLElement)) {
  throw new Error("missing app root");
}

const app = root;

let saved: Settings | null = null;
let tab: SectionId = "updates";
let screen: "setup" | "feed" | "problem" | "loading" = "setup";
let generation = 0;

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

function showFeed(feed: ParsedFeed): void {
  screen = "feed";
  renderFeed(app, feed, tab, new Date(), (next) => {
    if (next === tab) return;
    tab = next;
    showFeed(feed);
  });
}

async function loadSavedFeed(): Promise<void> {
  if (saved === null) return;
  const id = ++generation;
  const current = saved;
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
