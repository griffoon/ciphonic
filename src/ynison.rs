//! Ynison: Yandex's live "what plays where" sync between the account's devices (Ynison.swift).
//! We join as a remote controller: we see other devices and what they play, can pause and skip
//! them, and the UI can pull their track over here.
//!
//! Wire format: two websockets. The redirector hands out a host and a ticket; the state socket
//! then streams `PutYnisonStateResponse` frames as protobuf-JSON (camelCase, int64 as strings).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use crate::auth;

const REDIRECT_URL: &str = "wss://ynison.music.yandex.ru/redirector.YnisonRedirectService/GetRedirectToYnison";
const STATE_PATH: &str = "ynison_state.YnisonStateService/PutYnisonState";
const DEVICE_TITLE: &str = "Волна (Windows)";
const PING_EVERY: Duration = Duration::from_secs(20);
const RETRY_AFTER: Duration = Duration::from_secs(10);

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub app_name: String,
    pub is_offline: bool,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Playable {
    pub track_id: String,
    pub album_id: Option<String>,
    pub title: String,
    pub cover_url: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// "idle", "connecting", "connected" or "failed: …".
    pub status: String,
    pub devices: Vec<Device>,
    pub active_device_id: Option<String>,
    pub queue: Vec<Playable>,
    pub current_index: i64,
    pub paused: bool,
    pub progress_ms: f64,
    pub duration_ms: f64,
    /// When the frame arrived (epoch ms), so the UI can extrapolate progress while playing.
    pub received_at_ms: i64,
}

#[derive(Default)]
struct Inner {
    snapshot: Snapshot,
    /// Last raw player state, cloned when sending commands so nothing we don't model is lost.
    raw_player_state: Value,
    out: Option<mpsc::UnboundedSender<String>>,
    device_id: String,
}

#[derive(Default)]
pub struct Ynison {
    inner: Mutex<Inner>,
    started: AtomicBool,
}

impl Ynison {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn rid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn version(device_id: &str) -> Value {
    let random = (uuid::Uuid::new_v4().as_u128() as u64) % 999_999_999_999_999_999 + 1;
    json!({ "deviceId": device_id, "version": random.to_string(), "timestampMs": now_ms().to_string() })
}

/// Stable per install, so reconnects don't add new devices to the account.
fn device_id(app: &AppHandle) -> String {
    let path = app.path().app_local_data_dir().ok().map(|dir| dir.join("ynison_device_id"));
    if let Some(saved) = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()) {
        let saved = saved.trim().to_owned();
        if !saved.is_empty() {
            return saved;
        }
    }
    let fresh: String = uuid::Uuid::new_v4().simple().to_string().chars().take(12).collect();
    if let Some(path) = path {
        let _ = path.parent().map(std::fs::create_dir_all);
        let _ = std::fs::write(path, &fresh);
    }
    fresh
}

/// Percent-encodes everything but letters and digits (Swift's `.alphanumerics`).
fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

struct Redirect {
    host: String,
    ticket: String,
    session_id: String,
}

/// Auth goes in a header; device identity rides in the websocket subprotocol list.
fn request(
    url: &str,
    token: &str,
    device_id: &str,
    redirect: Option<&Redirect>,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    let mut info = json!({
        "Ynison-Device-Id": device_id,
        "Ynison-Device-Info": json!({ "app_name": DEVICE_TITLE, "type": "1" }).to_string(),
    });
    if let Some(r) = redirect {
        info["Ynison-Redirect-Ticket"] = json!(r.ticket);
        info["Ynison-Session-Id"] = json!(r.session_id);
    }
    let mut req = url.into_client_request().map_err(|e| e.to_string())?;
    let headers = req.headers_mut();
    let header = |v: String| HeaderValue::from_str(&v).map_err(|e| e.to_string());
    headers.insert("Origin", header("https://music.yandex.ru".into())?);
    headers.insert("Authorization", header(format!("OAuth {token}"))?);
    headers.insert("Sec-WebSocket-Protocol", header(format!("Bearer, v2, {}", encode(&info.to_string())))?);
    Ok(req)
}

