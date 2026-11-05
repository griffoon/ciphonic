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
#[serde(rename_all = "camelCase")]
pub struct ArtistPage {
    pub artist: ArtistView,
    pub popular: Vec<TrackView>,
    /// The artist's own releases, newest first (direct-albums by year).
    pub albums: Vec<AlbumView>,
    /// Compilations and features.
    pub also_albums: Vec<AlbumView>,
    pub similar: Vec<ArtistView>,
    pub description: Option<String>,
    pub monthly_listeners: Option<u64>,
    pub likes_count: Option<u64>,
    pub photos: Vec<String>,
    pub links: Vec<ArtistLink>,
    pub concerts: Vec<Concert>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ArtistLink {
    pub title: String,
    pub url: String,
    /// youtube, vk, telegram, instagram, x, tiktok or site.
    pub kind: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Concert {
    pub title: Option<String>,
    pub city: Option<String>,
    pub place: Option<String>,
    /// As Yandex sends it, e.g. `2026-12-05T19:00:00+03:00`.
    pub datetime: Option<String>,
    pub afisha_url: Option<String>,
}

fn link_kind(network: &str, url: &str) -> (&'static str, Option<&'static str>) {
    let n = network.to_lowercase();
    let u = url.to_lowercase();
    let has = |a: &str, b: &str| n.contains(a) || u.contains(b);
    if has("youtube", "youtu") { ("youtube", Some("YouTube")) }
    else if has("vk", "vk.com") { ("vk", Some("ВКонтакте")) }
    else if has("telegram", "t.me") { ("telegram", Some("Telegram")) }
    else if has("instagram", "instagram") { ("instagram", Some("Instagram")) }
    else if has("twitter", "twitter") || u.contains("x.com") { ("x", Some("X")) }
    else if has("tiktok", "tiktok") { ("tiktok", Some("TikTok")) }
    else { ("site", None) }
}

fn artist_links(artist: &Value) -> Vec<ArtistLink> {
    artist
        .get("links")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|link| {
            let url = models::text_field(link, "href").filter(|u| u.starts_with("http"))?;
            let network = models::text_field(link, "socialNetwork").or_else(|| models::text_field(link, "type")).unwrap_or_default();
            let (kind, title) = link_kind(&network, &url);
            let title = title.map(str::to_owned).or_else(|| models::text_field(link, "title")).unwrap_or_else(|| url.clone());
            Some(ArtistLink { title, url, kind: kind.into() })
        })
        .collect()
}

/// Description is either a string or `{ text }`.
fn description(about: &Value) -> Option<String> {
    match about.get("description")? {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        other => other.get("text").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned),
    }
}

/// Full tracks for `id:albumId` refs, fetched in batches.
pub async fn tracks_by_refs(token: &str, refs: &[String]) -> Result<Vec<TrackView>, String> {
    let mut tracks = Vec::with_capacity(refs.len());
    for chunk in refs.chunks(TRACK_BATCH) {
        let batch = api::post_form(token, "tracks", &[("track-ids", chunk.join(","))]).await?;
        tracks.extend(models::list(Some(&batch), models::track_view));
    }
    Ok(tracks)
}

