//! New versions come from the GitHub releases (see plugins.updater in
//! tauri.conf.json); the release workflow signs them, and fMess installs only
//! what carries that signature.

use std::{sync::Mutex, time::Duration};

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// fMess often runs for days from the tray, so it looks again now and then.
const CHECK_EVERY: Duration = Duration::from_secs(12 * 60 * 60);

/// A version the user chose to install later, so it isn't offered again
/// until they check for updates themselves.
static POSTPONED: Mutex<Option<String>> = Mutex::new(None);

/// Looks for updates in the background: shortly after launch, then every
/// CHECK_EVERY. Development builds don't, so they never replace themselves.
pub fn check_in_background<R: Runtime>(app: &AppHandle<R>) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Let the window load first.
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            check(&app, false).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// The menu's Check for Updates…: answers even when there is nothing new.
pub fn check_now<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { check(&app, true).await });
}

async fn check<R: Runtime>(app: &AppHandle<R>, asked: bool) {
    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(err) => Err(err),
    };
    match found {
        Ok(Some(update)) => {
            let postponed = POSTPONED.lock().unwrap().as_deref() == Some(update.version.as_str());
            if asked || !postponed {
                offer(app, update);
            }
        }
        Ok(None) if asked => {
            let version = app.package_info().version.to_string();
            app.dialog()
                .message(format!("fMess {version} is the newest version."))
                .title("You're up to date")
                .show(|_| {});
        }
        Err(err) if asked => {
            app.dialog()
                .message(format!("fMess couldn't check for updates.\n\n{err}"))
                .title("Check for Updates")
                .kind(MessageDialogKind::Warning)
                .show(|_| {});
        }
        _ => {
            #[cfg(debug_assertions)]
            if let Err(err) = found {
                eprintln!("[fmess] update check failed: {err}");
            }
        }
    }
}

fn offer<R: Runtime>(app: &AppHandle<R>, update: Update) {
    let current = app.package_info().version.to_string();
    let notes = update.body.as_deref().map(str::trim).filter(|notes| !notes.is_empty());
    let message = match notes {
        Some(notes) => format!("fMess {} is available. You have {current}.\n\n{notes}", update.version),
        None => format!("fMess {} is available. You have {current}.", update.version),
    };
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title("A new version of fMess is available")
        .buttons(MessageDialogButtons::OkCancelCustom("Install and Restart".into(), "Later".into()))
        .show(move |install| {
            if !install {
                *POSTPONED.lock().unwrap() = Some(update.version.clone());
                return;
            }
            tauri::async_runtime::spawn(async move {
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => handle.restart(),
                    Err(err) => {
                        handle
                            .dialog()
                            .message(format!("fMess couldn't install the update.\n\n{err}"))
                            .title("Update failed")
                            .kind(MessageDialogKind::Error)
                            .show(|_| {});
                    }
                }
            });
        });
}
