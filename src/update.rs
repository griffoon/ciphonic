//! Updates from this project's GitHub releases. The app compares the latest release with its own
//! version; on «Обновить» it downloads the release zip, checks its size and SHA-256 against what
//! GitHub reports, swaps `ciphonic.exe` and `WebView2Loader.dll` next to itself (a running exe can
//! be renamed on Windows, not overwritten) and starts the new copy. The old files are removed on
//! the next start. «Что нового» comes from the CHANGELOG built into the exe.

use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

const LATEST: &str = "https://api.github.com/repos/griffoon/ciphonic/releases/latest";
/// Files are only taken from this project's own releases.
const ASSET_PREFIX: &str = "https://github.com/griffoon/ciphonic/releases/download/";
const AGENT: &str = concat!("C1PH0N1C/", env!("CARGO_PKG_VERSION"), " (updater)");
const FILES: [&str; 2] = ["ciphonic.exe", "WebView2Loader.dll"];
const OLD: &str = "old";
const CHANGELOG: &str = include_str!("../CHANGELOG.md");

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    body: Option<String>,
    html_url: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    size: u64,
    browser_download_url: String,
    /// "sha256:<hex>", reported by GitHub for release assets.
    digest: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: String,
    pub page: String,
    pub size: u64,
}

/// "v0.3.10" → [0, 3, 10]; anything after the first non-digit in a part is dropped.
fn parse(version: &str) -> Vec<u64> {
    version
        .trim_start_matches(['v', 'V'])
        .split('.')
        .map(|part| part.chars().take_while(char::is_ascii_digit).collect::<String>().parse().unwrap_or(0))
        .collect()
}

fn is_newer(candidate: &str, current: &str) -> bool {
    parse(candidate) > parse(current)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent(AGENT).build().map_err(|e| e.to_string())
}

async fn latest() -> Result<Release, String> {
    let response = client()?.get(LATEST).header("Accept", "application/vnd.github+json").send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("GitHub: HTTP {}", response.status()));
    }
    response.json().await.map_err(|e| e.to_string())
}

fn zip_asset(release: &Release) -> Option<&Asset> {
    release.assets.iter().find(|a| a.name.ends_with("-windows-x64.zip") && a.browser_download_url.starts_with(ASSET_PREFIX))
}

/// The newer release, if there is one with a Windows zip.
#[tauri::command]
pub async fn check_update() -> Result<Option<UpdateInfo>, String> {
    let release = latest().await?;
    let current = env!("CARGO_PKG_VERSION");
    if !is_newer(&release.tag_name, current) {
        return Ok(None);
    }
    let Some(asset) = zip_asset(&release) else { return Ok(None) };
    Ok(Some(UpdateInfo {
        version: release.tag_name.trim_start_matches('v').to_owned(),
        current: current.to_owned(),
        notes: release.body.clone().unwrap_or_default(),
        page: release.html_url.clone(),
        size: asset.size,
    }))
}

/// Downloads, verifies and installs the latest release, then restarts into it.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let release = latest().await?;
    if !is_newer(&release.tag_name, env!("CARGO_PKG_VERSION")) {
        return Err("уже последняя версия".into());
    }
    let asset = zip_asset(&release).ok_or("в выпуске нет архива для Windows")?;
    let zip = download(&app, asset).await?;
    verify(&zip, asset)?;
    let files = unpack(&zip)?;
    let dir = std::env::current_exe().map_err(|e| e.to_string())?.parent().ok_or("нет папки программы")?.to_owned();
    swap(&dir, &files)?;
    let _ = app.emit("update-progress", 1.0);
    std::process::Command::new(dir.join(FILES[0])).arg(crate::AFTER_UPDATE).spawn().map_err(|e| format!("не запустилась новая версия: {e}"))?;
    crate::tray::quit(&app);
    Ok(())
}

async fn download(app: &AppHandle, asset: &Asset) -> Result<Vec<u8>, String> {
    let mut response = client()?.get(&asset.browser_download_url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("загрузка: HTTP {}", response.status()));
    }
    let mut data = Vec::with_capacity(asset.size as usize);
    let mut last = 0.0;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        data.extend_from_slice(&chunk);
        let share = data.len() as f64 / asset.size.max(1) as f64;
        if share - last > 0.02 {
            last = share;
            let _ = app.emit("update-progress", share.min(0.99));
        }
    }
    Ok(data)
}