fn text(json: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| match json.get(*k)? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

fn number(json: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|k| match json.get(*k)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    })
}

fn server_error(error: &Value) -> String {
    match number(error, &["http_code", "httpCode"]).unwrap_or(0.0) as i64 {
        401 | 403 => "unauthorized".into(),
        code => format!("http {code}"),
    }
}

async fn fetch_redirect(token: &str, device_id: &str) -> Result<Redirect, String> {
    let (mut socket, _) = tokio_tungstenite::connect_async(request(REDIRECT_URL, token, device_id, None)?)
        .await
        .map_err(|e| e.to_string())?;
    let frame = loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => break text.to_string(),
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(e.to_string()),
            None => return Err("redirector closed".into()),
        }
    };
    let _ = socket.close(None).await;
    let json: Value = serde_json::from_str(&frame).map_err(|e| e.to_string())?;
    if let Some(error) = json.get("error") {
        return Err(server_error(error));
    }
    Ok(Redirect {
        host: text(&json, &["host"]).ok_or("no host")?,
        ticket: text(&json, &["redirectTicket", "redirect_ticket"]).ok_or("no ticket")?,
        session_id: text(&json, &["sessionId", "session_id"]).ok_or("no session")?,
    })
}

fn full_state_request(device_id: &str) -> Value {
    let zero = json!({ "deviceId": device_id, "version": "0", "timestampMs": "0" });
    json!({
        "updateFullState": {
            "playerState": {
                "playerQueue": {
                    "currentPlayableIndex": -1, "entityId": "", "entityType": "VARIOUS",
                    "entityContext": "BASED_ON_ENTITY_BY_DEFAULT", "fromOptional": "",
                    "options": { "repeatMode": "NONE" }, "version": zero,
                },
                "status": { "paused": true, "playbackSpeed": 1, "progressMs": "0", "durationMs": "0", "version": zero },
            },
            "device": {
                "capabilities": { "canBePlayer": false, "canBeRemoteController": true, "volumeGranularity": 0 },
                "info": { "deviceId": device_id, "type": "WEB", "title": DEVICE_TITLE, "appName": "yandex-music" },
                "volumeInfo": { "volume": 0 },
            },
            "isCurrentlyActive": false,
        },
        "rid": rid(),
        "playerActionTimestampMs": "0",
        "activityInterceptionType": "DO_NOT_INTERCEPT_BY_DEFAULT",
    })
}

fn wrap(mut update: Value) -> Value {
    update["rid"] = json!(rid());
    update["playerActionTimestampMs"] = json!(now_ms().to_string());
    update["activityInterceptionType"] = json!("DO_NOT_INTERCEPT_BY_DEFAULT");
    update
}

/// Folds one state frame into the snapshot. Returns the raw player state when the frame had one.
fn apply_frame(snapshot: &mut Snapshot, frame: &Value, own_id: &str) -> Option<Value> {
    snapshot.received_at_ms = now_ms();
    if let Some(devices) = frame.get("devices").and_then(Value::as_array) {
        snapshot.devices = devices
            .iter()
            .filter_map(|device| {
                let info = device.get("info").cloned().unwrap_or_default();
                let id = text(&info, &["deviceId", "device_id"])?;
                (id != own_id).then(|| Device {
                    id,
                    title: text(&info, &["title"]).unwrap_or_else(|| "Устройство".into()),
                    kind: text(&info, &["type"]).unwrap_or_default(),
                    app_name: text(&info, &["appName", "app_name"]).unwrap_or_default(),
                    is_offline: device.get("isOffline").and_then(Value::as_bool).unwrap_or(false),
                })
            })
            .collect();
    }
    snapshot.active_device_id = text(frame, &["activeDeviceIdOptional", "active_device_id_optional"]);
    let state = frame.get("playerState").or_else(|| frame.get("player_state"))?;
    let queue = state.get("playerQueue").or_else(|| state.get("player_queue")).cloned().unwrap_or_default();
    let list = queue.get("playableList").or_else(|| queue.get("playable_list")).and_then(Value::as_array).cloned().unwrap_or_default();
    snapshot.queue = list
        .iter()
        .filter_map(|item| {
            Some(Playable {
                track_id: text(item, &["playableId", "playable_id"])?,
                album_id: text(item, &["albumIdOptional", "album_id_optional"]),
                title: text(item, &["title"]).unwrap_or_default(),
                cover_url: text(item, &["coverUrlOptional", "cover_url_optional"]).map(|c| {
                    let sized = c.replace("%%", "200x200");
                    if sized.starts_with("http") { sized } else { format!("https://{sized}") }
                }),
            })
        })
        .collect();
    snapshot.current_index = number(&queue, &["currentPlayableIndex", "current_playable_index"]).map_or(-1, |n| n as i64);
    let status = state.get("status").cloned().unwrap_or_default();
    snapshot.paused = status.get("paused").and_then(Value::as_bool).unwrap_or(true);
    snapshot.progress_ms = number(&status, &["progressMs", "progress_ms"]).unwrap_or(0.0);
    snapshot.duration_ms = number(&status, &["durationMs", "duration_ms"]).unwrap_or(0.0);
    Some(state.clone())
}

