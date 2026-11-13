//! Turns a track id into something playable. Port of StreamResolver.swift: lossless and AAC go
//! through get-file-info (AES-CTR decrypted to a temp file), mp3 through the legacy download-info.

use std::path::PathBuf;

use aes::Aes128;
use base64::{engine::general_purpose::STANDARD, Engine};
use ctr::cipher::{KeyIvInit, StreamCipher};
use hmac::{Hmac, Mac};
use md5::{Digest, Md5};
use serde::Serialize;
use serde_json::Value;
use sha2::Sha256;

use crate::api;

type Aes128Ctr = ctr::Ctr128BE<Aes128>;
type HmacSha256 = Hmac<Sha256>;

/// Key the desktop app signs get-file-info with; only accepted together with its client header.
const FILE_INFO_KEY: &[u8] = b"kzqU4XhfCaY6B6JTHODeq5";
// HE-AAC goes last: symphonia decodes AAC without SBR, so HE-AAC would sound muffled.
const CODECS: &str = "flac,flac-mp4,aac-mp4,aac,mp3,he-aac-mp4,he-aac";
const MP3_SALT: &str = "XGRlBW9FXlekgbPrRHuSiA";
const NO_STREAM: &str = "Трек недоступен для прослушивания";
const BAD_RESPONSE: &str = "Непонятный ответ сервера";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quality {
    Lossless,
    High,
    Efficient,
}

impl Quality {
    pub fn parse(value: &str) -> Self {
        match value {
            "lossless" => Self::Lossless,
            "efficient" => Self::Efficient,
            _ => Self::High,
        }
    }
}

/// What the player gets: a local decrypted file or a direct link, and what the stream is.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamSource {
    pub location: String,
    pub local: bool,
    pub codec: String,
    pub kbps: Option<u64>,
}

pub async fn resolve(token: &str, track_id: &str, quality: Quality) -> Result<StreamSource, String> {
    let fast = match quality {
        Quality::Lossless => Some("lossless"),
        Quality::Efficient => Some("nq"),
        Quality::High => None,
    };
    if let Some(fast) = fast {
        // Same fallback as the iOS app: if the fast path fails, take the legacy mp3.
        if let Ok(source) = file_info_source(token, track_id, fast).await {
            return Ok(source);
        }
    }
    mp3_source(token, track_id).await
}

/// get-file-info signature: HMAC-SHA256 over ts + trackId + quality + codecs + transport, base64,
/// without the trailing padding.
fn file_info_sign(timestamp: &str, track_id: &str, quality: &str) -> Result<String, String> {
    let message = format!("{timestamp}{track_id}{quality}{CODECS}raw");
    let mut mac = HmacSha256::new_from_slice(FILE_INFO_KEY).map_err(|e| e.to_string())?;
    mac.update(message.as_bytes());
    Ok(STANDARD.encode(mac.finalize().into_bytes()).trim_end_matches('=').to_owned())
}

async fn file_info_source(token: &str, track_id: &str, quality: &str) -> Result<StreamSource, String> {
    let timestamp = unix_now().to_string();
    let sign = file_info_sign(&timestamp, track_id, quality)?;
    let result = api::desktop_get(
        token,
        "get-file-info",
        &[
            ("ts", timestamp.as_str()),
            ("trackId", track_id),
            ("quality", quality),
            ("codecs", CODECS),
            ("transports", "raw"),
            ("sign", sign.as_str()),
        ],
    )
    .await?;
    let info = result.get("downloadInfo").ok_or(BAD_RESPONSE)?;
    let url = info.get("url").and_then(Value::as_str).filter(|u| !u.is_empty()).ok_or(NO_STREAM)?;
    let codec = info.get("codec").and_then(Value::as_str).unwrap_or("flac").to_owned();
    let kbps = info.get("bitrate").and_then(Value::as_u64);

    let Some(key) = info.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()) else {
        return Ok(StreamSource { location: url.to_owned(), local: false, codec, kbps });
    };
    let path = cache_path(track_id, &codec);
    if !path.exists() {
        let encrypted = api::download_bytes(url).await?;
        let plain = decrypt_ctr(&encrypted, key)?;
        std::fs::create_dir_all(path.parent().ok_or(NO_STREAM)?).map_err(|e| e.to_string())?;
        std::fs::write(&path, plain).map_err(|e| e.to_string())?;
    }
    Ok(StreamSource {
        location: path.to_string_lossy().into_owned(),
        local: true,
        codec,
        kbps,
    })
}

