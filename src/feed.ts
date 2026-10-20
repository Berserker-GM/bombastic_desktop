export const ZONE = "Asia/Kolkata";

export interface FeedItem {
  event_id: number;
  title: string;
  url: string | null;
  relevance: number | null;
  urgency: string;
  confidence_label: string;
  reasons: string[];
  diff: string | null;
  key_at: string | null;
  important_unseen: boolean;
}

export interface SourceHealth {
  name: string;
  health_status: string;
  last_success_at: string | null;
  last_error: string | null;
}

export interface ParsedFeed {
  sections: Record<SectionId, FeedItem[]>;
  dropped: Record<SectionId, number>;
  counts: Record<CountKey, number | null>;
  lastScanAt: string | null;
  nextScanAt: string | null;
  sourceHealth: SourceHealth[];
  healthDropped: number;
}

export type SectionId = "updates" | "soon" | "new" | "contests" | "hackathons" | "saved";
export type CountKey = "important_updates" | "deadlines_soon" | "new" | "saved";

export const SECTIONS: readonly {
  id: SectionId;
  label: string;
  field: string;
  empty: string;
}[] = [
  { id: "updates", label: "Updates", field: "important_updates", empty: "No important updates." },
  { id: "soon", label: "Soon", field: "deadlines_soon", empty: "No deadlines soon." },
  { id: "new", label: "New", field: "new_opportunities", empty: "Nothing new." },
  { id: "contests", label: "Today's contests", field: "todays_contests", empty: "No contests today." },
  { id: "hackathons", label: "Hackathons", field: "hackathons", empty: "No hackathons." },
  { id: "saved", label: "Saved", field: "saved", empty: "Nothing saved." },
];

export const COUNTS: readonly { key: CountKey; label: string; tab: SectionId }[] = [
  { key: "important_updates", label: "Important updates", tab: "updates" },
  { key: "deadlines_soon", label: "Deadlines soon", tab: "soon" },
  { key: "new", label: "New", tab: "new" },
  { key: "saved", label: "Saved", tab: "saved" },
];

const DIFF_LABELS: Record<string, string> = {
  registration_deadline: "Deadline changed",
  start_at: "Start changed",
  end_at: "End changed",
  location: "Location changed",
  mode: "Mode changed",
  eligibility: "Eligibility changed",
  lifecycle: "Status changed",
  prize_amount_inr: "Prize changed",
};

const CHIP_PREFIXES = ["Topic: ", "Platform: ", "Location: ", "Company: "];

export function parseFeed(value: unknown): ParsedFeed | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const scan = asRecord(body.scan);
  const counts = asRecord(body.counts);
  if (!scan || !counts || !Array.isArray(body.source_health)) return null;

  const sections = {} as Record<SectionId, FeedItem[]>;
  const dropped = {} as Record<SectionId, number>;
  for (const section of SECTIONS) {
    const raw = body[section.field];
    if (!Array.isArray(raw)) return null;
    const items: FeedItem[] = [];
    let lost = 0;
    for (const entry of raw) {
      const item = normalizeItem(entry);
      if (item) items.push(item);
      else lost += 1;
    }
    sections[section.id] = items;
    dropped[section.id] = lost;
  }

  const health: SourceHealth[] = [];
  let healthDropped = 0;
  for (const entry of body.source_health) {
    const row = normalizeHealth(entry);
    if (row) health.push(row);
    else healthDropped += 1;
  }

  return {
    sections,
    dropped,
    counts: {
      important_updates: asCount(counts.important_updates),
      deadlines_soon: asCount(counts.deadlines_soon),
      new: asCount(counts.new),
      saved: asCount(counts.saved),
    },
    lastScanAt: asString(scan.last_scan_at),
    nextScanAt: asString(scan.next_scan_at),
    sourceHealth: health,
    healthDropped,
  };
}