/// Full tracks for `id` or `id:albumId` refs (pulling another device's queue over here).
#[tauri::command]
pub async fn tracks(refs: Vec<String>) -> Result<Vec<TrackView>, String> {
    let (token, _) = auth::account().await?;
    tracks_by_refs(&token, &refs).await
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

/// Everything the artist page shows; the extras (bio, discography, concerts) are best effort.
#[tauri::command]
pub async fn artist(id: String) -> Result<ArtistPage, String> {
    let (token, _) = auth::account().await?;
    let (brief_path, info_path) = (format!("artists/{id}/brief-info"), format!("artists/{id}/info"));
    let (albums_path, concerts_path) = (format!("artists/{id}/direct-albums"), format!("artists/{id}/concerts"));
    let (brief, about, direct, concerts) = tokio::join!(
        api::get(&token, &brief_path),
        api::get(&token, &info_path),
        api::get_query(&token, &albums_path, &[("page", "0"), ("page-size", "100"), ("sort-by", "year")]),
        api::get(&token, &concerts_path),
    );
    let brief = brief?;
    let raw_artist = brief.get("artist").ok_or(BAD_RESPONSE)?;
    let artist = models::artist_view(raw_artist).ok_or(BAD_RESPONSE)?;
    let about = about.ok();
    let direct_albums = direct.ok().map(|d| models::list(d.get("albums"), models::album_view)).unwrap_or_default();
    let photos = brief
        .get("allCovers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| models::cover_url(c.get("uri").and_then(Value::as_str)))
        .collect();
    Ok(ArtistPage {
        popular: models::list(brief.get("popularTracks"), models::track_view),
        albums: if direct_albums.is_empty() { models::list(brief.get("albums"), models::album_view) } else { direct_albums },
        also_albums: models::list(brief.get("alsoAlbums"), models::album_view),
        similar: models::list(brief.get("similarArtists"), models::artist_view),
        description: about.as_ref().and_then(description),
        monthly_listeners: about
            .as_ref()
            .and_then(|a| a.pointer("/stats/lastMonthListeners"))
            .or_else(|| brief.pointer("/stats/lastMonthListeners"))
            .and_then(Value::as_u64),
        likes_count: raw_artist.get("likesCount").and_then(Value::as_u64),
        photos,
        links: artist_links(raw_artist),
        concerts: concerts
            .ok()
            .and_then(|c| c.get("concerts").cloned())
            .and_then(|c| c.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .map(|c| Concert {
                title: models::text_field(c, "concertTitle"),
                city: models::text_field(c, "city"),
                place: models::text_field(c, "place"),
                datetime: models::text_field(c, "datetime"),
                afisha_url: models::text_field(c, "afishaUrl").filter(|u| u.starts_with("http")),
            })
            .collect(),
        artist,
    })
}

/// Up to 300 of the artist's tracks, for «ИГРАТЬ» (shuffled all, not just the popular ten).
#[tauri::command]
pub async fn artist_tracks(id: String) -> Result<Vec<TrackView>, String> {
    let (token, _) = auth::account().await?;
    let page = api::get_query(&token, &format!("artists/{id}/tracks"), &[("page-size", "300")]).await?;
    Ok(models::list(page.get("tracks"), models::track_view))
}

/// Ids of artists the user follows («Подписаться» is a like on the artist).
#[tauri::command]
pub async fn liked_artist_ids() -> Result<Vec<String>, String> {
    let (token, uid) = auth::account().await?;
    let likes = api::get_query(&token, &format!("users/{uid}/likes/artists"), &[("with-timestamps", "false")]).await?;
    Ok(likes
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| l.pointer("/artist/id").or_else(|| l.get("id")).and_then(models::id_string))
        .collect())
}

#[tauri::command]
pub async fn set_artist_like(artist_id: String, liked: bool) -> Result<(), String> {
    let (token, uid) = auth::account().await?;
    let action = if liked { "add-multiple" } else { "remove" };
    api::post_form(&token, &format!("users/{uid}/likes/artists/{action}"), &[("artist-ids", artist_id)]).await?;
    Ok(())
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
    fn links_get_network_names_and_description_reads_both_shapes() {
        let artist = serde_json::json!({ "links": [
            { "href": "https://t.me/x", "type": "social" },
            { "href": "https://example.org", "title": "Сайт" },
            { "href": "not a url" }
        ]});
        let links = artist_links(&artist);
        assert_eq!(links.len(), 2);
        assert_eq!((links[0].title.as_str(), links[0].kind.as_str()), ("Telegram", "telegram"));
        assert_eq!(links[1].title, "Сайт");
        assert_eq!(description(&serde_json::json!({ "description": { "text": " Био " } })).as_deref(), Some("Био"));
        assert_eq!(description(&serde_json::json!({ "description": "" })), None);
    }

    #[test]
    fn track_ref_adds_album_when_known() {
        assert_eq!(track_ref("1", Some("2")), "1:2");
        assert_eq!(track_ref("1", None), "1");
    }
}
