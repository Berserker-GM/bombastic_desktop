import { LazyStore } from "@tauri-apps/plugin-store";

export const store = new LazyStore("settings.json");

export interface Settings {
  apiUrl: string;
  token: string;
}

export async function readSettings(): Promise<Settings | null> {
  const apiUrl = await store.get<string>("apiUrl");
  const token = await store.get<string>("token");
  if (typeof apiUrl !== "string" || apiUrl.trim() === "") return null;
  if (typeof token !== "string" || token.trim() === "") return null;
  return { apiUrl: apiUrl.trim(), token: token.trim() };
}

export async function writeSettings(settings: Settings): Promise<void> {
  await store.set("apiUrl", settings.apiUrl);
  await store.set("token", settings.token);
  await store.save();
}
