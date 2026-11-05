//! History, similar tracks, credits, clips and playlist editing (HistoryView.swift,
//! SimilarTracksView, TrackAboutView, ClipFinder.swift, PlaylistView editing, AddToPlaylistView).

use serde::Serialize;
use serde_json::{json, Value};

use crate::api::{self, BAD_RESPONSE};
use crate::auth;
use crate::models::{self, TrackView};

/// What was played from: an album, a playlist, an artist or a wave (RecentContext).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentContext {
    pub id: String,
    /// "album", "playlist", "artist" or "wave".
    pub kind: String,
    pub title: String,
    pub cover: Option<String>,
    /// Album or artist id, or `uid:kind` of a playlist.
    pub target_id: Option<String>,
    pub seeds: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct HistoryGroup {
    pub context: Option<RecentContext>,
    pub tracks: Vec<TrackView>,
}

#[derive(Serialize, Clone, Debug)]
pub struct HistoryDay {
    pub date: Option<String>,
    pub groups: Vec<HistoryGroup>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Credit {
    pub title: String,
    pub value: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistPage {
    pub tracks: Vec<TrackView>,
    pub revision: Option<u64>,
    pub visibility: Option<String>,
    pub owner_uid: String,
}

/// A clip for the track: a real video link, or a YouTube search to try.
#[derive(Serialize, Clone, Debug)]
pub struct Clip {
    pub url: String,
    pub found: bool,
}


fn recent_context(item: &Value) -> Option<RecentContext> {
    let kind = item.get("type").and_then(Value::as_str)?;
    let model = item.pointer("/data/fullModel");
    match kind {
        "album" => {
            let album = models::album_view(model?)?;
            Some(RecentContext {
                id: format!("album-{}", album.id), kind: kind.into(), title: album.title, cover: album.cover,
                target_id: Some(album.id), seeds: Vec::new(),
            })
        }
        "playlist" => {
            let playlist = models::playlist_view(model?)?;
            Some(RecentContext {
                id: format!("playlist-{}", playlist.id), kind: kind.into(), title: playlist.title, cover: playlist.cover,
                target_id: Some(playlist.id), seeds: Vec::new(),
            })
        }
        "artist" => {
            let artist = models::artist_view(model?)?;
            Some(RecentContext {
                id: format!("artist-{}", artist.id), kind: kind.into(), title: artist.name, cover: artist.cover,
                target_id: Some(artist.id), seeds: Vec::new(),
            })
        }
        "wave" => {
            let seeds: Vec<String> = item
                .pointer("/data/itemId/seeds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect();
            if seeds.is_empty() {
                return None;
            }
            let name = model
                .and_then(|m| models::text_field(m, "name").or_else(|| models::text_field(m, "title")))
                .unwrap_or_else(|| "Волна".into());
            Some(RecentContext {
                id: format!("wave-{}", seeds.join(",")), kind: kind.into(), title: name, cover: None,
                target_id: None, seeds,
            })
        }
        _ => None,
    }
}

fn history_days(result: &Value) -> Vec<HistoryDay> {
    result
        .get("historyTabs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|day| HistoryDay {
            date: models::text_field(day, "date"),
            groups: day
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|group| HistoryGroup {
                    context: group.get("context").and_then(recent_context),
                    tracks: group
                        .get("tracks")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter(|t| t.get("type").and_then(Value::as_str) == Some("track"))
                        .filter_map(|t| t.pointer("/data/fullModel").and_then(models::track_view))
                        .collect(),
                })
                .filter(|g| g.context.is_some() || !g.tracks.is_empty())
                .collect(),
        })
        .filter(|d| !d.groups.is_empty())
        .collect()
}

/// Listening history, newest day first, grouped by what each run was played from.
#[tauri::command]
pub async fn history() -> Result<Vec<HistoryDay>, String> {
    let (token, _) = auth::account().await?;
    let result = api::get_query(&token, "music-history", &[("fullModelsCount", "100")]).await?;
    Ok(history_days(&result))
}

#[tauri::command]
pub async fn similar_tracks(track_id: String) -> Result<Vec<TrackView>, String> {
    let (token, _) = auth::account().await?;
    let result = api::get(&token, &format!("tracks/{track_id}/similar")).await?;
    Ok(models::list(result.get("similarTracks"), models::track_view))
}

/// Writers, producers and the like, as Yandex lists them.
#[tauri::command]
pub async fn credits(track_id: String) -> Result<Vec<Credit>, String> {
    let (token, _) = auth::account().await?;
    let result = api::get(&token, &format!("tracks/{track_id}/credits")).await?;
    Ok(result
        .get("credits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| Some(Credit { title: models::text_field(c, "title")?, value: models::text_field(c, "value")? }))
        .collect())
}

/// The track's video from its supplement (YouTube or Vimeo), else a YouTube search.
#[tauri::command]
pub async fn find_clip(track_id: String, artist: String, title: String) -> Result<Clip, String> {
    let (token, _) = auth::account().await?;
    if let Ok(supplement) = api::get(&token, &format!("tracks/{track_id}/supplement")).await {
        let videos = supplement.get("videos").and_then(Value::as_array).cloned().unwrap_or_default();
        for video in videos {
            if let Some(url) = video_link(&video) {
                return Ok(Clip { url, found: true });
            }
        }
    }
    let mut search = reqwest::Url::parse("https://www.youtube.com/results").map_err(|e| e.to_string())?;
    search.query_pairs_mut().append_pair("search_query", &format!("{artist} {title}"));
    Ok(Clip { url: search.into(), found: false })
}

fn video_link(video: &Value) -> Option<String> {
    if let Some(url) = models::text_field(video, "url").filter(|u| u.starts_with("http")) {
        return Some(url);
    }
    let id = models::text_field(video, "providerVideoId")?;
    match models::text_field(video, "provider")?.to_lowercase().as_str() {
        "youtube" => Some(format!("https://youtu.be/{id}")),
        "vimeo" => Some(format!("https://vimeo.com/{id}")),
        _ => None,
    }
}

/// Opens a link (a video, an artist's profile, concert tickets) in the default browser.
/// Only https: no plain http, files or custom schemes.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    let allowed = parsed.scheme() == "https" && parsed.host_str().is_some_and(|h| !h.is_empty());
    if !allowed {
        return Err("Эту ссылку открыть нельзя".into());
    }
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", parsed.as_str()])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ---------- playlists ----------

/// Tracks of any playlist plus what editing needs (its revision and owner).
#[tauri::command]
pub async fn playlist_page(id: String) -> Result<PlaylistPage, String> {
    let (owner, kind) = id.split_once(':').ok_or("Неверный плейлист")?;
    let (token, _) = auth::account().await?;
    let playlist = api::get(&token, &format!("users/{owner}/playlists/{kind}")).await?;
    let shorts = playlist.get("tracks").and_then(Value::as_array).cloned().unwrap_or_default();
    let embedded: Vec<TrackView> = shorts.iter().filter_map(|s| s.get("track")).filter_map(models::track_view).collect();
    let tracks = if embedded.len() == shorts.len() {
        embedded
    } else {
        crate::catalog::tracks_by_refs(&token, &models::short_refs(&shorts)).await?
    };
    Ok(PlaylistPage {
        tracks,
        revision: playlist.get("revision").and_then(Value::as_u64),
        visibility: models::text_field(&playlist, "visibility"),
        owner_uid: owner.to_owned(),
    })
}

#[tauri::command]
pub async fn create_playlist(title: String, public: bool) -> Result<models::PlaylistView, String> {
    let (token, uid) = auth::account().await?;
    let visibility = if public { "public" } else { "private" };
    let result = api::post_form(
        &token,
        &format!("users/{uid}/playlists/create"),
        &[("title", title.trim().to_owned()), ("visibility", visibility.to_owned())],
    )
    .await?;
    models::playlist_view(&result).ok_or_else(|| BAD_RESPONSE.into())
}

fn own_kind(id: &str, uid: &str) -> Result<String, String> {
    match id.split_once(':') {
        Some((owner, kind)) if owner == uid => Ok(kind.to_owned()),
        _ => Err("Это не твой плейлист".into()),
    }
}

#[tauri::command]
pub async fn rename_playlist(id: String, title: String) -> Result<(), String> {
    let (token, uid) = auth::account().await?;
    let kind = own_kind(&id, &uid)?;
    api::post_form(&token, &format!("users/{uid}/playlists/{kind}/name"), &[("value", title.trim().to_owned())]).await?;
    Ok(())
}

#[tauri::command]
pub async fn set_playlist_public(id: String, public: bool) -> Result<(), String> {
    let (token, uid) = auth::account().await?;
    let kind = own_kind(&id, &uid)?;
    let value = if public { "public" } else { "private" };
    api::post_form(&token, &format!("users/{uid}/playlists/{kind}/visibility"), &[("value", value.to_owned())]).await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_playlist(id: String) -> Result<(), String> {
    let (token, uid) = auth::account().await?;
    let kind = own_kind(&id, &uid)?;
    api::post_form(&token, &format!("users/{uid}/playlists/{kind}/delete"), &[]).await?;
    Ok(())
}

/// Puts the track first in one of the user's playlists.
#[tauri::command]
pub async fn add_to_playlist(id: String, track_id: String, album_id: Option<String>) -> Result<(), String> {
    let (token, uid) = auth::account().await?;
    let kind = own_kind(&id, &uid)?;
    let current = api::get(&token, &format!("users/{uid}/playlists/{kind}")).await?;
    let revision = current.get("revision").and_then(Value::as_u64).unwrap_or(1);
    let mut item = json!({ "id": track_id });
    if let Some(album) = album_id {
        item["albumId"] = json!(album);
    }
    let diff = json!([{ "op": "insert", "at": 0, "tracks": [item] }]).to_string();
    api::post_form(
        &token,
        &format!("users/{uid}/playlists/{kind}/change-relative"),
        &[("diff", diff), ("revision", revision.to_string())],
    )
    .await?;
    Ok(())
}

/// Removes the track at `index`; `revision` must be the playlist's current one. Returns the new one.
#[tauri::command]
pub async fn remove_from_playlist(id: String, index: u64, revision: u64) -> Result<Option<u64>, String> {
    let (token, uid) = auth::account().await?;
    let kind = own_kind(&id, &uid)?;
    let diff = json!([{ "op": "delete", "from": index, "to": index + 1 }]).to_string();
    let updated = api::post_form(
        &token,
        &format!("users/{uid}/playlists/{kind}/change"),
        &[("kind", kind.clone()), ("revision", revision.to_string()), ("diff", diff)],
    )
    .await?;
    Ok(updated.get("revision").and_then(Value::as_u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_groups_contexts_and_tracks() {
        let result = json!({ "historyTabs": [{ "date": "2026-11-05", "items": [{
            "context": { "type": "wave", "data": { "itemId": { "seeds": ["user:onyourwave"] }, "fullModel": { "name": "Моя волна" } } },
            "tracks": [
                { "type": "track", "data": { "fullModel": { "id": 1, "title": "Song" } } },
                { "type": "track", "data": {} }
            ]
        }]}]});
        let days = history_days(&result);
        assert_eq!(days.len(), 1);
        let group = &days[0].groups[0];
        assert_eq!(group.context.as_ref().map(|c| c.title.as_str()), Some("Моя волна"));
        assert_eq!(group.tracks.len(), 1);
    }

    #[test]
    fn video_link_prefers_url_then_provider() {
        assert_eq!(video_link(&json!({ "provider": "YouTube", "providerVideoId": "abc" })).as_deref(), Some("https://youtu.be/abc"));
        assert_eq!(video_link(&json!({ "url": "https://vimeo.com/1" })).as_deref(), Some("https://vimeo.com/1"));
        assert!(video_link(&json!({ "provider": "other", "providerVideoId": "x" })).is_none());
    }

    #[test]
    fn only_own_playlists_are_editable() {
        assert_eq!(own_kind("42:3", "42").unwrap(), "3");
        assert!(own_kind("7:3", "42").is_err());
    }

    #[test]
    fn open_url_refuses_anything_but_https() {
        assert!(open_url("http://youtube.com/x".into()).is_err());
        assert!(open_url("file:///C:/Windows/notepad.exe".into()).is_err());
        assert!(open_url("javascript:alert(1)".into()).is_err());
    }
}
