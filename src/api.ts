import { invoke } from "@tauri-apps/api/core";
import { parseFeed, type ParsedFeed } from "./feed.ts";

export type FeedProblem = "unauthorized" | "unreachable" | "bad-url" | "unreadable";

export class FeedError extends Error {
  readonly problem: FeedProblem;

  constructor(problem: FeedProblem) {
    super(problem);
    this.problem = problem;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface FeedHttp {
  status: number;
  body: string;
}

export function normalizeApiUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed === "") return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return trimmed;
  } catch {
    return null;
  }
}

export async function fetchFeed(apiUrl: string, token: string): Promise<ParsedFeed> {
  const base = normalizeApiUrl(apiUrl);
  const secret = token.trim();
  if (base === null || secret === "") throw new FeedError("bad-url");

  let result: FeedHttp;
  try {
    result = await invoke<FeedHttp>("get_feed", { apiUrl: base, token: secret });
  } catch (error) {
    const message = errorText(error);
    if (message.includes("bad-url")) throw new FeedError("bad-url");
    throw new FeedError("unreachable");
  }

  if (result.status === 401) throw new FeedError("unauthorized");
  if (result.status !== 200) throw new FeedError("unreachable");

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new FeedError("unreadable");
  }
  const feed = parseFeed(parsed);
  if (feed === null) throw new FeedError("unreadable");
  return feed;
}

export type RowAction = "add_to_calendar" | "ignore" | "save" | "unsave";

export interface EventDetail {
  reasons: string[];
  evidence: string[];
}

export class ActionError extends Error {
  readonly status: number | null;

  constructor(status: number | null) {
    super(status === null ? "failed" : String(status));
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function actionMessage(status: number | null): string {
  if (status === 502) return "Google sign-in expired";
  if (status === 503) return "Calendar not set up";
  return "Something went wrong, try again";
}

export async function postAction(apiUrl: string, token: string, eventId: number, action: RowAction): Promise<void> {
  const result = await callRadar("post_action", { apiUrl, token, eventId, action });
  if (result.status === 401) throw new ActionError(401);
  if (result.status < 200 || result.status >= 300) throw new ActionError(result.status);
}

export async function fetchEvent(apiUrl: string, token: string, eventId: number): Promise<EventDetail> {
  const result = await callRadar("get_event", { apiUrl, token, eventId });
  if (result.status === 401) throw new ActionError(401);
  if (result.status !== 200) throw new ActionError(result.status);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new ActionError(null);
  }
  const detail = parseEventDetail(parsed);
  if (detail === null) throw new ActionError(null);
  return detail;
}

export function parseEventDetail(value: unknown): EventDetail | null {
  const body = asRecord(value);
  if (!body) return null;
  const source = asRecord(body.event) ?? body;
  if (!("reasons" in source) && !("evidence" in source)) return null;
  const reasons = stringList(source.reasons);
  const evidence = evidenceList(source.evidence);
  if (reasons === null || evidence === null) return null;
  return { reasons, evidence };
}

export type ScanStart = "started" | "running" | "recent";

export interface ScanSource {
  name: string;
  line: string;
  failed: boolean;
}

export interface ScanRun {
  id: number | null;
  status: string;
  sources: ScanSource[];
}

const FAILED_RESULTS = new Set(["unreachable", "malformed"]);

const RESULT_LABELS: Record<string, string> = {
  ok_new: "ok",
  ok_nothing_new: "nothing new",
  unreachable: "unreachable",
  malformed: "unreadable response",
};

export async function startScan(apiUrl: string, token: string): Promise<ScanStart> {
  const result = await callRadar("scan_now", { apiUrl, token });
  if (result.status === 409) return "running";
  if (result.status === 429) return "recent";
  if (result.status < 200 || result.status >= 300) throw new ActionError(result.status);
  return "started";
}

/** Resolves to null when the server has no scan on record. */
export async function fetchScanStatus(apiUrl: string, token: string): Promise<ScanRun | null> {
  const result = await callRadar("scan_status", { apiUrl, token });
  if (result.status === 404) return null;
  if (result.status !== 200) throw new ActionError(result.status);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new ActionError(null);
  }
  const run = parseScanRun(parsed);
  if (run === null) throw new ActionError(null);
  return run;
}

export function parseScanRun(value: unknown): ScanRun | null {
  const body = asRecord(value);
  if (!body || typeof body.status !== "string") return null;
  const perSource = asRecord(body.per_source) ?? {};
  const sources: ScanSource[] = [];
  for (const [name, entry] of Object.entries(perSource)) {
    const row = asRecord(entry);
    const result = row && typeof row.result === "string" ? row.result : "";
    if (result === "skipped") continue;
    const failed = FAILED_RESULTS.has(result);
    const error = row ? firstString(row, ["error"]) : null;
    const counts = row ? asRecord(row.counts) : null;
    let detail = RESULT_LABELS[result] ?? (result || "unknown");
    if (result === "ok_new" && counts) {
      const added = typeof counts.new === "number" ? counts.new : 0;
      const changed = typeof counts.changed === "number" ? counts.changed : 0;
      detail = `${added} new, ${changed} changed`;
    }
    if (failed && error) detail = `${detail} (${error})`;
    sources.push({ name, line: `${name}: ${detail}`, failed });
  }
  return { id: typeof body.id === "number" ? body.id : null, status: body.status, sources };
}

async function callRadar(
  command: "post_action" | "get_event" | "scan_now" | "scan_status",
  args: Record<string, unknown>,
): Promise<FeedHttp> {
  const apiUrl = typeof args.apiUrl === "string" ? normalizeApiUrl(args.apiUrl) : null;
  const token = typeof args.token === "string" ? args.token.trim() : "";
  if (apiUrl === null || token === "") throw new ActionError(null);
  try {
    return await invoke<FeedHttp>(command, { ...args, apiUrl, token });
  } catch {
    throw new ActionError(null);
  }
}

function stringList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const lines: string[] = [];
  for (const entry of value) {
    const line = textLine(entry);
    if (line) lines.push(line);
  }
  return lines;
}

function evidenceList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const lines: string[] = [];
  for (const entry of value) {
    const line = evidenceLine(entry);
    if (line) lines.push(line);
  }
  return lines;
}

function evidenceLine(value: unknown): string | null {
  const direct = textLine(value);
  if (direct && (typeof value === "string" || !asRecord(value))) return direct;
  const row = asRecord(value);
  if (!row) return direct;
  const before = firstString(row, ["before", "old", "from"]);
  const after = firstString(row, ["after", "new", "to"]);
  if (before && after) {
    const field = firstString(row, ["field", "source", "title"]);
    return field ? `${field}: ${before} -> ${after}` : `${before} -> ${after}`;
  }
  const text = firstString(row, ["text", "quote", "snippet", "evidence", "excerpt", "reason"]);
  const source = firstString(row, ["source", "title", "url"]);
  if (text && source && text !== source) return `${source}: ${text}`;
  return text ?? source ?? direct;
}

function textLine(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  const row = asRecord(value);
  if (!row) return null;
  return firstString(row, ["text", "quote", "snippet", "reason", "evidence"]);
}

function firstString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "";
}
