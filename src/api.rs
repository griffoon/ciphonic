//! Thin client over the unofficial api.music.yandex.net endpoints. Grows per backlog iteration.

use std::sync::OnceLock;

use serde_json::Value;

use crate::auth::Session;

/// Error string for a rejected token; the caller decides what to do with it.
pub const UNAUTHORIZED: &str = "unauthorized";
const BASE_URL: &str = "https://api.music.yandex.net";
/// Client header of the Android app, the one the music API expects.
const CLIENT_HEADER: &str = "YandexMusicAndroid/24023621";

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Fetches `account/status` and turns it into a session. Fails with UNAUTHORIZED on a bad token.
pub async fn verify(token: &str) -> Result<Session, String> {
    let result = get(token, "account/status").await?;
    let account = result.get("account").ok_or("Непонятный ответ сервера")?;
    let uid = match account.get("uid") {
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        _ => return Err("Непонятный ответ сервера".into()),
    };
    Ok(Session {
        uid,
        login: text_field(account, "login"),
        display_name: text_field(account, "displayName"),
    })
}

async fn get(token: &str, path: &str) -> Result<Value, String> {
    let response = http()
        .get(format!("{BASE_URL}/{path}"))
        .header("Authorization", format!("OAuth {token}"))
        .header("X-Yandex-Music-Client", CLIENT_HEADER)
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
    body.get("result").cloned().ok_or_else(|| "Непонятный ответ сервера".into())
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}
