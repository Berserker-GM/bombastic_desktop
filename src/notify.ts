import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { SECTIONS, formatDiff, type FeedItem, type ParsedFeed } from "./feed.ts";
import { store } from "./settings.ts";

const SEEN_KEY = "importantSeen";
const LISTED = 3;

/** The important-unseen ids from the previous check, tied to the server they came from. */
interface SeenRecord {
  apiUrl: string;
  ids: number[];
}

let permission: boolean | null = null;
let queue: Promise<void> = Promise.resolve();

export function importantItems(feed: ParsedFeed): FeedItem[] {
  const byId = new Map<number, FeedItem>();
  for (const section of SECTIONS) {
    for (const item of feed.sections[section.id]) {
      if (item.important_unseen && !byId.has(item.event_id)) byId.set(item.event_id, item);
    }
  }
  return [...byId.values()];
}

/**
 * Notifies about items that are important_unseen now but weren't at the previous
 * check, then records the current set. With `silent`, records without notifying.
 * Never throws.
 */
export function checkImportant(feed: ParsedFeed, apiUrl: string, silent: boolean): Promise<void> {
  queue = queue.then(() => runCheck(feed, apiUrl, silent)).catch(() => {});
  return queue;
}

async function runCheck(feed: ParsedFeed, apiUrl: string, silent: boolean): Promise<void> {
  const current = importantItems(feed);
  const previous = await readSeen(apiUrl);
  await writeSeen({ apiUrl, ids: current.map((item) => item.event_id) });
  // The first check for a server only records a baseline, so what's already there doesn't notify.
  if (previous === null) return;
  const fresh = current.filter((item) => !previous.has(item.event_id));
  if (fresh.length === 0 || silent) return;
  if (!(await allowed())) return;
  try {
    sendNotification(notificationFor(fresh));
  } catch {
    // Notifications are best effort.
  }
}

function notificationFor(items: FeedItem[]): { title: string; body: string } {
  if (items.length === 1) {
    const [item] = items;
    const diff = formatDiff(item.diff);
    return { title: "Radar: important update", body: diff ? `${item.title}\n${diff}` : item.title };
  }
  const lines = items.slice(0, LISTED).map((item) => item.title);
  if (items.length > LISTED) lines.push(`and ${items.length - LISTED} more`);
  return { title: `Radar: ${items.length} important updates`, body: lines.join("\n") };
}

async function allowed(): Promise<boolean> {
  if (permission !== null) return permission;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    permission = granted;
  } catch {
    permission = false;
  }
  return permission;
}

/** Resolves to null when there is no usable record for this server yet. */
async function readSeen(apiUrl: string): Promise<Set<number> | null> {
  try {
    const record = await store.get<SeenRecord>(SEEN_KEY);
    if (!record || record.apiUrl !== apiUrl || !Array.isArray(record.ids)) return null;
    return new Set(record.ids.filter((id): id is number => typeof id === "number"));
  } catch {
    return null;
  }
}

async function writeSeen(record: SeenRecord): Promise<void> {
  try {
    await store.set(SEEN_KEY, record);
    await store.save();
  } catch {
    // Worst case is a repeat notification after a restart.
  }
}
