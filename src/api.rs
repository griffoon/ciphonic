//! Thin client over the unofficial api.music.yandex.net endpoints.

use std::sync::OnceLock;

use serde::Serialize;
use serde_json::Value;

use crate::auth::Session;

/// Error string for a rejected token; the caller decides what to do with it.
pub const UNAUTHORIZED: &str = "unauthorized";
const BASE_URL: &str = "https://api.music.yandex.net";
/// Client header of the Android app, the one the music API expects.
const CLIENT_HEADER: &str = "YandexMusicAndroid/24023621";
/// Desktop client header, needed by get-file-info (the signature is checked against it).
const DESKTOP_CLIENT: &str = "YandexMusicDesktopAppWindows/5.95.0";
const BAD_RESPONSE: &str = "Непонятный ответ сервера";

/// A track as the UI shows it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrackView {
    pub id: String,
    pub title: String,
    pub artists: String,
    pub duration_ms: u64,
    pub cover: Option<String>,
}

/// A playlist as the UI shows it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistView {
    pub id: String,
    pub title: String,
    pub track_count: u64,
    pub cover: Option<String>,
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Fetches `account/status` and turns it into a session. Fails with UNAUTHORIZED on a bad token.
pub async fn verify(token: &str) -> Result<Session, String> {
    let result = get(token, "account/status").await?;
    let account = result.get("account").ok_or(BAD_RESPONSE)?;
    let uid = id_string(account.get("uid").ok_or(BAD_RESPONSE)?).ok_or(BAD_RESPONSE)?;
    Ok(Session {
        uid,
        login: text_field(account, "login"),
        display_name: text_field(account, "displayName"),
    })
}

/// Tracks the user liked, newest first as Yandex returns them.
pub async fn liked_tracks(token: &str, uid: &str) -> Result<Vec<TrackView>, String> {
    let library = get(token, &format!("users/{uid}/likes/tracks")).await?;
    let shorts = library.pointer("/library/tracks").and_then(Value::as_array).ok_or(BAD_RESPONSE)?;
    // Yandex wants "id:albumId" refs for tracks that belong to an album.
    let refs: Vec<String> = shorts
        .iter()
        .filter_map(|short| {
            let id = id_string(short.get("id")?)?;
            Some(match short.get("albumId").and_then(id_string) {
                Some(album) => format!("{id}:{album}"),
                None => id,
            })
        })
        .collect();
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let tracks = post_form(token, "tracks", &[("track-ids", refs.join(","))]).await?;
    Ok(tracks.as_array().ok_or(BAD_RESPONSE)?.iter().filter_map(track_view).collect())
}

/// The user's playlists, skipping the service ones that have no kind.
pub async fn playlists(token: &str, uid: &str) -> Result<Vec<PlaylistView>, String> {
    let list = get(token, &format!("users/{uid}/playlists/list")).await?;
    Ok(list
        .as_array()
        .ok_or(BAD_RESPONSE)?
        .iter()
        .filter_map(|playlist| {
            let owner = id_string(playlist.get("uid")?)?;
            let kind = id_string(playlist.get("kind")?)?;
            Some(PlaylistView {
                id: format!("{owner}:{kind}"),
                title: text_field(playlist, "title")?,
                track_count: playlist.get("trackCount").and_then(Value::as_u64).unwrap_or(0),
                cover: cover_url(playlist.pointer("/cover/uri").and_then(Value::as_str)),
            })
        })
        .collect())
}

/// Track hits for a text query. Artists and albums come later with their own screens.
pub async fn search(token: &str, text: &str) -> Result<Vec<TrackView>, String> {
    let result = get_query(
        token,
        "search",
        &[("text", text), ("type", "all"), ("page", "0"), ("nocorrect", "false")],
    )
    .await?;
    Ok(result
        .pointer("/tracks/results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(track_view)
        .collect())
}

fn track_view(track: &Value) -> Option<TrackView> {
    let id = id_string(track.get("id")?)?;
    let title = text_field(track, "title")?;
    let artists = track
        .get("artists")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|a| text_field(a, "name")).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    let album_cover = track.pointer("/albums/0/coverUri").and_then(Value::as_str);
    let cover = cover_url(track.get("coverUri").and_then(Value::as_str).or(album_cover));
    Some(TrackView {
        id,
        title,
        artists,
        duration_ms: track.get("durationMs").and_then(Value::as_u64).unwrap_or(0),
        cover,
    })
}

/// Yandex covers are templates like `avatars.../%%`; ask for a 200px square.
fn cover_url(uri: Option<&str>) -> Option<String> {
    uri.filter(|u| !u.is_empty()).map(|u| format!("https://{}", u.replace("%%", "200x200")))
}

fn id_string(value: &Value) -> Option<String> {
    match value {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

async fn get(token: &str, path: &str) -> Result<Value, String> {
    get_query(token, path, &[]).await
}

async fn get_query(token: &str, path: &str, query: &[(&str, &str)]) -> Result<Value, String> {
    get_as(token, path, query, CLIENT_HEADER).await
}

/// GET as the desktop app: some signed endpoints only accept its client header.
pub async fn desktop_get(token: &str, path: &str, query: &[(&str, &str)]) -> Result<Value, String> {
    get_as(token, path, query, DESKTOP_CLIENT).await
}

async fn get_as(token: &str, path: &str, query: &[(&str, &str)], client: &str) -> Result<Value, String> {
    let request = http().get(format!("{BASE_URL}/{path}")).query(query);
    send(token, request, client).await
}

async fn post_form(token: &str, path: &str, form: &[(&str, String)]) -> Result<Value, String> {
    let request = http().post(format!("{BASE_URL}/{path}")).form(form);
    send(token, request, CLIENT_HEADER).await
}

/// Track download-info: the list of stream variants (mp3 is the legacy path).
pub async fn download_info(token: &str, track_id: &str) -> Result<Value, String> {
    get(token, &format!("tracks/{track_id}/download-info")).await
}

/// Raw bytes from a CDN link; no token, the links are already signed.
pub async fn download_bytes(url: &str) -> Result<Vec<u8>, String> {
    let response = http().get(url).send().await.map_err(|e| format!("Нет связи с сервером: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Сервер ответил {}", response.status().as_u16()));
    }
    response.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

pub async fn download_text(url: &str) -> Result<String, String> {
    let bytes = download_bytes(url).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn send(token: &str, request: reqwest::RequestBuilder, client: &str) -> Result<Value, String> {
    let response = request
        .header("Authorization", format!("OAuth {token}"))
        .header("X-Yandex-Music-Client", client)
        .header("Accept-Language", "ru")
        .send()
        .await
        .map_err(|e| format!("Нет связи с сервером: {e}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(UNAUTHORIZED.into());
    }
    if !status.is_success() {
        return Err(format!("Сервер ответил {}", status.as_u16()));
    }
    let body: Value = response.json().await.map_err(|e| e.to_string())?;
    body.get("result").cloned().ok_or_else(|| BAD_RESPONSE.into())
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}
