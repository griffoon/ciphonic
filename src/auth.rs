//! Yandex OAuth (implicit flow) in a separate webview window. The token is read from the
//! redirect fragment in the navigation handler and kept in Windows Credential Manager.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::api;

const SERVICE: &str = "dev.volna.desktop";
const ACCOUNT: &str = "oauth-token";
pub const LOGIN_LABEL: &str = "login";
/// Client id of the official Yandex Music app; the only one allowed to read the music API.
const AUTH_URL: &str =
    "https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d";

/// Set while a redirect with a token is being verified, so a second redirect is ignored.
static FINISHING: AtomicBool = AtomicBool::new(false);
/// Token and uid of the signed-in account, so calls don't re-check account/status each time.
static ACCOUNT_CACHE: Mutex<Option<(String, String)>> = Mutex::new(None);

fn remember_account(token: &str, uid: &str) {
    *ACCOUNT_CACHE.lock().unwrap_or_else(|p| p.into_inner()) = Some((token.to_owned(), uid.to_owned()));
}

/// Token plus uid for calls that need the account; verified once per token.
pub async fn account() -> Result<(String, String), String> {
    let token = stored_token()?.ok_or("Нужен вход")?;
    let cached = ACCOUNT_CACHE.lock().unwrap_or_else(|p| p.into_inner()).clone();
    if let Some((known, uid)) = cached {
        if known == token {
            return Ok((token, uid));
        }
    }
    let session = api::verify(&token).await?;
    remember_account(&token, &session.uid);
    Ok((token, session.uid))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub uid: String,
    pub login: Option<String>,
    pub display_name: Option<String>,
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

pub fn stored_token() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) if !token.is_empty() => Ok(Some(token)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn store_token(token: &str) -> Result<(), String> {
    entry()?.set_password(token).map_err(|e| e.to_string())
}

pub fn forget_token() -> Result<(), String> {
    *ACCOUNT_CACHE.lock().unwrap_or_else(|p| p.into_inner()) = None;
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// The session restored from the stored token, or None when nobody is logged in.
/// A rejected token is dropped so the user sees the login screen.
pub async fn current_session() -> Result<Option<Session>, String> {
    let Some(token) = stored_token()? else {
        return Ok(None);
    };
    match api::verify(&token).await {
        Ok(session) => {
            remember_account(&token, &session.uid);
            Ok(Some(session))
        }
        Err(e) if e == api::UNAUTHORIZED => {
            forget_token()?;
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

/// Pulls `access_token` out of a redirect like `https://…/#access_token=abc&token_type=bearer`.
fn token_from_fragment(url: &Url) -> Option<String> {
    url.fragment()?
        .split('&')
        .find_map(|pair| pair.strip_prefix("access_token="))
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
}

pub fn open_login(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LOGIN_LABEL) {
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let url = AUTH_URL.parse::<Url>().map_err(|e| e.to_string())?;
    let handle = app.clone();
    WebviewWindowBuilder::new(app, LOGIN_LABEL, WebviewUrl::External(url))
        .title("Яндекс ID")
        .inner_size(480.0, 680.0)
        .center()
        .on_navigation(move |url| match token_from_fragment(url) {
            Some(token) => {
                eprintln!("[login] redirect with token from {}", url.host_str().unwrap_or("?"));
                if !FINISHING.swap(true, Ordering::SeqCst) {
                    let app = handle.clone();
                    tauri::async_runtime::spawn(finish_login(app, token));
                }
                // The redirect page is never shown: the token is all we need from it.
                false
            }
            None => {
                // Host and path only: the query may carry the authorization state.
                eprintln!(
                    "[login] navigate {}{}",
                    url.host_str().unwrap_or("?"),
                    url.path()
                );
                true
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Checks a token against the API and keeps it. Used by the webview redirect and by manual paste.
pub async fn login_with_token(token: &str) -> Result<Session, String> {
    let session = api::verify(token).await?;
    store_token(token)?;
    remember_account(token, &session.uid);
    Ok(session)
}

async fn finish_login(app: AppHandle, token: String) {
    let result = login_with_token(&token).await;
    if let Some(window) = app.get_webview_window(LOGIN_LABEL) {
        let _ = window.close();
    }
    FINISHING.store(false, Ordering::SeqCst);
    match result {
        Ok(session) => {
            let _ = app.emit("session-changed", Some(session));
        }
        Err(message) => {
            let _ = app.emit("login-error", message);
        }
    }
}
