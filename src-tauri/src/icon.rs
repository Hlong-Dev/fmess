//! fMess's icon follows the theme: the ring and f of its own icon on the
//! theme's colour (branding/icon.py --themes). Only while fMess runs, in the
//! Dock (macOS), on its windows and taskbar button (Windows, Linux) and in the
//! tray; Finder, Start and the app launchers keep the icon it was installed with.

use tauri::{image::Image, AppHandle, Runtime, WebviewWindow};

use crate::settings;

/// A theme's icon at 256 (windows, tray) and 512 (Dock). Themes the user adds,
/// and none, get Messenger's.
fn icon(theme: Option<&str>) -> (&'static [u8], &'static [u8]) {
    match theme {
        Some("zalo") => (
            include_bytes!("../icons/themes/zalo-256.png"),
            include_bytes!("../icons/themes/zalo-512.png"),
        ),
        Some("whatsapp") => (
            include_bytes!("../icons/themes/whatsapp-256.png"),
            include_bytes!("../icons/themes/whatsapp-512.png"),
        ),
        _ => (
            include_bytes!("../icons/themes/messenger-256.png"),
            include_bytes!("../icons/themes/messenger-512.png"),
        ),
    }
}

fn small<R: Runtime>(app: &AppHandle<R>) -> Option<Image<'static>> {
    Image::from_bytes(icon(settings::current(app).theme.as_deref()).0).ok()
}

/// Shows the chosen theme's icon everywhere fMess has one.
pub fn apply<R: Runtime>(app: &AppHandle<R>) {
    if let Some(image) = small(app) {
        #[cfg(not(target_os = "macos"))]
        for window in tauri::Manager::webview_windows(app).values() {
            let _ = window.set_icon(image.clone());
        }
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_icon(Some(image));
        }
    }
    #[cfg(target_os = "macos")]
    {
        let png = icon(settings::current(app).theme.as_deref()).1;
        let _ = app.run_on_main_thread(move || set_dock_icon(png));
    }
}

/// For a window opened after the theme was applied (Settings, calls).
pub fn apply_to<R: Runtime>(_window: &WebviewWindow<R>) {
    #[cfg(not(target_os = "macos"))]
    if let Some(image) = small(tauri::Manager::app_handle(_window)) {
        let _ = _window.set_icon(image);
    }
}

#[cfg(target_os = "macos")]
fn set_dock_icon(png: &'static [u8]) {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(png)) else {
        return;
    };
    #[cfg(debug_assertions)]
    eprintln!("[fmess] dock icon: {} bytes, {:?}", png.len(), image.size());
    // The Dock still draws the unread badge over it.
    unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
}