fn publish(app: &AppHandle) {
    let snapshot = app.state::<Ynison>().lock().snapshot.clone();
    let _ = app.emit("ynison", snapshot);
}

fn set_status(app: &AppHandle, status: &str) {
    app.state::<Ynison>().lock().snapshot.status = status.to_owned();
    publish(app);
}

async fn run_once(app: &AppHandle) -> Result<(), String> {
    let (token, _) = auth::account().await?;
    let device_id = device_id(app);
    app.state::<Ynison>().lock().device_id = device_id.clone();
    set_status(app, "connecting");
    let redirect = fetch_redirect(&token, &device_id).await?;
    let url = format!("wss://{}/{}", redirect.host, STATE_PATH);
    let (socket, _) = tokio_tungstenite::connect_async(request(&url, &token, &device_id, Some(&redirect))?)
        .await
        .map_err(|e| e.to_string())?;
    let (mut write, mut read) = socket.split();
    write.send(Message::Text(full_state_request(&device_id).to_string().into())).await.map_err(|e| e.to_string())?;
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    app.state::<Ynison>().lock().out = Some(tx);
    set_status(app, "connected");

    let mut ping = tokio::time::interval(PING_EVERY);
    loop {
        tokio::select! {
            frame = read.next() => match frame {
                Some(Ok(Message::Text(text))) => {
                    let Ok(json) = serde_json::from_str::<Value>(&text) else { continue };
                    if let Some(error) = json.get("error") {
                        return Err(server_error(error));
                    }
                    {
                        let ynison = app.state::<Ynison>();
                        let mut inner = ynison.lock();
                        let own = inner.device_id.clone();
                        if let Some(raw) = apply_frame(&mut inner.snapshot, &json, &own) {
                            inner.raw_player_state = raw;
                        }
                    }
                    publish(app);
                }
                Some(Ok(Message::Close(_))) | None => return Ok(()),
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(e.to_string()),
            },
            outgoing = rx.recv() => if let Some(text) = outgoing {
                write.send(Message::Text(text.into())).await.map_err(|e| e.to_string())?;
            },
            _ = ping.tick() => {
                write.send(Message::Ping(Vec::new().into())).await.map_err(|e| e.to_string())?;
            }
        }
    }
}

/// Starts the connection loop once; it reconnects after drops and waits while signed out.
#[tauri::command]
pub fn ynison_start(app: AppHandle) {
    if app.state::<Ynison>().started.swap(true, Ordering::SeqCst) {
        publish(&app);
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            let result = run_once(&app).await;
            app.state::<Ynison>().lock().out = None;
            match result {
                Ok(()) => set_status(&app, "idle"),
                Err(e) => set_status(&app, &format!("failed: {}", e.to_lowercase())),
            }
            tokio::time::sleep(RETRY_AFTER).await;
        }
    });
}

#[tauri::command]
pub fn ynison_snapshot(app: AppHandle) -> Snapshot {
    app.state::<Ynison>().lock().snapshot.clone()
}

