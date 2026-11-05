//! Library, search and catalogue pages: what the Collection and Search tabs show.
//! Each command is a port of the matching YMClient.swift call.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::Value;

use crate::api::{self, BAD_RESPONSE};
use crate::auth;
use crate::models::{self, AlbumView, ArtistView, PlaylistView, TrackView};

/// `POST /tracks` accepts a limited batch per call.
const TRACK_BATCH: usize = 200;
/// Hosts covers come from; the cover proxy refuses anything else.
const COVER_HOST_SUFFIX: &str = ".yandex.net";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub tracks: Vec<TrackView>,
    pub artists: Vec<ArtistView>,
    pub albums: Vec<AlbumView>,
    pub playlists: Vec<PlaylistView>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AlbumPage {
    pub album: AlbumView,
    pub tracks: Vec<TrackView>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ArtistPage {
    pub artist: ArtistView,
    pub popular: Vec<TrackView>,
    pub albums: Vec<AlbumView>,
}

/// Full tracks for `id:albumId` refs, fetched in batches.
async fn tracks_by_refs(token: &str, refs: &[String]) -> Result<Vec<TrackView>, String> {
    let mut tracks = Vec::with_capacity(refs.len());
    for chunk in refs.chunks(TRACK_BATCH) {
        let batch = api::post_form(token, "tracks", &[("track-ids", chunk.join(","))]).await?;
        tracks.extend(models::list(Some(&batch), models::track_view));
    }
    Ok(tracks)
}

/// "Мне нравится", newest first as Yandex returns them.
#[tauri::command]
pub async fn liked_tracks() -> Result<Vec<TrackView>, String> {
    let (token, uid) = auth::account().await?;
    let library = api::get(&token, &format!("users/{uid}/likes/tracks")).await?;
    let shorts = library.pointer("/library/tracks").and_then(Value::as_array).ok_or(BAD_RESPONSE)?;
    tracks_by_refs(&token, &models::short_refs(shorts)).await
}

#[tauri::command]
pub async fn playlists() -> Result<Vec<PlaylistView>, String> {
    let (token, uid) = auth::account().await?;
    let list = api::get(&token, &format!("users/{uid}/playlists/list")).await?;
    Ok(models::list(Some(&list), models::playlist_view))
}

/// Tracks of any playlist, by its `ownerUid:kind` id. Embedded tracks are used when complete.
#[tauri::command]
pub async fn playlist_tracks(id: String) -> Result<Vec<TrackView>, String> {
    let (owner, kind) = id.split_once(':').ok_or("Неверный плейлист")?;
    let (token, _) = auth::account().await?;
    let playlist = api::get(&token, &format!("users/{owner}/playlists/{kind}")).await?;
    let shorts = playlist.get("tracks").and_then(Value::as_array).cloned().unwrap_or_default();
    let embedded: Vec<TrackView> = shorts.iter().filter_map(|s| s.get("track")).filter_map(models::track_view).collect();
    if embedded.len() == shorts.len() {
        return Ok(embedded);
    }
    tracks_by_refs(&token, &models::short_refs(&shorts)).await
}

#[tauri::command]
pub async fn album(id: String) -> Result<AlbumPage, String> {
    let (token, _) = auth::account().await?;
    let result = api::get(&token, &format!("albums/{id}/with-tracks")).await?;
    let album = models::album_view(&result).ok_or(BAD_RESPONSE)?;
    let tracks = result
        .get("volumes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|volume| models::list(Some(volume), models::track_view))
        .collect();
    Ok(AlbumPage { album, tracks })
}

#[tauri::command]
pub async fn artist(id: String) -> Result<ArtistPage, String> {
    let (token, _) = auth::account().await?;
    let brief = api::get(&token, &format!("artists/{id}/brief-info")).await?;
    let artist = brief.get("artist").and_then(models::artist_view).ok_or(BAD_RESPONSE)?;
    let mut albums = models::list(brief.get("albums"), models::album_view);
    albums.extend(models::list(brief.get("alsoAlbums"), models::album_view));
    Ok(ArtistPage {
        artist,
        popular: models::list(brief.get("popularTracks"), models::track_view),
        albums,
    })
}

#[tauri::command]
pub async fn search(text: String) -> Result<SearchResult, String> {
    let (token, _) = auth::account().await?;
    let result = api::get_query(
        &token,
        "search",
        &[("text", text.trim()), ("type", "all"), ("page", "0"), ("nocorrect", "false")],
    )
    .await?;
    Ok(SearchResult {
        tracks: models::list(result.pointer("/tracks/results"), models::track_view),
        artists: models::list(result.pointer("/artists/results"), models::artist_view),
        albums: models::list(result.pointer("/albums/results"), models::album_view),
        playlists: models::list(result.pointer("/playlists/results"), models::playlist_view),
    })
}

#[tauri::command]
pub async fn search_suggest(part: String) -> Result<Vec<String>, String> {
    let (token, _) = auth::account().await?;
    let result = api::get_query(&token, "search/suggest", &[("part", part.trim())]).await?;
    Ok(result
        .get("suggestions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str().map(str::to_owned))
        .collect())
}

fn track_ref(track_id: &str, album_id: Option<&str>) -> String {
    match album_id {
        Some(album) => format!("{track_id}:{album}"),
        None => track_id.to_owned(),
    }
}

/// Adds to or removes from «Мне нравится».
#[tauri::command]
pub async fn set_like(track_id: String, album_id: Option<String>, liked: bool) -> Result<(), String> {
    let (token, uid) = auth::account().await?;
    let action = if liked { "add-multiple" } else { "remove" };
    api::post_form(
        &token,
        &format!("users/{uid}/likes/tracks/{action}"),
        &[("track-ids", track_ref(&track_id, album_id.as_deref()))],
    )
    .await?;
    Ok(())
}

/// «Не рекомендовать»: the track goes to dislikes and stops showing up in recommendations.
#[tauri::command]
pub async fn dislike(track_id: String, album_id: Option<String>) -> Result<(), String> {
    let (token, uid) = auth::account().await?;
    api::post_form(
        &token,
        &format!("users/{uid}/dislikes/tracks/add-multiple"),
        &[("track-ids", track_ref(&track_id, album_id.as_deref()))],
    )
    .await?;
    Ok(())
}

/// A cover as a data URL, so the canvas and WebGL can read its pixels (the CDN sends no CORS
/// headers). Only Yandex cover hosts are fetched.
#[tauri::command]
pub async fn cover_data(url: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    let host_ok = parsed.scheme() == "https"
        && parsed.host_str().is_some_and(|host| host.ends_with(COVER_HOST_SUFFIX));
    if !host_ok {
        return Err("Обложка не с Яндекса".into());
    }
    let bytes = api::download_bytes(parsed.as_str()).await?;
    let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) { "image/png" } else { "image/jpeg" };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_ref_adds_album_when_known() {
        assert_eq!(track_ref("1", Some("2")), "1:2");
        assert_eq!(track_ref("1", None), "1");
    }
}
