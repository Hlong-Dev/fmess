use tauri::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, LogicalPosition, Manager, Runtime, WebviewWindow,
};

use crate::{
    about, settings, show_main_window, update,
    webview::{self, messages_url},
    MAIN_WINDOW,
};

const SHOW: &str = "show";
const MESSAGES: &str = "messages";
const RELOAD: &str = "reload";
const BACK: &str = "back";
const FORWARD: &str = "forward";
const SEARCH: &str = "search";
const NEW_MESSAGE: &str = "new-message";
const NEXT_CHAT: &str = "next-chat";
const PREVIOUS_CHAT: &str = "previous-chat";
const SETTINGS: &str = "settings";
const LOG_OUT: &str = "log-out";
const ZOOM_IN: &str = "zoom-in";
const ZOOM_OUT: &str = "zoom-out";
const ZOOM_RESET: &str = "zoom-reset";
const ABOUT: &str = "about";
const CHECK_FOR_UPDATES: &str = "check-for-updates";
const QUIT: &str = "quit";

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let tray_menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, SHOW, "Show fMess", true, None::<&str>)?,
            &MenuItem::with_id(app, MESSAGES, "Open Chats", true, None::<&str>)?,
            &MenuItem::with_id(app, RELOAD, "Reload", true, None::<&str>)?,
            &MenuItem::with_id(app, SETTINGS, "Settings…", true, None::<&str>)?,
            &MenuItem::with_id(app, CHECK_FOR_UPDATES, "Check for Updates…", true, None::<&str>)?,
            &MenuItem::with_id(app, ABOUT, "About fMess", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, QUIT, "Quit fMess", true, None::<&str>)?,
        ],
    )?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("fMess")
        .menu(&tray_menu)
        // Left click shows the window; the menu stays on right click.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    #[cfg(target_os = "macos")]
    app.set_menu(app_menu(app)?)?;
    Ok(())
}

/// macOS needs a menu bar for copy/paste shortcuts; add navigation to it.
#[cfg(target_os = "macos")]
fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    use tauri::menu::Submenu;

    let menu = Menu::default(app)?;
    // The first submenu is the app menu. Its About fMess becomes fMess's own
    // (with credits), followed by Check for Updates…, a separator and Settings.
    if let Some(app_menu) = menu.items()?.first().and_then(|item| item.as_submenu()) {
        app_menu.remove_at(0)?;
        app_menu.insert_items(
            &[
                &MenuItem::with_id(app, ABOUT, "About fMess", true, None::<&str>)?,
                &MenuItem::with_id(app, CHECK_FOR_UPDATES, "Check for Updates…", true, None::<&str>)?,
            ],
            0,
        )?;
        app_menu.insert_items(
            &[
                &MenuItem::with_id(app, SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?,
                &PredefinedMenuItem::separator(app)?,
            ],
            3,
        )?;
    }
    let go = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            &MenuItem::with_id(app, MESSAGES, "Chats", true, Some("CmdOrCtrl+Shift+H"))?,
            &MenuItem::with_id(app, SEARCH, "Search", true, Some("CmdOrCtrl+K"))?,
            &MenuItem::with_id(app, NEW_MESSAGE, "New Message", true, Some("CmdOrCtrl+N"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, NEXT_CHAT, "Next Conversation", true, Some("CmdOrCtrl+Shift+]"))?,
            &MenuItem::with_id(
                app,
                PREVIOUS_CHAT,
                "Previous Conversation",
                true,
                Some("CmdOrCtrl+Shift+["),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, BACK, "Back", true, Some("CmdOrCtrl+["))?,
            &MenuItem::with_id(app, FORWARD, "Forward", true, Some("CmdOrCtrl+]"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, RELOAD, "Reload", true, Some("CmdOrCtrl+R"))?,
        ],
    )?;
    // The default menu is App, File, Edit, View, Window, Help: put Go before Window.
    menu.insert(&go, 4)?;

    let view = menu.items()?.into_iter().find_map(|item| {
        item.as_submenu()
            .filter(|submenu| submenu.text().is_ok_and(|text| text == "View"))
            .cloned()
    });
    if let Some(view) = view {
        view.insert_items(
            &[
                &MenuItem::with_id(app, ZOOM_RESET, "Actual Size", true, Some("CmdOrCtrl+0"))?,
                &MenuItem::with_id(app, ZOOM_IN, "Zoom In", true, Some("CmdOrCtrl+="))?,
                &MenuItem::with_id(app, ZOOM_OUT, "Zoom Out", true, Some("CmdOrCtrl+-"))?,
                &PredefinedMenuItem::separator(app)?,
            ],
            0,
        )?;
    }
    Ok(menu)
}

/// The old desktop app's account menu: inject.js puts the account's picture
/// above the chats, and clicking it opens this under the picture.
#[tauri::command]
pub fn show_account_menu<R: Runtime>(
    window: WebviewWindow<R>,
    name: String,
    x: f64,
    y: f64,
) -> tauri::Result<()> {
    let app = window.app_handle();
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::new(app, name, false, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, SETTINGS, "Settings…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, LOG_OUT, "Log Out", true, None::<&str>)?,
        ],
    )?;
    // The page measures in CSS pixels, which fMess's zoom setting scales.
    let zoom = settings::current(app).zoom;
    window.popup_menu_at(&menu, LogicalPosition::new(x * zoom, y * zoom))
}

/// Handles clicks from the tray menu, the macOS menu bar and the account menu.
pub fn handle<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let window = app.get_webview_window(MAIN_WINDOW);
    match event.id().as_ref() {
        SHOW => show_main_window(app),
        MESSAGES => {
            show_main_window(app);
            if let Some(window) = window {
                let _ = window.navigate(messages_url());
            }
        }
        RELOAD => {
            if let Some(window) = window {
                let _ = window.reload();
            }
        }
        BACK => {
            if let Some(window) = window {
                let _ = window.eval("history.back()");
            }
        }
        FORWARD => {
            if let Some(window) = window {
                let _ = window.eval("history.forward()");
            }
        }
        SETTINGS => webview::open_settings_window(app),
        ABOUT => about::show(app),
        CHECK_FOR_UPDATES => update::check_now(app),
        ZOOM_IN => settings::zoom_by(app, 1),
        ZOOM_OUT => settings::zoom_by(app, -1),
        ZOOM_RESET => settings::zoom_by(app, 0),
        LOG_OUT => {
            if let Some(window) = window {
                let _ = window.eval("window.__fmessLogOut?.()");
            }
        }
        // The shortcuts live in inject.js; the menu shows them and forwards to them.
        SEARCH | NEW_MESSAGE | NEXT_CHAT | PREVIOUS_CHAT => {
            let call = match event.id().as_ref() {
                SEARCH => "'search'",
                NEW_MESSAGE => "'newMessage'",
                NEXT_CHAT => "'moveChat', 1",
                _ => "'moveChat', -1",
            };
            if let Some(window) = window {
                let _ = window.eval(format!("window.__fmessShortcut?.({call})"));
            }
        }
        QUIT => app.exit(0),
        _ => {}
    }
}
