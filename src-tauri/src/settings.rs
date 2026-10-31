use std::{fs, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, Theme};
use tauri_plugin_autostart::ManagerExt;

use crate::{badge, MAIN_WINDOW};

/// fMess's own preferences. Account settings (active status, sounds, dark
/// mode) stay in Facebook's Preferences, which sync with the phone app.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// When launched at login, stay in the tray instead of opening the window.
    pub start_hidden: bool,
    pub notifications: bool,
    /// Show the sender and text; otherwise just "New message".
    pub notification_preview: bool,
    pub badge: bool,
    /// Closing the window keeps fMess running; otherwise it quits.
    pub close_to_tray: bool,
    pub zoom: f64,
    /// Turn on Facebook's WebKit path for calls in encrypted chats (macOS).
    pub mac_calls: bool,
    /// Don't let people see that you're typing.
    pub block_typing: bool,
    /// Messenger's dark mode as last reported (ENABLED, DISABLED, USE_SYSTEM),
    /// so fMess starts in the right colours before the page has loaded.
    pub messenger_dark_mode: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            start_hidden: false,
            notifications: true,
            notification_preview: true,
            badge: true,
            close_to_tray: true,
            zoom: 1.0,
            mac_calls: true,
            block_typing: false,
            messenger_dark_mode: None,
        }
    }
}

pub struct SettingsState(Mutex<Settings>);

/// Messenger's own Preferences, which belong to the account. The page reports
/// them (sync_messenger_prefs) so the Settings window can show them.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessengerPrefs {
    sounds_on: bool,
    active_status_on: Option<bool>,
    /// Seconds since 1970 when Do Not Disturb ends: 0 when off, -1 until turned off.
    mute_until: i64,
    /// ENABLED, DISABLED or USE_SYSTEM.
    dark_mode: String,
}

#[derive(Default)]
pub struct MessengerPrefsState(Mutex<Option<MessengerPrefs>>);

/// What the Settings window shows: the saved settings plus live system state.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    #[serde(flatten)]
    settings: Settings,
    launch_at_login: bool,
    platform: &'static str,
    /// None until the page has read them, or when logged out.
    messenger: Option<MessengerPrefs>,
}

pub fn init<R: Runtime>(app: &AppHandle<R>) -> Settings {
    let settings = settings_path(app)
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    app.manage(SettingsState(Mutex::new(Settings::clone(&settings))));
    app.manage(MessengerPrefsState::default());
    settings
}

pub fn current<R: Runtime>(app: &AppHandle<R>) -> Settings {
    app.state::<SettingsState>().0.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_settings<R: Runtime>(app: AppHandle<R>) -> SettingsView {
    view(&app, current(&app))
}

#[tauri::command]
pub fn update_settings<R: Runtime>(
    app: AppHandle<R>,
    settings: Settings,
    launch_at_login: bool,
) -> Result<SettingsView, String> {
    let previous = current(&app);
    let autostart = app.autolaunch();
    if autostart.is_enabled().unwrap_or(false) != launch_at_login {
        let result = if launch_at_login { autostart.enable() } else { autostart.disable() };
        result.map_err(|err| format!("could not change Open at Login: {err}"))?;
    }

    let mut settings = settings;
    // Kept by the page, not edited in the Settings window.
    settings.messenger_dark_mode = previous.messenger_dark_mode.clone();
    *app.state::<SettingsState>().0.lock().unwrap() = settings.clone();
    save(&app, &settings)?;

    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if settings.zoom != previous.zoom {
            let _ = window.set_zoom(settings.zoom);
        }
        if settings.badge != previous.badge {
            badge::refresh(&window);
        }
        if settings.block_typing != previous.block_typing {
            let _ = window.eval(page_settings_script(&settings));
        }
        if settings.mac_calls != previous.mac_calls {
            // The call gate is patched as Facebook loads, so reload to apply
            // it; the page's settings from when the window opened are older,
            // so this one value goes to the reload through localStorage.
            let _ = window.eval(format!(
                "try {{ localStorage.setItem('fmess.macCalls', '{}'); }} catch {{}} location.reload();",
                if settings.mac_calls { "1" } else { "0" }
            ));
        }
    }
    Ok(view(&app, settings))
}

