//! Windows System Media Transport Controls: media keys, the now-playing flyout and the lock screen.
//! Play/pause/seek go straight to the player; "next" goes to the UI, which owns the queue.

use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig};
use tauri::{AppHandle, Emitter, Manager};

use crate::player::Player;

/// How often the flyout's play state and position are checked against the player.
const SYNC_EVERY: Duration = Duration::from_millis(500);
/// A position this far from where it should be means a seek; the flyout gets the new one.
const SEEK_JUMP: f64 = 1.5;

pub struct Media(Mutex<MediaControls>);

fn lock(media: &Media) -> MutexGuard<'_, MediaControls> {
    media.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Hooks SMTC to the main window. Failure only means no media keys; the app keeps working.
pub fn init(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("нет главного окна")?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let config = PlatformConfig {
        dbus_name: "ciphonic",
        display_name: "C1PH0N1C",
        hwnd: Some(hwnd.0 as *mut std::ffi::c_void),
    };
    let mut controls = MediaControls::new(config).map_err(|e| format!("{e:?}"))?;
    let handle = app.clone();
    controls
        .attach(move |event| on_event(&handle, event))
        .map_err(|e| format!("{e:?}"))?;
    app.manage(Media(Mutex::new(controls)));
    spawn_sync(app.clone());
    Ok(())
}

fn on_event(app: &AppHandle, event: MediaControlEvent) {
    let player = app.state::<Player>();
    let result = match event {
        MediaControlEvent::Play => Ok(player.set_playing(true)),
        MediaControlEvent::Pause | MediaControlEvent::Stop => Ok(player.set_playing(false)),
        MediaControlEvent::Toggle => Ok(player.set_playing(!player.is_playing())),
        MediaControlEvent::Next => app.emit("media-next", ()).map_err(|e| e.to_string()),
        MediaControlEvent::Previous => player.seek(0.0),
        MediaControlEvent::SetPosition(MediaPosition(position)) => player.seek(position.as_secs_f64()),
        _ => Ok(()),
    };
    if let Err(e) = result {
        eprintln!("[media] {e}");
    }
}

/// Track info for the flyout. Called by the UI when a track starts.
#[tauri::command]
pub fn media_update(
    app: AppHandle,
    title: String,
    artist: String,
    cover: Option<String>,
    duration_ms: u64,
) -> Result<(), String> {
    let Some(media) = app.try_state::<Media>() else {
        return Ok(());
    };
    let result = lock(&media).set_metadata(MediaMetadata {
        title: Some(&title),
        artist: Some(&artist),
        album: None,
        cover_url: cover.as_deref(),
        duration: Some(Duration::from_millis(duration_ms)),
    });
    result.map_err(|e| format!("{e:?}"))
}

/// Keeps the flyout's play state and position in step with the player, without spamming it:
/// it is updated on play/pause and on seeks, not on every tick.
fn spawn_sync(app: AppHandle) {
    let spawned = thread::Builder::new().name("volna-media".into()).spawn(move || {
        let mut last: Option<(bool, f64, Instant)> = None;
        loop {
            thread::sleep(SYNC_EVERY);
            let status = app.state::<Player>().status();
            let changed = match last {
                None => true,
                Some((was_playing, was_position, at)) => {
                    let expected = if was_playing { was_position + at.elapsed().as_secs_f64() } else { was_position };
                    was_playing != status.playing || (status.position - expected).abs() > SEEK_JUMP
                }
            };
            if !changed {
                continue;
            }
            let progress = Some(MediaPosition(Duration::from_secs_f64(status.position.max(0.0))));
            let playback = if status.playing {
                MediaPlayback::Playing { progress }
            } else {
                MediaPlayback::Paused { progress }
            };
            if let Some(media) = app.try_state::<Media>() {
                if let Err(e) = lock(&media).set_playback(playback) {
                    eprintln!("[media] playback: {e:?}");
                }
            }
            last = Some((status.playing, status.position, Instant::now()));
        }
    });
    if let Err(e) = spawned {
        eprintln!("[media] thread: {e}");
    }
}
