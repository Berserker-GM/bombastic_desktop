# Radar tray

A small system-tray app for the Radar API. Left-click the tray icon to open a popup that lists
important updates, upcoming deadlines, new opportunities, contests, hackathons and saved items. From
the popup you can add an event to Google Calendar, ignore it, save it, open the source, see why it was
picked, and start a scan with **Scan now**.

The app fetches the feed on startup and again every 30 minutes, and refetches when you open the popup
if the data is more than 5 minutes old. It pauses while the machine is offline. When an item becomes an
important unseen update, it shows a desktop notification. Right-click the tray icon for **Refresh** and
**Quit**.

Built with Tauri 2 and TypeScript (Vite).

## Requirements

- Node.js 20+ and npm
- Rust (stable) via [rustup](https://rustup.rs)
- On Windows: the WebView2 runtime (preinstalled on Windows 11) and the MSVC build tools

## Run in development

```bash
npm install
npm run tauri dev
```

The window starts hidden. Look for the Radar icon in the tray (on Windows it may be in the overflow
area by the clock).

## API URL and token

The app talks to the Radar API (`../radar`). Set `API_TOKEN` in `../radar/.env` to a long random
string, then start the API:

```bash
cd ../radar
uv run uvicorn radar.api.main:app --host 127.0.0.1 --port 8000
```

The first time you open the popup, it asks for:

- **API URL**: where the API listens, for example `http://127.0.0.1:8000`
- **Token**: the same value as `API_TOKEN`

**Test** checks both against `GET /feed` and saves them only if that succeeds. They are stored in the
app's `settings.json` (on Windows: `%APPDATA%\com.radar.desktop\settings.json`). If the server later
rejects the token, the popup opens the setup form again. To start over, quit the app and delete that
file.

## Checking notifications

The first feed fetch for an API URL only records which items are important and unseen; it doesn't
notify. Only items that become important after that trigger a notification. To check this by hand:

1. Quit the app and delete `settings.json` (see above) so it starts fresh.
2. Make sure the backend already has at least one important unseen item (it appears under Updates).
3. Start the app and complete setup. **No notification should appear.**
4. Make another item important (for example, change a tracked event's deadline and scan), then use
   tray → **Refresh** with the popup closed. **One notification should appear, for that item only.**
5. Refresh again, or restart the app: no new notification.

Switching to a different API URL starts a new baseline, so it doesn't notify on the first fetch
either.

## Build an installer

```bash
npm run tauri build
```

Installers are written to `src-tauri/target/release/bundle/`: `msi/` and `nsis/` on Windows, `dmg/`
on macOS, and `deb/`, `rpm/` and `appimage/` on Linux. `npm run build` alone only type-checks and
bundles the frontend into `dist/`.
