#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod auth;

use auth::Session;
use tauri::{AppHandle, Emitter};

#[tauri::command]
async fn current_session() -> Result<Option<Session>, String> {
    auth::current_session().await
}

/// Token plus uid for the calls that need the account.
async fn signed_in() -> Result<(String, String), String> {
    let token = auth::stored_token()?.ok_or("Нужен вход")?;
    let session = api::verify(&token).await?;
    Ok((token, session.uid))
}

#[tauri::command]
async fn liked_tracks() -> Result<Vec<api::TrackView>, String> {
    let (token, uid) = signed_in().await?;
    api::liked_tracks(&token, &uid).await
}

#[tauri::command]
async fn playlists() -> Result<Vec<api::PlaylistView>, String> {
    let (token, uid) = signed_in().await?;
    api::playlists(&token, &uid).await
}

#[tauri::command]
async fn search(text: String) -> Result<Vec<api::TrackView>, String> {
    let token = auth::stored_token()?.ok_or("Нужен вход")?;
    api::search(&token, text.trim()).await
}

#[tauri::command]
async fn login_with_token(token: String) -> Result<Session, String> {
    auth::login_with_token(token.trim()).await
}

/// Async on purpose: a sync command runs on the main thread, and creating a webview there
/// blocks the event loop on Windows. The login page then never loads and the window won't close.
#[tauri::command]
async fn start_login(app: AppHandle) -> Result<(), String> {
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
        .invoke_handler(tauri::generate_handler![
            current_session,
            start_login,
            login_with_token,
            logout,
            liked_tracks,
            playlists,
            search
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Волна");
}
