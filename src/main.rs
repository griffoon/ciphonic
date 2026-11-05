#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod auth;

use auth::Session;
use tauri::{AppHandle, Emitter};

#[tauri::command]
async fn current_session() -> Result<Option<Session>, String> {
    auth::current_session().await
}

#[tauri::command]
fn start_login(app: AppHandle) -> Result<(), String> {
    auth::open_login(&app)
}

#[tauri::command]
fn logout(app: AppHandle) -> Result<(), String> {
    auth::forget_token()?;
    app.emit("session-changed", Option::<Session>::None)
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![current_session, start_login, logout])
        .run(tauri::generate_context!())
        .expect("failed to run Волна");
}
