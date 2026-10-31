//! fMess's About panel: the standard macOS one, with credits that link to the
//! project and its author.

use tauri::{AppHandle, Runtime};

pub const REPOSITORY: &str = "https://github.com/toanbku/fmess";
const AUTHOR: (&str, &str) = ("Toan Ho", "https://github.com/toanbku");
const WEBSITE: &str = "https://fmess.app";

#[cfg(target_os = "macos")]
pub fn show<R: Runtime>(_app: &AppHandle<R>) {
    use objc2::{runtime::AnyObject, MainThreadMarker};
    use objc2_app_kit::{
        NSAboutPanelOptionCredits, NSApplication, NSColor, NSFont, NSFontAttributeName, NSForegroundColorAttributeName,
        NSLinkAttributeName, NSMutableParagraphStyle, NSParagraphStyleAttributeName, NSTextAlignment,
    };
    use objc2_foundation::{NSDictionary, NSMutableAttributedString, NSRange, NSString, NSURL};

    // Menu items are handled on the main thread.
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let (name, profile) = AUTHOR;
    let site = WEBSITE.trim_start_matches("https://");
    let repo = REPOSITORY.trim_start_matches("https://");
    let text = format!("Made with ♥ by {name}\n{site} · {repo}");
    // NSString ranges count UTF-16 units.
    let range_of = |part: &str| {
        let start = text.find(part).expect("part of the text");
        NSRange::new(text[..start].encode_utf16().count(), part.encode_utf16().count())
    };
    let credits = NSMutableAttributedString::from_nsstring(&NSString::from_str(&text));
    let whole = NSRange::new(0, text.encode_utf16().count());
    let centred = NSMutableParagraphStyle::new();
    centred.setAlignment(NSTextAlignment::Center);
    unsafe {
        credits.addAttribute_value_range(NSFontAttributeName, &NSFont::systemFontOfSize(11.0), whole);
        // labelColor follows light and dark mode.
        credits.addAttribute_value_range(NSForegroundColorAttributeName, &NSColor::labelColor(), whole);
        credits.addAttribute_value_range(NSParagraphStyleAttributeName, &centred, whole);
        for (part, link) in [(name, profile), (site, WEBSITE), (repo, REPOSITORY)] {
            if let Some(url) = NSURL::URLWithString(&NSString::from_str(link)) {
                credits.addAttribute_value_range(NSLinkAttributeName, &url, range_of(part));
            }
        }
        let options: objc2::rc::Retained<NSDictionary<NSString, AnyObject>> =
            NSDictionary::from_slices(&[NSAboutPanelOptionCredits], &[credits.as_ref() as &AnyObject]);
        let app = NSApplication::sharedApplication(mtm);
        app.orderFrontStandardAboutPanelWithOptions(&options);
        app.activate();
    }
}

/// Elsewhere there is no About panel to fill in, so a dialog says the same.
#[cfg(not(target_os = "macos"))]
pub fn show<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    let version = app.package_info().version.to_string();
    let (name, _) = AUTHOR;
    let handle = app.clone();
    app.dialog()
        .message(format!("Version {version}\n\nMade with ♥ by {name}\n{WEBSITE}"))
        .title("fMess")
        .buttons(MessageDialogButtons::OkCancelCustom("Open GitHub".into(), "Close".into()))
        .show(move |open| {
            if open {
                if let Ok(url) = tauri::Url::parse(REPOSITORY) {
                    crate::links::open_external(&handle, &url);
                }
            }
        });
}
