//! What the UI gets: compact, lenient views of Yandex JSON. A missing field never fails a whole
//! list; an item without the essentials is skipped (like `Lenient` in Models.swift).

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ArtistRef {
    pub id: String,
    pub name: String,
}

/// A track as the UI shows it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrackView {
    pub id: String,
    pub title: String,
    pub version: Option<String>,
    /// Display line, "A, B".
    pub artists: String,
    pub artist_list: Vec<ArtistRef>,
    pub album_id: Option<String>,
    pub album_title: Option<String>,
    pub duration_ms: u64,
    pub cover: Option<String>,
    pub available: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistView {
    /// `ownerUid:kind`, the same shape as Playlist.id on iOS.
    pub id: String,
    pub title: String,
    pub track_count: u64,
    pub cover: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AlbumView {
    pub id: String,
    pub title: String,
    pub year: Option<u64>,
    pub artists: String,
    pub cover: Option<String>,
    pub track_count: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ArtistView {
    pub id: String,
    pub name: String,
    pub cover: Option<String>,
}

pub fn id_string(value: &Value) -> Option<String> {
    match value {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

pub fn text_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// Yandex covers are templates like `avatars.../%%`; the UI resizes the `200x200` part as needed.
pub fn cover_url(uri: Option<&str>) -> Option<String> {
    let uri = uri.filter(|u| !u.is_empty())?;
    let sized = uri.replace("%%", "200x200");
    Some(if sized.starts_with("http") { sized } else { format!("https://{sized}") })
}

fn artist_refs(value: &Value) -> Vec<ArtistRef> {
    value
        .get("artists")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|a| Some(ArtistRef { id: id_string(a.get("id")?)?, name: text_field(a, "name")? }))
        .collect()
}

fn artist_line(list: &[ArtistRef]) -> String {
    list.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")
}

pub fn track_view(track: &Value) -> Option<TrackView> {
    let id = id_string(track.get("id")?)?;
    let title = text_field(track, "title")?;
    let artist_list = artist_refs(track);
    let album_cover = track.pointer("/albums/0/coverUri").and_then(Value::as_str);
    Some(TrackView {
        id,
        title,
        version: text_field(track, "version"),
        artists: artist_line(&artist_list),
        artist_list,
        album_id: track.pointer("/albums/0/id").and_then(id_string),
        album_title: track.pointer("/albums/0/title").and_then(Value::as_str).map(str::to_owned),
        duration_ms: track.get("durationMs").and_then(Value::as_u64).unwrap_or(0),
        cover: cover_url(track.get("coverUri").and_then(Value::as_str).or(album_cover)),
        available: track.get("available").and_then(Value::as_bool).unwrap_or(true),
    })
}

/// Tracks of a rotor batch (`sequence` items carry the track under `track`).
pub fn sequence_tracks(result: &Value) -> Vec<TrackView> {
    result
        .get("sequence")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("track"))
        .filter_map(track_view)
        .collect()
}

pub fn playlist_view(playlist: &Value) -> Option<PlaylistView> {
    let owner = id_string(playlist.get("uid")?)?;
    let kind = id_string(playlist.get("kind")?)?;
    let cover = playlist
        .pointer("/cover/uri")
        .or_else(|| playlist.pointer("/cover/itemsUri/0"))
        .or_else(|| playlist.get("ogImage"))
        .and_then(Value::as_str);
    Some(PlaylistView {
        id: format!("{owner}:{kind}"),
        title: text_field(playlist, "title")?,
        track_count: playlist.get("trackCount").and_then(Value::as_u64).unwrap_or(0),
        cover: cover_url(cover),
    })
}

pub fn album_view(album: &Value) -> Option<AlbumView> {
    Some(AlbumView {
        id: id_string(album.get("id")?)?,
        title: text_field(album, "title")?,
        year: album.get("year").and_then(Value::as_u64),
        artists: artist_line(&artist_refs(album)),
        cover: cover_url(album.get("coverUri").and_then(Value::as_str)),
        track_count: album.get("trackCount").and_then(Value::as_u64),
    })
}

pub fn artist_view(artist: &Value) -> Option<ArtistView> {
    let cover = artist.pointer("/cover/uri").or_else(|| artist.get("ogImage")).and_then(Value::as_str);
    Some(ArtistView {
        id: id_string(artist.get("id")?)?,
        name: text_field(artist, "name")?,
        cover: cover_url(cover),
    })
}

/// Maps an array (or nothing) through a lenient parser.
pub fn list<T>(value: Option<&Value>, parse: fn(&Value) -> Option<T>) -> Vec<T> {
    value.and_then(Value::as_array).into_iter().flatten().filter_map(parse).collect()
}

/// `id:albumId` refs from TrackShort items (likes, playlists): the form `POST /tracks` wants.
pub fn short_refs(shorts: &[Value]) -> Vec<String> {
    shorts
        .iter()
        .filter_map(|short| {
            let id = id_string(short.get("id")?)?;
            Some(match short.get("albumId").and_then(id_string) {
                Some(album) => format!("{id}:{album}"),
                None => id,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn track_keeps_artists_album_and_version() {
        let track = json!({
            "id": 42, "title": "Song", "version": "Live", "durationMs": 1000,
            "artists": [{ "id": 1, "name": "A" }, { "id": 2, "name": "B" }],
            "albums": [{ "id": 7, "title": "LP", "coverUri": "avatars.yandex.net/x/%%" }]
        });
        let view = track_view(&track).unwrap();
        assert_eq!(view.artists, "A, B");
        assert_eq!(view.album_id.as_deref(), Some("7"));
        assert_eq!(view.version.as_deref(), Some("Live"));
        assert_eq!(view.cover.as_deref(), Some("https://avatars.yandex.net/x/200x200"));
        assert!(view.available);
    }

    #[test]
    fn track_without_title_is_skipped() {
        assert!(track_view(&json!({ "id": 1 })).is_none());
    }

    #[test]
    fn short_refs_join_album_when_known() {
        let shorts = vec![json!({ "id": "1", "albumId": 9 }), json!({ "id": 2 })];
        assert_eq!(short_refs(&shorts), vec!["1:9".to_string(), "2".to_string()]);
    }
}
