//! Lyrics: Yandex first (synced LRC, then plain text), LRCLIB as a fallback.
//! Port of Lyrics.swift (LRC parser, loader) and LRCLib.swift.

use std::cmp::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::Value;
use sha2::Sha256;

use crate::api;
use crate::auth;

type HmacSha256 = Hmac<Sha256>;

/// Key the Android app signs lyrics requests with.
const LYRICS_KEY: &[u8] = b"p93jhgh689SBReK6ghtw62";
/// A search hit counts only if its length is this close to ours (remixes have other timing).
const DURATION_TOLERANCE: f64 = 4.0;
/// LRCLIB asks clients to identify themselves.
const LRCLIB_AGENT: &str = "C1PH0N1C/0.3 (desktop)";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct LyricLine {
    pub time: f64,
    pub text: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    /// "synced" (lines with times) or "plain" (text only).
    pub kind: &'static str,
    pub lines: Vec<LyricLine>,
    pub text: String,
    /// "yandex" or "lrclib.net".
    pub source: &'static str,
    pub writers: Vec<String>,
}

/// Lyrics for a track: Yandex synced, Yandex text, then LRCLIB. None when nothing is found.
#[tauri::command]
pub async fn get_lyrics(
    track_id: String,
    title: String,
    artist: String,
    duration_ms: u64,
) -> Result<Option<Lyrics>, String> {
    let token = auth::stored_token()?.ok_or("Нужен вход")?;

    if let Ok((text, writers)) = yandex(&token, &track_id, "LRC").await {
        let lines = parse_lrc(&text);
        if !lines.is_empty() {
            return Ok(Some(Lyrics { kind: "synced", lines, text: String::new(), source: "yandex", writers }));
        }
    }
    if let Ok((text, writers)) = yandex(&token, &track_id, "TEXT").await {
        if !text.trim().is_empty() {
            return Ok(Some(Lyrics {
                kind: "plain",
                lines: Vec::new(),
                text: text.trim().to_owned(),
                source: "yandex",
                writers,
            }));
        }
    }
    Ok(lrclib(&title, &artist, duration_ms).await)
}

/// Signed request for the lyrics link, then the text it points to. Returns the text and writers.
async fn yandex(token: &str, track_id: &str, format: &str) -> Result<(String, Vec<String>), String> {
    let numeric = track_id.split(':').next().unwrap_or(track_id);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .to_string();
    let mut mac = HmacSha256::new_from_slice(LYRICS_KEY).map_err(|e| e.to_string())?;
    mac.update(format!("{numeric}{timestamp}").as_bytes());
    let sign = STANDARD.encode(mac.finalize().into_bytes());

    let info = api::get_query(
        token,
        &format!("tracks/{numeric}/lyrics"),
        &[("format", format), ("timeStamp", timestamp.as_str()), ("sign", sign.as_str())],
    )
    .await?;
    let url = info.get("downloadUrl").and_then(Value::as_str).ok_or("нет ссылки на текст")?;
    let text = api::download_text(url).await?;
    let writers = info
        .get("writers")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|w| w.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    Ok((text, writers))
}

/// Parses `[mm:ss.xx]` stamps; a line may carry several. Lines come out sorted by time.
pub fn parse_lrc(source: &str) -> Vec<LyricLine> {
    let mut lines = Vec::new();
    for raw in source.lines() {
        let mut rest = raw.trim();
        let mut times = Vec::new();
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some(end) = stripped.find(']') else { break };
            match parse_stamp(&stripped[..end]) {
                Some(time) => times.push(time),
                None => break,
            }
            rest = &stripped[end + 1..];
        }
        if times.is_empty() {
            continue;
        }
        let text = rest.trim();
        for time in times {
            lines.push(LyricLine { time, text: text.to_owned() });
        }
    }
    lines.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(Ordering::Equal));
    lines
}

fn parse_stamp(stamp: &str) -> Option<f64> {
    let (minutes, seconds) = stamp.split_once(':')?;
    let minutes: f64 = minutes.parse().ok()?;
    let seconds: f64 = seconds.replace(',', ".").replace(':', ".").parse().ok()?;
    Some(minutes * 60.0 + seconds)
}

async fn lrclib(title: &str, artist: &str, duration_ms: u64) -> Option<Lyrics> {
    let first_artist = artist.split(", ").next().unwrap_or(artist);
    if first_artist.is_empty() {
        return None;
    }
    let duration = (duration_ms > 0).then(|| duration_ms as f64 / 1000.0);

    // Exact match first (title, artist, length), then a looser search.
    let mut exact = vec![("track_name", title.to_owned()), ("artist_name", first_artist.to_owned())];
    if let Some(d) = duration {
        exact.push(("duration", d.round().to_string()));
    }
    if let Some(record) = lrclib_fetch("get", &exact).await {
        if let Some(lyrics) = convert(&record) {
            return Some(lyrics);
        }
    }

    let search = [("track_name", title.to_owned()), ("artist_name", first_artist.to_owned())];
    let hits = lrclib_fetch("search", &search).await?;
    let mut close: Vec<&Value> = hits
        .as_array()?
        .iter()
        .filter(|hit| match (duration, hit.get("duration").and_then(Value::as_f64)) {
            (Some(ours), Some(theirs)) => (theirs - ours).abs() <= DURATION_TOLERANCE,
            _ => true,
        })
        .collect();
    // Synced hits first, then anything with text.
    close.sort_by_key(|hit| !has_synced(hit));
    close.into_iter().find_map(convert)
}

async fn lrclib_fetch(path: &str, query: &[(&str, String)]) -> Option<Value> {
    let response = api::http()
        .get(format!("https://lrclib.net/api/{path}"))
        .query(query)
        .header("User-Agent", LRCLIB_AGENT)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Value>().await.ok()
}

fn has_synced(record: &Value) -> bool {
    record.get("syncedLyrics").and_then(Value::as_str).is_some_and(|s| !s.is_empty())
}

fn convert(record: &Value) -> Option<Lyrics> {
    if record.get("instrumental").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    if let Some(synced) = record.get("syncedLyrics").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        let lines = parse_lrc(synced);
        if !lines.is_empty() {
            return Some(Lyrics { kind: "synced", lines, text: String::new(), source: "lrclib.net", writers: Vec::new() });
        }
    }
    let plain = record.get("plainLyrics").and_then(Value::as_str)?.trim();
    (!plain.is_empty()).then(|| Lyrics {
        kind: "plain",
        lines: Vec::new(),
        text: plain.to_owned(),
        source: "lrclib.net",
        writers: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lrc_lines_come_out_sorted_with_repeated_stamps() {
        let source = "[00:12.50]second\n[00:05.00][00:20.00]first and last\n[ti:ignored]\n";
        let lines = parse_lrc(source);
        let times: Vec<f64> = lines.iter().map(|l| l.time).collect();
        assert_eq!(times, vec![5.0, 12.5, 20.0]);
        assert_eq!(lines[0].text, "first and last");
    }

    #[test]
    fn lrc_without_stamps_is_empty() {
        assert!(parse_lrc("just text\nno times").is_empty());
    }

    #[test]
    fn instrumental_record_has_no_lyrics() {
        let record = serde_json::json!({ "instrumental": true, "plainLyrics": "la la" });
        assert_eq!(convert(&record), None);
    }

    #[test]
    fn plain_record_falls_back_to_text() {
        let record = serde_json::json!({ "plainLyrics": "  hello  " });
        assert_eq!(convert(&record).map(|l| l.text), Some("hello".to_owned()));
    }
}