fn send(app: &AppHandle, update: Value) -> Result<(), String> {
    let out = app.state::<Ynison>().lock().out.clone().ok_or("Ynison не подключён")?;
    out.send(wrap(update).to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ynison_pause(app: AppHandle, paused: bool) -> Result<(), String> {
    let (status, device) = {
        let ynison = app.state::<Ynison>();
        let inner = ynison.lock();
        let s = &inner.snapshot;
        let elapsed = if s.paused { 0.0 } else { (now_ms() - s.received_at_ms) as f64 };
        let progress = (s.progress_ms + elapsed).min(s.duration_ms.max(0.0));
        (json!({ "progressMs": (progress as i64).to_string(), "durationMs": (s.duration_ms as i64).to_string(),
                 "paused": paused, "playbackSpeed": 1 }), inner.device_id.clone())
    };
    let mut status = status;
    status["version"] = version(&device);
    send(&app, json!({ "updatePlayingStatus": { "playingStatus": status } }))
}

/// Moves the other device's queue by `delta` tracks.
#[tauri::command]
pub fn ynison_skip(app: AppHandle, delta: i64) -> Result<(), String> {
    let update = {
        let ynison = app.state::<Ynison>();
        let inner = ynison.lock();
        let target = inner.snapshot.current_index + delta;
        if target < 0 || target as usize >= inner.snapshot.queue.len() {
            return Ok(());
        }
        let raw = &inner.raw_player_state;
        let mut queue = raw.get("playerQueue").or_else(|| raw.get("player_queue")).cloned().unwrap_or_else(|| json!({}));
        if let Some(map) = queue.as_object_mut() {
            map.remove("current_playable_index");
        }
        queue["currentPlayableIndex"] = json!(target);
        queue["version"] = version(&inner.device_id);
        let status = json!({ "progressMs": "0", "durationMs": "0", "paused": inner.snapshot.paused,
                             "playbackSpeed": 1, "version": version(&inner.device_id) });
        json!({ "updatePlayerState": { "playerState": { "playerQueue": queue, "status": status } } })
    };
    send(&app, update)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Talks to the real redirector with a bad token: the handshake must get as far as the
    /// server's answer (an auth error), not fail on our side. Needs network, so not run by default.
    #[test]
    #[ignore]
    fn redirector_handshake_reaches_the_server() {
        let result = tauri::async_runtime::block_on(fetch_redirect("bad-token", "probe0000000"));
        println!("redirector: {:?}", result.as_ref().map(|r| &r.host));
        let err = result.err().unwrap_or_default();
        assert!(!err.to_lowercase().contains("subprotocol"), "handshake failed on our side: {err}");
    }

    #[test]
    fn encode_keeps_only_alphanumerics() {
        assert_eq!(encode("a b:{1}"), "a%20b%3A%7B1%7D");
    }

    #[test]
    fn frame_fills_devices_queue_and_status_skipping_ourselves() {
        let frame = json!({
            "devices": [
                { "info": { "device_id": "me", "title": "Волна" } },
                { "info": { "deviceId": "pc", "title": "ПК", "type": "WEB", "appName": "yandex-music" }, "isOffline": false }
            ],
            "activeDeviceIdOptional": "pc",
            "playerState": {
                "playerQueue": { "currentPlayableIndex": "1", "playableList": [
                    { "playableId": "1", "title": "A" },
                    { "playableId": "2", "albumIdOptional": "9", "title": "B", "coverUrlOptional": "avatars.yandex.net/x/%%" }
                ]},
                "status": { "paused": false, "progressMs": "15000", "durationMs": "200000" }
            }
        });
        let mut snapshot = Snapshot::default();
        assert!(apply_frame(&mut snapshot, &frame, "me").is_some());
        assert_eq!(snapshot.devices.len(), 1);
        assert_eq!(snapshot.current_index, 1);
        assert_eq!(snapshot.queue[1].cover_url.as_deref(), Some("https://avatars.yandex.net/x/200x200"));
        assert!(!snapshot.paused);
        assert_eq!(snapshot.progress_ms, 15000.0);
    }
}