/// Called by inject.js with Messenger's Preferences, which the phone app or
/// Messenger's own dialog may have changed.
#[tauri::command]
pub fn sync_messenger_prefs<R: Runtime>(app: AppHandle<R>, prefs: MessengerPrefs) -> Result<(), String> {
    let previous = app.state::<MessengerPrefsState>().0.lock().unwrap().replace(prefs.clone());
    if !matches!(previous, Some(previous) if previous.dark_mode == prefs.dark_mode) {
        // fMess's windows (Settings, title bars, menus) look like Messenger.
        app.set_theme(messenger_theme(Some(&prefs.dark_mode)));
    }
    let mut settings = current(&app);
    if settings.messenger_dark_mode.as_deref() == Some(prefs.dark_mode.as_str()) {
        return Ok(());
    }
    settings.messenger_dark_mode = Some(prefs.dark_mode);
    *app.state::<SettingsState>().0.lock().unwrap() = settings.clone();
    save(&app, &settings)
}

/// The window theme for Messenger's dark mode setting; None follows the system.
pub fn messenger_theme(dark_mode: Option<&str>) -> Option<Theme> {
    match dark_mode? {
        "ENABLED" => Some(Theme::Dark),
        "USE_SYSTEM" => None,
        _ => Some(Theme::Light),
    }
}

/// Changes one of Messenger's Preferences from the Settings window: soundsOn,
/// darkMode or muteFor (milliseconds, -1 until turned off, 0 to turn it off).
#[tauri::command]
pub fn set_messenger_pref<R: Runtime>(app: AppHandle<R>, name: String, value: serde_json::Value) -> Result<(), String> {
    let window = app.get_webview_window(MAIN_WINDOW).ok_or("fMess's window is closed")?;
    if let ("darkMode", Some(mode)) = (name.as_str(), value.as_str()) {
        // Recolour fMess's windows together with the page, not after it reports.
        app.set_theme(messenger_theme(Some(mode)));
    }
    let call = serde_json::to_string(&(name, value)).expect("JSON serializes");
    window
        .eval(format!("window.__fmessSetMessengerPref?.(...{call});"))
        .map_err(|err| err.to_string())
}

/// Opens Messenger's own Preferences in fMess's window, or its Active Status
/// page, for what the Settings window leaves to it.
#[tauri::command]
pub fn open_messenger_preferences<R: Runtime>(app: AppHandle<R>, section: Option<String>) {
    crate::show_main_window(&app);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let section = serde_json::to_string(&section).expect("JSON serializes");
        let _ = window.eval(format!("window.__fmessOpenMessengerPreferences?.({section});"));
    }
}

/// Text sizes, as the Settings window lists them and View → Zoom steps through.
const ZOOM_STEPS: [f64; 11] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];

/// The View menu's Zoom In (1), Zoom Out (-1) and Actual Size (0).
pub fn zoom_by<R: Runtime>(app: &AppHandle<R>, step: i32) {
    let now = current(app).zoom;
    let nearest = (0..ZOOM_STEPS.len())
        .min_by(|&a, &b| (ZOOM_STEPS[a] - now).abs().total_cmp(&(ZOOM_STEPS[b] - now).abs()))
        .unwrap_or(0);
    let zoom = match step {
        0 => 1.0,
        _ => ZOOM_STEPS[nearest.saturating_add_signed(step as isize).min(ZOOM_STEPS.len() - 1)],
    };
    if zoom == now {
        return;
    }
    if let Err(err) = change(app, |settings| settings.zoom = zoom) {
        eprintln!("could not save the text size: {err}");
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.set_zoom(zoom);
    }
}

/// The settings inject.js works with. Facebook clears localStorage keys it
/// doesn't know within seconds, so they reach the page from here: in the
/// window's initialization script, and again after every page load.
pub fn page_settings(settings: &Settings) -> String {
    serde_json::json!({
        "macCalls": settings.mac_calls,
        "blockTyping": settings.block_typing,
    })
    .to_string()
}

/// Hands the current settings to the loaded page.
pub fn page_settings_script(settings: &Settings) -> String {
    format!("window.__fmessApplySettings?.({});", page_settings(settings))
}


fn change<R: Runtime>(app: &AppHandle<R>, edit: impl FnOnce(&mut Settings)) -> Result<(), String> {
    let mut settings = current(app);
    edit(&mut settings);
    *app.state::<SettingsState>().0.lock().unwrap() = settings.clone();
    save(app, &settings)
}

fn view<R: Runtime>(app: &AppHandle<R>, settings: Settings) -> SettingsView {
    SettingsView {
        settings,
        launch_at_login: app.autolaunch().is_enabled().unwrap_or(false),
        platform: std::env::consts::OS,
        messenger: app.state::<MessengerPrefsState>().0.lock().unwrap().clone(),
    }
}

fn save<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app).ok_or("no config directory")?;
    let json = serde_json::to_vec_pretty(settings).expect("settings serialize to JSON");
    path.parent()
        .map_or(Ok(()), fs::create_dir_all)
        .and_then(|()| fs::write(&path, json))
        .map_err(|err| format!("could not save settings to {}: {err}", path.display()))
}

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("settings.json"))
}



