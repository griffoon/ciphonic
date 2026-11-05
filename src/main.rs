#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod auth;
mod lyrics;
mod player;
mod stream;
mod wave;

use player::Player;

use auth::Session;
use tauri::{AppHandle, Emitter, Manager};

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
async fn resolve_stream(track_id: String, quality: String) -> Result<stream::StreamSource, String> {
    let token = auth::stored_token()?.ok_or("Нужен вход")?;
    stream::resolve(&token, &track_id, stream::Quality::parse(&quality)).await
}

/// Resolves the stream, loads it into the player and starts it. Returns what is playing.
#[tauri::command]
async fn play_track(app: AppHandle, track_id: String, quality: String) -> Result<stream::StreamSource, String> {
    let token = auth::stored_token()?.ok_or("Нужен вход")?;
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
    let (token, uid) = signed_in().await?;
    api::play_audio(
        &token,
        &uid,
        &api::Listen {
            track_id: &track_id,
            album_id: album_id.as_deref(),
            duration_ms,
            from: &from,
            play_id: &play_id,
            played,
            position,
        },
    )
    .await
}

#[tauri::command]
fn set_playing(app: AppHandle, playing: bool) {
    app.state::<Player>().set_playing(playing);
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
    app.emit("session-changed", Option::<Session>::None)
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Opening the audio device can fail (no output); that is a startup error, not a crash later.
            app.manage(Player::start()?);
            app.manage(wave::Wave::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            current_session,
            start_login,
            login_with_token,
            logout,
            liked_tracks,
            playlists,
            search,
            resolve_stream,
            play_track,
            set_playing,
            seek,
            playback_status,
            report_listen,
            wave::wave_start,
            wave::wave_more,
            wave::wave_feedback,
            lyrics::get_lyrics
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Волна");
}
