import { SECTIONS, type CountKey, type FeedItem, type ParsedFeed, type SectionId } from "./feed.ts";

const COUNT_FOR: Partial<Record<SectionId, CountKey>> = {
  updates: "important_updates",
  soon: "deadlines_soon",
  new: "new",
  saved: "saved",
};

export function savedIds(feed: ParsedFeed): Set<number> {
  return new Set(feed.sections.saved.map((item) => item.event_id));
}

export function ignoreEvent(feed: ParsedFeed, eventId: number): ParsedFeed {
  const next = cloneFeed(feed);
  for (const section of SECTIONS) {
    const before = next.sections[section.id];
    const after = before.filter((item) => item.event_id !== eventId);
    const removed = before.length - after.length;
    if (removed === 0) continue;
    next.sections[section.id] = after;
    const key = COUNT_FOR[section.id];
    if (!key) continue;
    const count = next.counts[key];
    if (typeof count === "number") next.counts[key] = Math.max(0, count - removed);
  }
  return next;
}

export function saveEvent(feed: ParsedFeed, item: FeedItem): ParsedFeed {
  if (feed.sections.saved.some((row) => row.event_id === item.event_id)) return feed;
  const next = cloneFeed(feed);
  next.sections.saved = [...next.sections.saved, item];
  const count = next.counts.saved;
  next.counts.saved = typeof count === "number" ? count + 1 : next.sections.saved.length;
  return next;
}

export function unsaveEvent(feed: ParsedFeed, eventId: number): ParsedFeed {
  const next = cloneFeed(feed);
  const before = next.sections.saved.length;
  next.sections.saved = next.sections.saved.filter((row) => row.event_id !== eventId);
  const removed = before - next.sections.saved.length;
  const count = next.counts.saved;
  if (removed > 0 && typeof count === "number") next.counts.saved = Math.max(0, count - removed);
  return next;
}

function cloneFeed(feed: ParsedFeed): ParsedFeed {
  return {
    ...feed,
    sections: {
      updates: [...feed.sections.updates],
      soon: [...feed.sections.soon],
      new: [...feed.sections.new],
      contests: [...feed.sections.contests],
      hackathons: [...feed.sections.hackathons],
      saved: [...feed.sections.saved],
    },
    counts: { ...feed.counts },
  };
}
