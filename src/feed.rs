//! What sits under the Wave hero (HomeSections.swift): generated playlists, feed events,
//! new releases and the chart. A section that fails comes back empty and is hidden.

use serde::Serialize;
use serde_json::Value;

use crate::api;
use crate::auth;
use crate::models::{self, AlbumView, ArtistView, PlaylistView, TrackView};

/// How much of each feed to show before it turns into noise.
const MAX_EVENTS: usize = 4;
const MAX_RELEASES: usize = 15;
const CHART_LENGTH: usize = 100;

#[derive(Serialize, Clone, Debug)]
pub struct FeedEvent {
    pub title: Option<String>,
    pub tracks: Vec<TrackView>,
    pub albums: Vec<AlbumView>,
    pub artists: Vec<ArtistView>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HomeFeed {
    pub generated: Vec<PlaylistView>,
    pub events: Vec<FeedEvent>,
    pub releases: Vec<AlbumView>,
    /// Every new release id, for the paged full list.
    pub release_ids: Vec<String>,
    pub chart: Vec<TrackView>,
}

/// Title is either a plain string or a list of `{type, text}` runs.
fn event_title(event: &Value) -> Option<String> {
    match event.get("title")? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Array(runs) => {
            let joined: String = runs.iter().filter_map(|r| r.get("text").and_then(Value::as_str)).collect();
            (!joined.is_empty()).then_some(joined)
        }
        _ => None,
    }
}

fn feed_event(event: &Value) -> Option<FeedEvent> {
    let albums = event
        .get("albums")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("album").and_then(models::album_view))
        .collect::<Vec<_>>();
    let artists = event
        .get("artists")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("artist").and_then(models::artist_view))
        .collect::<Vec<_>>();
    let tracks = models::list(event.get("tracks"), models::track_view);
    if albums.is_empty() && tracks.is_empty() && artists.is_empty() {
        return None;
    }
    Some(FeedEvent { title: event_title(event), tracks, albums, artists })
}

fn parse_feed(feed: &Value) -> (Vec<PlaylistView>, Vec<FeedEvent>) {
    let generated = feed
        .get("generatedPlaylists")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|g| g.get("ready").and_then(Value::as_bool) != Some(false))
        .filter_map(|g| g.get("data").and_then(models::playlist_view))
        .collect();
    // Yandex sometimes sends the same block twice; keep the first of each title.
    let mut seen = std::collections::HashSet::new();
    let events = feed
        .get("days")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|day| day.get("events").and_then(Value::as_array).cloned().unwrap_or_default())
        .filter_map(|e| feed_event(&e))
        .filter(|e| seen.insert(e.title.clone().unwrap_or_default().to_lowercase()))
        .take(MAX_EVENTS)
        .collect();
    (generated, events)
}

pub async fn albums_by_ids(token: &str, ids: &[String]) -> Result<Vec<AlbumView>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let result = api::post_form(token, "albums", &[("album-ids", ids.join(","))]).await?;
    Ok(models::list(Some(&result), models::album_view))
}

#[tauri::command]
pub async fn home_feed() -> Result<HomeFeed, String> {
    let (token, _) = auth::account().await?;
    let (feed, releases, chart) = tokio::join!(
        api::get(&token, "feed"),
        api::get(&token, "landing3/new-releases"),
        api::get(&token, "landing3/chart"),
    );
    let (generated, events) = feed.as_ref().map(parse_feed).unwrap_or_default();
    let release_ids: Vec<String> = releases
        .ok()
        .and_then(|r| r.get("newReleases").cloned())
        .and_then(|ids| ids.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(models::id_string)
        .collect();
    let first: Vec<String> = release_ids.iter().take(MAX_RELEASES).cloned().collect();
    let releases = albums_by_ids(&token, &first).await.unwrap_or_default();
    let chart = chart
        .ok()
        .and_then(|c| c.pointer("/chart/tracks").cloned())
        .and_then(|t| t.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| entry.get("track").and_then(models::track_view))
        .take(CHART_LENGTH)
        .collect();
    Ok(HomeFeed { generated, events, releases, release_ids, chart })
}

/// A page of albums by id (the full "Новые релизы" list loads page by page).
#[tauri::command]
pub async fn albums(ids: Vec<String>) -> Result<Vec<AlbumView>, String> {
    let (token, _) = auth::account().await?;
    albums_by_ids(&token, &ids).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn title_runs_are_joined() {
        let event = json!({ "title": [{ "text": "Новое " }, { "text": "у артистов" }] });
        assert_eq!(event_title(&event).as_deref(), Some("Новое у артистов"));
    }

    #[test]
    fn duplicate_event_titles_are_dropped_and_empty_events_skipped() {
        let track = json!({ "id": 1, "title": "T" });
        let feed = json!({
            "generatedPlaylists": [
                { "ready": true, "data": { "uid": 1, "kind": 2, "title": "Дейли" } },
                { "ready": false, "data": { "uid": 1, "kind": 3, "title": "Не готов" } }
            ],
            "days": [{ "events": [
                { "title": "А это слышали?", "tracks": [track] },
                { "title": "а это слышали?", "tracks": [track] },
                { "title": "Пусто" }
            ]}]
        });
        let (generated, events) = parse_feed(&feed);
        assert_eq!(generated.len(), 1);
        assert_eq!(events.len(), 1);
    }
}
