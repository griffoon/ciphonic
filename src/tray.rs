//! The notification-area icon: a click brings the window back, the menu plays, skips and quits.
//! With «закрывать в трей» on, the window's close button hides it and the music keeps going.
//! The UI owns the player, so menu actions go to it as `tray` events.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};

const TRAY_ID: &str = "main";
/// Hide on close instead of quitting. On by default: a music app keeps playing in the tray.
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);
/// Set when «Выход» is chosen, so the close that follows really quits.
static QUITTING: AtomicBool = AtomicBool::new(false);

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Открыть C1PH0N1C", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Играть / пауза", true, None::<&str>)?;
    let previous = MenuItem::with_id(app, "previous", "Назад", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Дальше", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let separator = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&show, &separator()?, &toggle, &previous, &next, &separator()?, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("C1PH0N1C")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_window(app),
            "quit" => {
                QUITTING.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            action @ ("toggle" | "previous" | "next") => {
                let _ = app.emit("tray", action);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows().into_values().find(|w| w.label() == "main")
}

/// Brings the main window back from the tray or from behind other windows.
pub fn show_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Window close button: hide to the tray when that is on.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == "main" && CLOSE_TO_TRAY.load(Ordering::SeqCst) && !QUITTING.load(Ordering::SeqCst) {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

#[tauri::command]
pub fn set_close_to_tray(on: bool) {
    CLOSE_TO_TRAY.store(on, Ordering::SeqCst);
}

/// The tray tooltip shows what is playing.
#[tauri::command]
pub fn set_tray_track(app: AppHandle, title: Option<String>) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let text = match title {
            Some(t) if !t.is_empty() => format!("C1PH0N1C\n{}", t.chars().take(110).collect::<String>()),
            _ => "C1PH0N1C".to_owned(),
        };
        let _ = tray.set_tooltip(Some(text));
    }
}

/// «Выход» from the UI (and the updater): quit even with «закрывать в трей» on.
pub fn quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}
