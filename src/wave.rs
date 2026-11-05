//! My Wave: the rotor session and the feedback that teaches it. Mirrors WaveSession.swift.
//! Every event the listener causes goes to the server, or the wave cannot learn.

use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::api::{self, BAD_RESPONSE};
use crate::auth;
use crate::models::{self, TrackView};

/// `from` the mobile app's My Wave reports; plays marked with it count for the wave.
pub const WAVE_FROM: &str = "radio-mobile-user-onyourwave";
const MY_WAVE_SEED: &str = "user:onyourwave";
/// The server only needs the recent tail of what was played to avoid repeats.
const QUEUE_MEMORY: usize = 30;
/// How many character options the Wave screen offers.
const CHARACTER_COUNT: usize = 4;
const NOT_STARTED: &str = "Волна не запущена";

#[derive(Default)]
pub struct WaveState {
    session_id: Option<String>,
    batch_id: Option<String>,
    batches: u32,
    /// Track refs (`id:albumId`) of tracks that started, oldest first.
    played: Vec<String>,
}

impl WaveState {
    /// HUD line like `sess#3fa1 | batch 02`.
    fn tag(&self) -> Option<String> {
        let id = self.session_id.as_ref()?;
        let short: String = id.chars().filter(char::is_ascii_hexdigit).take(4).collect::<String>().to_lowercase();
        let short = if short.is_empty() { "0000".to_owned() } else { short };
        Some(format!("sess#{short} | batch {:02}", self.batches))
    }
}

pub type Wave = Mutex<WaveState>;

#[derive(Serialize, Clone, Debug)]
pub struct WaveBatch {
    pub tracks: Vec<TrackView>,
    pub tag: Option<String>,
}