fn verify(zip: &[u8], asset: &Asset) -> Result<(), String> {
    if zip.len() as u64 != asset.size {
        return Err("архив скачался не целиком".into());
    }
    if let Some(expected) = asset.digest.as_deref().and_then(|d| d.strip_prefix("sha256:")) {
        let actual = hex::encode(Sha256::digest(zip));
        if !actual.eq_ignore_ascii_case(expected) {
            return Err("контрольная сумма архива не сходится".into());
        }
    }
    Ok(())
}

/// The two files the app needs, by name, wherever they sit in the zip.
fn unpack(zip: &[u8]) -> Result<Vec<(&'static str, Vec<u8>)>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip)).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for name in FILES {
        let index = (0..archive.len())
            .find(|&i| archive.by_index(i).is_ok_and(|f| f.name().rsplit(['/', '\\']).next() == Some(name)))
            .ok_or_else(|| format!("в архиве нет {name}"))?;
        let mut file = archive.by_index(index).map_err(|e| e.to_string())?;
        let mut data = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut data).map_err(|e| e.to_string())?;
        if data.is_empty() {
            return Err(format!("{name} в архиве пустой"));
        }
        out.push((name, data));
    }
    Ok(out)
}

fn old_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".");
    name.push(OLD);
    path.with_file_name(name)
}

/// Renames the running files aside and writes the new ones; puts everything back on failure.
fn swap(dir: &Path, files: &[(&str, Vec<u8>)]) -> Result<(), String> {
    let mut moved: Vec<PathBuf> = Vec::new();
    let result = (|| {
        for (name, data) in files {
            let target = dir.join(name);
            let aside = old_path(&target);
            let _ = fs::remove_file(&aside);
            if target.exists() {
                fs::rename(&target, &aside).map_err(|e| format!("{name}: {e}"))?;
                moved.push(target.clone());
            }
            fs::write(&target, data).map_err(|e| format!("{name}: {e}"))?;
        }
        Ok(())
    })();
    if result.is_err() {
        for target in moved {
            let _ = fs::remove_file(&target);
            let _ = fs::rename(old_path(&target), &target);
        }
    }
    result
}

/// Removes what the last update set aside. Called at start, when the old exe is no longer running.
pub fn cleanup() {
    let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_owned)) else { return };
    for name in FILES {
        let _ = fs::remove_file(old_path(&dir.join(name)));
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhatsNew {
    pub version: String,
    pub notes: String,
}

/// This version and its part of the built-in CHANGELOG («Что нового» after an update).
#[tauri::command]
pub fn whats_new() -> WhatsNew {
    let version = env!("CARGO_PKG_VERSION");
    WhatsNew { version: version.to_owned(), notes: section(CHANGELOG, version) }
}

fn section(changelog: &str, version: &str) -> String {
    let header = format!("## v{version}");
    let mut lines = changelog.lines().skip_while(|l| !l.starts_with(&header));
    lines.next();
    lines.take_while(|l| !l.starts_with("## ")).collect::<Vec<_>>().join("\n").trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_by_number() {
        assert!(is_newer("v0.3.1", "0.3.0"));
        assert!(is_newer("v0.10.0", "0.9.9"));
        assert!(!is_newer("v0.3.0", "0.3.0"));
        assert!(!is_newer("v0.2.9", "0.3.0"));
    }

    #[test]
    fn changelog_section_is_found() {
        let text = "# Изменения\n\n## v0.3.0 — C1PH0N1C\n\n- one\n- two\n\n## v0.2.3\n\n- old\n";
        assert_eq!(section(text, "0.3.0"), "- one\n- two");
        assert_eq!(section(text, "9.9.9"), "");
    }

    #[test]
    fn swap_replaces_files_and_keeps_the_old_aside() {
        let dir = std::env::temp_dir().join(format!("ciphonic-swap-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("ciphonic.exe"), b"old").unwrap();
        swap(&dir, &[("ciphonic.exe", b"new".to_vec())]).unwrap();
        assert_eq!(fs::read(dir.join("ciphonic.exe")).unwrap(), b"new");
        assert_eq!(fs::read(dir.join("ciphonic.exe.old")).unwrap(), b"old");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_rejects_a_wrong_digest() {
        let asset = Asset {
            name: "x-windows-x64.zip".into(),
            size: 3,
            browser_download_url: String::new(),
            digest: Some(format!("sha256:{}", "0".repeat(64))),
        };
        assert!(verify(b"abc", &asset).is_err());
        let ok = Asset { digest: Some(format!("sha256:{}", hex::encode(Sha256::digest(b"abc")))), ..asset };
        assert!(verify(b"abc", &ok).is_ok());
    }
}