async fn mp3_source(token: &str, track_id: &str) -> Result<StreamSource, String> {
    let variants = api::download_info(token, track_id).await?;
    let best = variants
        .as_array()
        .ok_or(BAD_RESPONSE)?
        .iter()
        .filter(|v| v.get("codec").and_then(Value::as_str) == Some("mp3"))
        .max_by_key(|v| v.get("bitrateInKbps").and_then(Value::as_u64).unwrap_or(0))
        .ok_or(NO_STREAM)?;
    let info_url = best.get("downloadInfoUrl").and_then(Value::as_str).ok_or(NO_STREAM)?;
    let xml = api::download_text(info_url).await?;
    let info = DownloadInfo::parse(&xml)?;

    let path = info.path.trim_start_matches('/');
    let sign = hex::encode(Md5::digest(format!("{MP3_SALT}{path}{}", info.s).as_bytes()).as_slice());
    Ok(StreamSource {
        location: format!("https://{}/get-mp3/{sign}/{}/{path}", info.host, info.ts),
        local: false,
        codec: "mp3".into(),
        kbps: best.get("bitrateInKbps").and_then(Value::as_u64),
    })
}

/// AES-128-CTR with a zero counter, as Yandex encrypts lossless files.
fn decrypt_ctr(data: &[u8], hex_key: &str) -> Result<Vec<u8>, String> {
    let key = hex::decode(hex_key).map_err(|e| e.to_string())?;
    let mut cipher = Aes128Ctr::new_from_slices(&key, &[0u8; 16]).map_err(|e| e.to_string())?;
    let mut out = data.to_vec();
    cipher.apply_keystream(&mut out);
    Ok(out)
}

/// File extension (and decoder hint) for a Yandex codec name.
pub fn extension(codec: &str) -> &str {
    if codec.contains("mp4") { "m4a" } else { codec }
}

fn cache_path(track_id: &str, codec: &str) -> PathBuf {
    std::env::temp_dir().join("volna").join(format!("{track_id}.{}", extension(codec)))
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The fields of `<download-info>` the mp3 link is built from.
struct DownloadInfo {
    host: String,
    path: String,
    ts: String,
    s: String,
}

impl DownloadInfo {
    fn parse(xml: &str) -> Result<Self, String> {
        let field = |tag: &str| -> Result<String, String> {
            let open = format!("<{tag}>");
            let close = format!("</{tag}>");
            let start = xml.find(&open).ok_or(NO_STREAM)? + open.len();
            let end = xml[start..].find(&close).ok_or(NO_STREAM)? + start;
            Ok(xml[start..end].trim().to_owned())
        };
        Ok(Self {
            host: field("host")?,
            path: field("path")?,
            ts: field("ts")?,
            s: field("s")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctr_roundtrip_restores_plaintext() {
        let key = "00112233445566778899aabbccddeeff";
        let plain = b"lossless bytes".to_vec();
        let once = decrypt_ctr(&plain, key).unwrap();
        assert_ne!(once, plain);
        assert_eq!(decrypt_ctr(&once, key).unwrap(), plain);
    }

    #[test]
    fn download_xml_fields_are_read() {
        let xml = "<?xml version=\"1.0\"?><download-info><host>s.example</host><path>/a/b.mp3</path><ts>12</ts><s>xyz</s></download-info>";
        let info = DownloadInfo::parse(xml).unwrap();
        assert_eq!((info.host.as_str(), info.path.as_str(), info.ts.as_str(), info.s.as_str()),
                   ("s.example", "/a/b.mp3", "12", "xyz"));
    }

    #[test]
    fn file_info_sign_has_no_padding() {
        let sign = file_info_sign("1700000000", "123", "lossless").unwrap();
        assert!(!sign.contains('='));
        assert_eq!(sign.len(), 43);
    }
}