/// A "diversity" option the server offers for My Wave (the character chips).
#[derive(Serialize, Clone, Debug)]
pub struct Character {
    pub name: String,
    pub seed: Option<String>,
    pub unspecified: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct LastWave {
    pub name: Option<String>,
    pub seeds: Vec<String>,
}

fn lock(wave: &Wave) -> MutexGuard<'_, WaveState> {
    wave.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn token() -> Result<String, String> {
    auth::stored_token()?.ok_or_else(|| "Нужен вход".into())
}

/// Starts a session and returns its first batch. No seeds means My Wave.
#[tauri::command]
pub async fn wave_start(app: AppHandle, seeds: Option<Vec<String>>) -> Result<WaveBatch, String> {
    let token = token()?;
    let seeds = seeds.filter(|s| !s.is_empty()).unwrap_or_else(|| vec![MY_WAVE_SEED.to_owned()]);
    let body = json!({ "seeds": seeds, "queue": [], "includeTracksInResponse": true });
    let result = api::post_json(&token, "rotor/session/new", &body).await?;
    let session_id = result.get("radioSessionId").and_then(Value::as_str).ok_or(BAD_RESPONSE)?.to_owned();
    let batch_id = result.get("batchId").and_then(Value::as_str).map(str::to_owned);

    let tag = {
        let wave = app.state::<Wave>();
        let mut state = lock(&wave);
        *state = WaveState { session_id: Some(session_id.clone()), batch_id: batch_id.clone(), batches: 1, played: Vec::new() };
        state.tag()
    };
    let event = json!({ "type": "radioStarted", "timestamp": api::iso_now() });
    if let Err(e) = feedback(&token, &session_id, batch_id.as_deref(), event, Some(WAVE_FROM)).await {
        // The wave still plays without the report; the next event may land.
        eprintln!("[wave] radioStarted: {e}");
    }
    Ok(WaveBatch { tracks: models::sequence_tracks(&result), tag })
}

/// The next batch, seeded with the recent tail of what was played.
#[tauri::command]
pub async fn wave_more(app: AppHandle) -> Result<WaveBatch, String> {
    let token = token()?;
    let (session_id, queue) = {
        let wave = app.state::<Wave>();
        let state = lock(&wave);
        (state.session_id.clone().ok_or(NOT_STARTED)?, tail(&state.played))
    };
    let result =
        api::post_json(&token, &format!("rotor/session/{session_id}/tracks"), &json!({ "queue": queue })).await?;
    let tag = {
        let wave = app.state::<Wave>();
        let mut state = lock(&wave);
        if let Some(batch) = result.get("batchId").and_then(Value::as_str) {
            state.batch_id = Some(batch.to_owned());
        }
        state.batches += 1;
        state.tag()
    };
    Ok(WaveBatch { tracks: models::sequence_tracks(&result), tag })
}

/// `kind` is one of trackStarted, trackFinished, skip, like, dislike.
#[tauri::command]
pub async fn wave_feedback(
    app: AppHandle,
    kind: String,
    track_id: String,
    album_id: Option<String>,
    played: f64,
) -> Result<(), String> {
    let token = token()?;
    let (session_id, batch_id) = {
        let wave = app.state::<Wave>();
        let state = lock(&wave);
        (state.session_id.clone().ok_or(NOT_STARTED)?, state.batch_id.clone())
    };
    let timestamp = api::iso_now();
    let event = match kind.as_str() {
        "trackStarted" | "like" | "dislike" => json!({ "type": kind, "timestamp": timestamp, "trackId": track_id }),
        "trackFinished" | "skip" => json!({
            "type": kind,
            "timestamp": timestamp,
            "trackId": track_id,
            "totalPlayedSeconds": (played * 10.0).round() / 10.0,
        }),
        _ => return Err("Неизвестное событие волны".into()),
    };
    if kind == "trackStarted" {
        let track_ref = match album_id {
            Some(album) => format!("{track_id}:{album}"),
            None => track_id.clone(),
        };
        let wave = app.state::<Wave>();
        lock(&wave).played.push(track_ref);
    }
    feedback(&token, &session_id, batch_id.as_deref(), event, None).await
}

/// Character quick-picks for My Wave (the server's "diversity" options).
#[tauri::command]
pub async fn wave_characters() -> Result<Vec<Character>, String> {
    let token = token()?;
    let settings = api::get(&token, "rotor/wave/settings").await?;
    Ok(settings
        .pointer("/settingRestrictions/diversity/possibleValues")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|option| {
            Some(Character {
                name: models::text_field(option, "name")?,
                seed: models::text_field(option, "serializedSeed"),
                unspecified: option.get("unspecified").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .take(CHARACTER_COUNT)
        .collect())
}

/// The wave this account played last on any device, when it is not plain My Wave.
#[tauri::command]
pub async fn wave_last() -> Result<Option<LastWave>, String> {
    let token = token()?;
    let last = api::get(&token, "rotor/wave/last").await?;
    let seeds: Vec<String> = last
        .get("seeds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str().map(str::to_owned))
        .collect();
    if seeds.is_empty() || seeds == [MY_WAVE_SEED] {
        return Ok(None);
    }
    Ok(Some(LastWave { name: models::text_field(&last, "name"), seeds }))
}

async fn feedback(
    token: &str,
    session_id: &str,
    batch_id: Option<&str>,
    event: Value,
    from: Option<&str>,
) -> Result<(), String> {
    let mut body = json!({ "event": event });
    if let Some(batch) = batch_id {
        body["batchId"] = json!(batch);
    }
    if let Some(from) = from {
        body["from"] = json!(from);
    }
    api::post_json(token, &format!("rotor/session/{session_id}/feedback"), &body).await?;
    Ok(())
}

fn tail(played: &[String]) -> Vec<String> {
    played[played.len().saturating_sub(QUEUE_MEMORY)..].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_memory_keeps_only_recent_tail() {
        let played: Vec<String> = (0..40).map(|i| i.to_string()).collect();
        let kept = tail(&played);
        assert_eq!(kept.len(), QUEUE_MEMORY);
        assert_eq!(kept.first().map(String::as_str), Some("10"));
        assert_eq!(kept.last().map(String::as_str), Some("39"));
    }

    #[test]
    fn short_history_is_kept_whole() {
        let played = vec!["a".to_string(), "b".to_string()];
        assert_eq!(tail(&played), played);
    }

    #[test]
    fn tag_uses_hex_of_session_and_batch_count() {
        let state = WaveState { session_id: Some("Zx3F-a1b2".into()), batches: 2, ..Default::default() };
        assert_eq!(state.tag().as_deref(), Some("sess#3fa1 | batch 02"));
    }
}
