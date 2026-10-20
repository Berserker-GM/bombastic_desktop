fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&[
            "get_feed",
            "get_event",
            "post_action",
            "scan_now",
            "scan_status",
        ]));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
