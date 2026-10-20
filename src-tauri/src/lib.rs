use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_positioner::{Position, WindowExt};

/// Ignores the blur that the opening click itself causes, and treats a tray
/// click that arrives in the same moment as that blur as "close", not "open".
struct PopupGuard {
    hidden_at: Mutex<Option<Instant>>,
    suppress_blur: AtomicBool,
}

const BLUR_GRACE: Duration = Duration::from_millis(150);
/// The free Render instance takes 30-60s to cold start, and /feed is what wakes it.
const FEED_TIMEOUT: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first. A second launch exits before it builds a
        // tray icon, and the running instance ignores it.
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        // Login starts the same binary, and the popup window is created hidden,
        // so an autostarted launch is tray only.
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .manage(PopupGuard {
            hidden_at: Mutex::new(None),
            suppress_blur: AtomicBool::new(false),
        })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }

            let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart = CheckMenuItem::with_id(
                app,
                "autostart",
                "Start with Windows",
                true,
                autostart_on,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&refresh, &autostart, &quit])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .expect("bundle icon missing; tray cannot start");

            TrayIconBuilder::with_id("radar")
                .tooltip("Radar")
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "refresh" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("refresh", ());
                        }
                    }
                    "autostart" => toggle_autostart(app, &autostart),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_popup(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::Focused(false) => {
                    let guard = window.state::<PopupGuard>();
                    if guard.suppress_blur.load(Ordering::SeqCst) {
                        return;
                    }
                    if let Ok(mut hidden_at) = guard.hidden_at.lock() {
                        *hidden_at = Some(Instant::now());
                    }
                    let _ = window.hide();
                }
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_feed,
            get_event,
            post_action,
            scan_now,
            scan_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Radar");
}

#[derive(serde::Serialize)]
struct FeedHttp {
    status: u16,
    body: String,
}

#[tauri::command]
async fn get_feed(api_url: String, token: String) -> Result<FeedHttp, String> {
    radar_send(&api_url, &token, reqwest::Method::GET, "/feed", None, FEED_TIMEOUT).await
}

#[tauri::command]
async fn get_event(api_url: String, token: String, event_id: i64) -> Result<FeedHttp, String> {
    if event_id < 0 {
        return Err("bad-url".into());
    }
    radar_send(
        &api_url,
        &token,
        reqwest::Method::GET,
        &format!("/events/{event_id}"),
        None,
        REQUEST_TIMEOUT,
    )
    .await
}

#[tauri::command]
async fn post_action(
    api_url: String,
    token: String,
    event_id: i64,
    action: String,
) -> Result<FeedHttp, String> {
    if event_id < 0 || !matches!(action.as_str(), "add_to_calendar" | "ignore" | "save" | "unsave") {
        return Err("bad-url".into());
    }
    radar_send(
        &api_url,
        &token,
        reqwest::Method::POST,
        &format!("/events/{event_id}/action"),
        Some(serde_json::json!({ "action": action })),
        REQUEST_TIMEOUT,
    )
    .await
}

#[tauri::command]
async fn scan_now(api_url: String, token: String) -> Result<FeedHttp, String> {
    radar_send(
        &api_url,
        &token,
        reqwest::Method::POST,
        "/scan/now",
        None,
        REQUEST_TIMEOUT,
    )
    .await
}

#[tauri::command]
async fn scan_status(api_url: String, token: String) -> Result<FeedHttp, String> {
    radar_send(
        &api_url,
        &token,
        reqwest::Method::GET,
        "/scan/status",
        None,
        REQUEST_TIMEOUT,
    )
    .await
}

async fn radar_send(
    api_url: &str,
    token: &str,
    method: reqwest::Method,
    path: &str,
    json: Option<serde_json::Value>,
    timeout: Duration,
) -> Result<FeedHttp, String> {
    let base = api_url.trim().trim_end_matches('/');
    let secret = token.trim();
    if base.is_empty() || secret.is_empty() || !path.starts_with('/') || path.contains("..") {
        return Err("bad-url".into());
    }
    let url = reqwest::Url::parse(&format!("{base}{path}")).map_err(|_| "bad-url".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("bad-url".into());
    }

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|_| "unreachable".to_string())?;
    let mut request = client
        .request(method, url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {secret}"));
    if let Some(json) = json {
        request = request.json(&json);
    }
    let response = request.send().await.map_err(|_| "unreachable".to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| "unreachable".to_string())?;
    Ok(FeedHttp { status, body })
}

/// The menu flips its own check mark on click, so the mark is reset from the
/// actual registry state afterwards, whether or not the change worked.
fn toggle_autostart(app: &tauri::AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let manager = app.autolaunch();
    let enabled = manager.is_enabled().unwrap_or(false);
    let _ = if enabled {
        manager.disable()
    } else {
        manager.enable()
    };
    let _ = item.set_checked(manager.is_enabled().unwrap_or(enabled));
}

fn toggle_popup(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    let guard = app.state::<PopupGuard>();
    let just_hidden = guard
        .hidden_at
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
        .is_some_and(|at| at.elapsed() < BLUR_GRACE);
    if just_hidden {
        return;
    }

    guard.suppress_blur.store(true, Ordering::SeqCst);
    let _ = window.move_window_constrained(Position::TrayCenter);
    let _ = window.show();
    let _ = window.set_focus();

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(BLUR_GRACE);
        app.state::<PopupGuard>()
            .suppress_blur
            .store(false, Ordering::SeqCst);
    });
}