export function formatScanLine(lastScanAt: string | null, nextScanAt: string | null, now: Date): string {
  const last = lastScanAt === null ? "No scan yet" : `Last scan ${formatAgo(lastScanAt, now) ?? "unknown"}`;
  const clock = formatNextClock(nextScanAt);
  const next = clock === null ? "next unknown" : `next ~${clock}`;
  return `${last}, ${next}`;
}

export function formatSourceLine(source: SourceHealth, now: Date): string {
  const error = source.last_error ? `: ${source.last_error}` : "";
  const success = source.last_success_at === null ? "never" : (formatAgo(source.last_success_at, now) ?? "unknown");
  return `${source.name} source ${source.health_status}${error}. Last success: ${success}.`;
}

export function formatDeadline(keyAt: string | null, now: Date): string | null {
  if (keyAt === null) return null;
  const when = new Date(keyAt);
  if (Number.isNaN(when.getTime())) return null;
  const delta = when.getTime() - now.getTime();
  if (delta <= 0) return "Deadline passed";
  return `Deadline in ${formatDuration(delta)}`;
}

export function formatMatch(relevance: number | null): string | null {
  if (relevance === null) return null;
  return `${relevance}% match`;
}

export function formatDiff(diff: string | null): string | null {
  if (diff === null || diff.trim() === "") return null;
  return diff
    .split("; ")
    .map((part) => {
      const splitAt = part.indexOf(": ");
      if (splitAt === -1) return part;
      const field = part.slice(0, splitAt);
      const label = DIFF_LABELS[field];
      if (!label) return part;
      return `${label}: ${part.slice(splitAt + 2)}`;
    })
    .join("; ");
}

export function confidenceLine(label: string): string | null {
  if (label === "medium" || label === "low") return `Deadline confidence: ${label}`;
  return null;
}

export function chipLabel(reason: string): string {
  for (const prefix of CHIP_PREFIXES) {
    if (reason.startsWith(prefix)) return reason.slice(prefix.length);
  }
  if (reason.startsWith("Prize ")) return "prize";
  return reason;
}

export function formatAgo(iso: string, now: Date): string | null {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const delta = now.getTime() - then.getTime();
  if (delta < 0) return null;
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const dayGap = istDayIndex(now) - istDayIndex(then);
  if (dayGap === 1) return "yesterday";
  if (dayGap > 1) return `${dayGap} days ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

export function formatNextClock(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const hour = part(parts, "hour");
  const minute = part(parts, "minute");
  const dayPeriod = part(parts, "dayPeriod");
  if (!hour || !dayPeriod) return null;
  if (minute === "00") return `${hour} ${dayPeriod}`;
  return `${hour}:${minute} ${dayPeriod}`;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

function istDayIndex(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = Number(part(parts, "year"));
  const month = Number(part(parts, "month"));
  const day = Number(part(parts, "day"));
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function part(parts: Intl.DateTimeFormatPart[], type: string): string | null {
  return parts.find((item) => item.type === type)?.value ?? null;
}

function normalizeItem(value: unknown): FeedItem | null {
  const row = asRecord(value);
  if (!row || typeof row.event_id !== "number" || typeof row.title !== "string") return null;
  return {
    event_id: row.event_id,
    title: row.title,
    url: asString(row.url),
    relevance: typeof row.relevance === "number" ? row.relevance : null,
    urgency: typeof row.urgency === "string" ? row.urgency : "",
    confidence_label: typeof row.confidence_label === "string" ? row.confidence_label : "",
    reasons: Array.isArray(row.reasons)
      ? row.reasons.filter((reason): reason is string => typeof reason === "string" && reason.trim() !== "")
      : [],
    diff: asString(row.diff),
    key_at: asString(row.key_at),
    important_unseen: row.important_unseen === true,
  };
}

function normalizeHealth(value: unknown): SourceHealth | null {
  const row = asRecord(value);
  if (!row || typeof row.name !== "string" || typeof row.health_status !== "string") return null;
  return {
    name: row.name,
    health_status: row.health_status,
    last_success_at: asString(row.last_success_at),
    last_error: asString(row.last_error),
  };
}

function asCount(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}
