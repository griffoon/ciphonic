#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analysis;
mod api;
mod auth;
mod catalog;
mod lyrics;
mod media;
mod models;
mod player;
mod stream;
mod wave;

use auth::Session;
use player::Player;
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
async fn current_session() -> Result<Option<Session>, String> {
    auth::current_session().await
}

/// Resolves the stream, loads it into the player and starts it. Returns what is playing.
#[tauri::command]
async fn play_track(app: AppHandle, track_id: String, quality: String) -> Result<stream::StreamSource, String> {
    let (token, _) = auth::account().await?;
    let source = stream::resolve(&token, &track_id, stream::Quality::parse(&quality)).await?;
    let input = if source.local {
        player::Source::File(source.location.clone().into())
    } else {
        let data = api::download_bytes(&source.location).await?;
        player::Source::Bytes { data, ext: stream::extension(&source.codec).to_owned() }
    };
    app.state::<Player>().load(input)?;
    Ok(source)
}

/// Reports a listen to play-audio. The start report has played 0; the end report has the seconds heard.
#[tauri::command]
async fn report_listen(
    track_id: String,
    album_id: Option<String>,
    duration_ms: u64,
    from: String,
    play_id: String,
    played: f64,
    position: f64,
) -> Result<(), String> {
    let (token, uid) = auth::account().await?;
    let listen = api::Listen {
        track_id: &track_id,
        album_id: album_id.as_deref(),
        duration_ms,
        from: &from,
        play_id: &play_id,
        played,
        position,
    };
    api::play_audio(&token, &uid, &listen).await
}

#[tauri::command]
fn set_playing(app: AppHandle, playing: bool) {
    app.state::<Player>().set_playing(playing);
}

#[tauri::command]
fn set_volume(app: AppHandle, volume: f32) {
    app.state::<Player>().set_volume(volume);
}

#[tauri::command]
fn seek(app: AppHandle, seconds: f64) -> Result<(), String> {
    app.state::<Player>().seek(seconds)
}

#[tauri::command]
fn playback_status(app: AppHandle) -> player::Status {
    app.state::<Player>().status()
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
    app.state::<Player>().stop()?;
    app.emit("session-changed", Option::<Session>::None).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Opening the audio device can fail (no output); that is a startup error, not a crash later.
            app.manage(Player::start()?);
            app.manage(wave::Wave::default());
            analysis::start(app.handle().clone());
            if let Err(e) = media::init(app.handle()) {
                eprintln!("[media] no media keys: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            current_session,
            start_login,
            login_with_token,
            logout,
            play_track,
            set_playing,
            set_volume,
            seek,
            playback_status,
            report_listen,
            catalog::liked_tracks,
            catalog::playlists,
            catalog::playlist_tracks,
            catalog::album,
            catalog::artist,
            catalog::search,
            catalog::search_suggest,
            catalog::set_like,
            catalog::dislike,
            catalog::cover_data,
            wave::wave_start,
            wave::wave_more,
            wave::wave_feedback,
            wave::wave_characters,
            wave::wave_last,
            lyrics::get_lyrics,
            media::media_update
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Волна");
}
