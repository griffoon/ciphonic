#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analysis;
mod api;
mod auth;
mod catalog;
mod eq;
mod extras;
mod feed;
mod lyrics;
mod media;
mod models;
mod player;
mod stream;
mod wave;
mod ynison;

use std::sync::Mutex;

use auth::Session;
use player::Player;
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
async fn current_session() -> Result<Option<Session>, String> {
    auth::current_session().await
}

/// A track resolved and downloaded ahead of time, so switching to it starts at once.
struct Prepared {
    track_id: String,
    quality: String,
    source: stream::StreamSource,
    input: player::Source,
}

#[derive(Default)]
struct Preloaded(Mutex<Option<Prepared>>);

/// Stream link plus the audio itself: a decrypted temp file, or the bytes of a direct link.
async fn prepare(track_id: &str, quality: &str) -> Result<(stream::StreamSource, player::Source), String> {
    let (token, _) = auth::account().await?;
    let source = stream::resolve(&token, track_id, stream::Quality::parse(quality)).await?;
    let input = if source.local {
        player::Source::File(source.location.clone().into())
    } else {
        let data = api::download_bytes(&source.location).await?;
        player::Source::Bytes { data, ext: stream::extension(&source.codec).to_owned() }
    };
    Ok((source, input))
}

fn lock_preloaded(app: &AppHandle) -> std::sync::MutexGuard<'_, Option<Prepared>> {
    app.state::<Preloaded>().inner().0.lock().unwrap_or_else(|p| p.into_inner())
}

/// Resolves the stream (or takes the preloaded one), loads it into the player and starts it.
#[tauri::command]
async fn play_track(app: AppHandle, track_id: String, quality: String) -> Result<stream::StreamSource, String> {
    let ready = {
        let mut slot = lock_preloaded(&app);
        match slot.take() {
            Some(p) if p.track_id == track_id && p.quality == quality => Some(p),
            other => {
                *slot = other;
                None
            }
        }
    };
    let (source, input) = match ready {
        Some(prepared) => (prepared.source, prepared.input),
        None => prepare(&track_id, &quality).await?,
    };
    app.state::<Player>().load(input)?;
    Ok(source)
}

/// Gets the next track ready while this one plays (PlayerEngine.preloadNext).
#[tauri::command]
async fn preload_track(app: AppHandle, track_id: String, quality: String) -> Result<(), String> {
    if lock_preloaded(&app).as_ref().is_some_and(|p| p.track_id == track_id && p.quality == quality) {
        return Ok(());
    }
    let (source, input) = prepare(&track_id, &quality).await?;
    *lock_preloaded(&app) = Some(Prepared { track_id, quality, source, input });
    Ok(())
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
fn set_eq(app: AppHandle, gains: Vec<f32>) {
    app.state::<Player>().set_eq(&gains);
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
            app.manage(Preloaded::default());
            app.manage(ynison::Ynison::default());
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
            preload_track,
            set_playing,
            set_volume,
            set_eq,
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
            feed::home_feed,
            feed::albums,
            catalog::tracks,
            catalog::artist_tracks,
            catalog::liked_artist_ids,
            catalog::set_artist_like,
            ynison::ynison_start,
            ynison::ynison_snapshot,
            ynison::ynison_pause,
            ynison::ynison_skip,
            extras::history,
            extras::similar_tracks,
            extras::credits,
            extras::find_clip,
            extras::open_url,
            extras::playlist_page,
            extras::create_playlist,
            extras::rename_playlist,
            extras::set_playlist_public,
            extras::delete_playlist,
            extras::add_to_playlist,
            extras::remove_from_playlist,
            wave::wave_start,
            wave::wave_more,
            wave::wave_feedback,
            wave::wave_characters,
            wave::wave_last,
            wave::wave_settings,
            lyrics::get_lyrics,
            media::media_update
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Волна");
}
