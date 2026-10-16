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

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "";
}
