use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

const MAX_BACKUP_BYTES: usize = 64 * 1024 * 1024;
const MAX_INSTALLER_BYTES: u64 = 300 * 1024 * 1024;
const MIN_INSTALLER_BYTES: u64 = 1024 * 1024;
const MAX_DOWNLOAD_REDIRECTS: usize = 5;
static UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateProgress<'a> {
    phase: &'a str,
    percent: Option<u8>,
    message: &'a str,
}

fn emit_progress(app: &AppHandle, phase: &'static str, percent: Option<u8>, message: &'static str) {
    let _ = app.emit(
        "app-update-progress",
        AppUpdateProgress {
            phase,
            percent,
            message,
        },
    );
}

const DOWNLOAD_PROGRESS_MAX: u8 = 80;
const FALLBACK_INSTALLER_BYTES: u64 = 40 * 1024 * 1024;

fn overall_download_percent(downloaded: u64, known_total: Option<u64>) -> u8 {
    let total = known_total
        .filter(|bytes| *bytes > 0)
        .unwrap_or(FALLBACK_INSTALLER_BYTES);
    let mut percent = downloaded
        .saturating_mul(u64::from(DOWNLOAD_PROGRESS_MAX))
        / total;
    if percent > u64::from(DOWNLOAD_PROGRESS_MAX) {
        percent = u64::from(DOWNLOAD_PROGRESS_MAX);
    }
    if known_total.is_none() && percent >= u64::from(DOWNLOAD_PROGRESS_MAX) {
        percent = u64::from(DOWNLOAD_PROGRESS_MAX.saturating_sub(1));
    }
    percent.max(1) as u8
}

fn update_backup_path() -> Result<PathBuf, String> {
    let dirs = directories::ProjectDirs::from("com", "hormachuelos", "Hormachuelos Optimized")
        .ok_or_else(|| "Could not locate the persistent Hormachuelos data folder.".to_string())?;
    let dir = dirs.config_dir();
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("Could not prepare the update backup folder: {error}"))?;
    Ok(dir.join("update-state-backup.json"))
}

fn update_cache_path(version: &str, extension: &str) -> Result<PathBuf, String> {
    let dirs = directories::ProjectDirs::from("com", "hormachuelos", "Hormachuelos Optimized")
        .ok_or_else(|| "Could not locate the Hormachuelos update cache.".to_string())?;
    let dir = dirs.cache_dir().join("updates");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not prepare the update cache: {error}"))?;
    Ok(dir.join(format!(
        "Hormachuelos_Optimized_{version}_x64-update.{extension}"
    )))
}

#[cfg(windows)]
fn install_kind_for_executable(executable: &Path) -> &'static str {
    let has_nsis_uninstaller = executable
        .parent()
        .is_some_and(|directory| directory.join("uninstall.exe").is_file());
    if has_nsis_uninstaller {
        "nsis"
    } else {
        // WiX/MSI installs do not bundle uninstall.exe. Portable development
        // copies also use MSI as the safer first installer family.
        "msi"
    }
}

#[tauri::command]
pub fn app_install_kind() -> &'static str {
    #[cfg(windows)]
    {
        std::env::current_exe()
            .ok()
            .as_deref()
            .map(install_kind_for_executable)
            .unwrap_or("msi")
    }
    #[cfg(not(windows))]
    {
        "unknown"
    }
}

#[tauri::command]
pub fn save_update_backup(state_json: String) -> Result<(), String> {
    if state_json.is_empty() || state_json.len() > MAX_BACKUP_BYTES {
        return Err("The local update backup is empty or too large.".into());
    }
    let value: serde_json::Value = serde_json::from_str(&state_json)
        .map_err(|_| "The local update backup is not valid JSON.".to_string())?;
    if value.get("format").and_then(serde_json::Value::as_u64) != Some(1)
        || !value
            .get("entries")
            .is_some_and(serde_json::Value::is_object)
    {
        return Err("The local update backup has an unsupported format.".into());
    }

    let path = update_backup_path()?;
    let pending = path.with_extension("pending");
    std::fs::write(&pending, state_json.as_bytes())
        .map_err(|error| format!("Could not save local data before updating: {error}"))?;
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|error| format!("Could not replace the previous update backup: {error}"))?;
    }
    std::fs::rename(&pending, &path)
        .map_err(|error| format!("Could not finalize the local update backup: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn load_update_backup() -> Result<Option<String>, String> {
    let path = update_backup_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| format!("Could not restore local data after updating: {error}"))?;
    Ok(Some(raw))
}

#[tauri::command]
pub fn clear_update_backup() -> Result<(), String> {
    let path = update_backup_path()?;
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(&path)
        .map_err(|error| format!("Could not clear the restored update backup: {error}"))
}

fn parse_version(version: &str) -> Result<Vec<u64>, String> {
    let version = version.trim().trim_start_matches(['v', 'V']);
    if version.is_empty()
        || version.contains("..")
        || version.starts_with(['.', '-', '+'])
        || version.ends_with(['.', '-', '+'])
    {
        return Err("The update version is invalid.".into());
    }
    let parts: Vec<&str> = version.split(['.', '-', '+']).collect();
    if parts.len() < 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.chars().all(|ch| ch.is_ascii_digit()))
    {
        return Err("The update version is invalid.".into());
    }
    parts
        .into_iter()
        .map(|part| {
            part.parse()
                .map_err(|_| "The update version is invalid.".to_string())
        })
        .collect()
}

fn cmp_version(left: &[u64], right: &[u64]) -> std::cmp::Ordering {
    let length = left.len().max(right.len());
    for index in 0..length {
        let delta = left
            .get(index)
            .copied()
            .unwrap_or(0)
            .cmp(&right.get(index).copied().unwrap_or(0));
        if delta != std::cmp::Ordering::Equal {
            return delta;
        }
    }
    std::cmp::Ordering::Equal
}

fn is_version_newer(candidate: &str, current: &str) -> Result<bool, String> {
    let next = parse_version(candidate)?;
    let installed = match parse_version(current) {
        Ok(value) => value,
        Err(_) => return Ok(true),
    };
    Ok(cmp_version(&next, &installed) == std::cmp::Ordering::Greater)
}

fn validate_version(version: &str) -> Result<String, String> {
    parse_version(version)?;
    Ok(version.trim().trim_start_matches(['v', 'V']).to_string())
}

fn validate_sha256(expected_sha256: &str) -> Result<String, String> {
    let checksum = expected_sha256.trim().to_ascii_lowercase();
    if checksum.len() != 64 || !checksum.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("The release manifest has an invalid installer checksum.".into());
    }
    Ok(checksum)
}

fn is_strict_https_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}

fn lowercase_host(url: &reqwest::Url) -> String {
    url.host_str().unwrap_or_default().to_ascii_lowercase()
}

fn is_owned_download_host(host: &str) -> bool {
    host == "chmoralla-code.github.io"
}

fn is_trusted_redirect_host(host: &str) -> bool {
    is_owned_download_host(host)
        || matches!(
            host,
            "github.com" | "objects.githubusercontent.com" | "release-assets.githubusercontent.com"
        )
}

fn validate_redirect_url(url: &reqwest::Url) -> Result<(), String> {
    if !is_strict_https_url(url) || !is_trusted_redirect_host(&lowercase_host(url)) {
        return Err("The update download was redirected to an untrusted URL.".into());
    }
    Ok(())
}

fn validate_download_url(
    download_url: &str,
    version: &str,
) -> Result<(reqwest::Url, &'static str), String> {
    let url = reqwest::Url::parse(download_url)
        .map_err(|_| "The update download URL is invalid.".to_string())?;
    if !is_strict_https_url(&url) {
        return Err("Updates must use a trusted HTTPS download URL.".into());
    }
    let filename = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or_default();
    let exe_name = format!("Hormachuelos_Optimized_{version}_x64-setup.exe");
    let msi_name = format!("Hormachuelos_Optimized_{version}_x64.msi");
    let extension = if filename.eq_ignore_ascii_case(&exe_name) {
        "exe"
    } else if filename.eq_ignore_ascii_case(&msi_name) {
        "msi"
    } else {
        return Err("The update filename does not match the published version.".into());
    };

    let host = lowercase_host(&url);
    if is_owned_download_host(&host) {
        return Ok((url, extension));
    }
    if host == "github.com" {
        let expected_path = format!(
            "/chmoralla-code/HORMACHUELOS-OPTIMIZED/releases/download/v{version}/{filename}"
        );
        if url.path() == expected_path {
            return Ok((url, extension));
        }
        return Err("The GitHub release URL does not match the published version.".into());
    }
    Err("The update download host is not trusted.".into())
}

fn has_expected_file_header(path: &Path, extension: &str) -> Result<bool, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Could not verify the downloaded installer: {error}"))?;
    let mut prefix = [0_u8; 8];
    let read = file
        .read(&mut prefix)
        .map_err(|error| format!("Could not verify the downloaded installer: {error}"))?;
    let valid = if extension == "exe" {
        read >= 2 && prefix.starts_with(b"MZ")
    } else {
        read == prefix.len() && prefix == [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]
    };
    Ok(valid)
}

async fn download_installer(
    app: &AppHandle,
    url: reqwest::Url,
    extension: &str,
    version: &str,
    expected_sha256: &str,
) -> Result<PathBuf, String> {
    let path = update_cache_path(version, extension)?;
    let pending = path.with_extension(format!("{extension}.part"));
    let client = reqwest::Client::builder()
        .user_agent("Hormachuelos-Optimized-Updater")
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(20 * 60))
        .build()
        .map_err(|error| format!("Could not initialize the update download: {error}"))?;
    emit_progress(app, "downloading", Some(1), "Downloading the update…");
    let mut current_url = url;
    let mut redirects = 0_usize;
    let mut response = loop {
        let response = client
            .get(current_url.clone())
            .header(reqwest::header::ACCEPT, "application/octet-stream")
            .send()
            .await
            .map_err(|error| format!("Could not download the update: {error}"))?;
        if !response.status().is_redirection() {
            break response;
        }
        if redirects >= MAX_DOWNLOAD_REDIRECTS {
            return Err("The update server redirected too many times.".into());
        }
        redirects = redirects.saturating_add(1);
        if current_url.path().is_empty() {
            return Err("The update server returned an invalid redirect.".into());
        }
        let redirect = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| {
                "The update server returned a redirect without a location.".to_string()
            })?;
        let next_url = current_url
            .join(redirect)
            .map_err(|_| "The update server returned an invalid redirect URL.".to_string())?;
        validate_redirect_url(&next_url)?;
        if current_url == next_url {
            return Err("The update server returned a redirect loop.".into());
        }
        current_url = next_url;
        if current_url.path().is_empty() {
            return Err("The update server returned an invalid redirect.".into());
        }
        if current_url.as_str().len() > 8_192 {
            return Err("The update server returned an oversized redirect URL.".into());
        }
        if current_url.fragment().is_some() {
            return Err("The update server returned an invalid redirect URL.".into());
        }
        if current_url.query_pairs().count() > 128 {
            return Err("The update server returned an invalid redirect URL.".into());
        }
        if current_url.path_segments().is_none() {
            return Err("The update server returned an invalid redirect URL.".into());
        }
        // GitHub release assets use a short-lived signed redirect. Follow a
        // bounded chain only after every destination has passed the host and
        // HTTPS checks above.
        if current_url.path().len() > 4_096 {
            return Err("The update server returned an invalid redirect URL.".into());
        }
    };
    if !response.status().is_success() {
        return Err(format!(
            "The update server returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            let value = value.to_ascii_lowercase();
            value.contains("text/html") || value.contains("application/json")
        })
    {
        return Err("The update server returned a web page instead of an installer.".into());
    }
    let total = response.content_length().or_else(|| {
        response
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok())
    });
    if total.is_some_and(|bytes| bytes > MAX_INSTALLER_BYTES) {
        return Err("The update installer is larger than the allowed limit.".into());
    }

    let mut file = tokio::fs::File::create(&pending)
        .await
        .map_err(|error| format!("Could not create the temporary installer: {error}"))?;
    let mut downloaded = 0_u64;
    let mut last_percent = 1_u8;
    let mut digest = Sha256::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("The update download was interrupted: {error}"))?
    {
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MAX_INSTALLER_BYTES {
            let _ = tokio::fs::remove_file(&pending).await;
            return Err("The update installer exceeded the allowed limit.".into());
        }
        digest.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Could not save the update installer: {error}"))?;
        let percent = overall_download_percent(downloaded, total);
        if percent >= last_percent.saturating_add(1) {
            last_percent = percent;
            emit_progress(app, "downloading", Some(percent), "Downloading update…");
        }
    }
    emit_progress(
        app,
        "downloading",
        Some(DOWNLOAD_PROGRESS_MAX),
        "Downloading update…",
    );
    file.flush()
        .await
        .map_err(|error| format!("Could not finalize the update installer: {error}"))?;
    file.sync_all()
        .await
        .map_err(|error| format!("Could not synchronize the update installer: {error}"))?;
    drop(file);
    let actual_sha256 = format!("{:x}", digest.finalize());
    if actual_sha256 != expected_sha256 {
        let _ = tokio::fs::remove_file(&pending).await;
        return Err("The installer checksum does not match the published release manifest.".into());
    }
    if downloaded < MIN_INSTALLER_BYTES || !has_expected_file_header(&pending, extension)? {
        let _ = tokio::fs::remove_file(&pending).await;
        return Err("The downloaded file is not a valid Hormachuelos Windows installer.".into());
    }
    if path.exists() {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|error| format!("Could not replace the previous update installer: {error}"))?;
    }
    tokio::fs::rename(&pending, &path)
        .await
        .map_err(|error| format!("Could not finalize the update installer: {error}"))?;
    Ok(path)
}

#[cfg(windows)]
fn install_helper_script() -> &'static str {
    r#"
param(
  [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ParentProcessId,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$InstallerPath,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$AppPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ReadyPath,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$LogPath,
  [Parameter(Mandatory = $false)][string]$BootstrapPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-UpdateLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  try {
    $line = '{0} {1}' -f [DateTimeOffset]::Now.ToString('o'), $Message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch {}
}

function Set-InstallStatus {
  param(
    $Window,
    [Parameter(Mandatory = $true)][ValidateRange(0, 100)][int]$Percent,
    [Parameter(Mandatory = $true)][string]$Headline
  )
  if ($null -eq $Window) { return }
  try {
    $state = $Window.Tag
    $state['PercentLabel'].Text = ('{0}%' -f $Percent)
    $state['Headline'].Text = $Headline
    $trackWidth = [Math]::Max(8, [int]$state['Track'].ClientSize.Width)
    $state['Fill'].Width = [Math]::Max(6, [int](($trackWidth * $Percent) / 100))
    [System.Windows.Forms.Application]::DoEvents()
  } catch {}
}

function Close-InstallStatusWindow {
  param($Window)
  if ($null -eq $Window) { return }
  try {
    $Window.Tag['AllowClose'] = $true
    $Window.Close()
    $Window.Dispose()
  } catch {}
}

function New-InstallStatusWindow {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Updating Hormachuelos'
    $form.AccessibleName = 'Hormachuelos update progress'
    $form.ClientSize = [System.Drawing.Size]::new(420, 228)
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $form.ShowInTaskbar = $true
    $form.TopMost = $true
    $form.Padding = [System.Windows.Forms.Padding]::new(1)
    $form.BackColor = [System.Drawing.Color]::FromArgb(97, 205, 250)
    try {
      $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($AppPath)
    } catch {}

    $surface = New-Object System.Windows.Forms.Panel
    $surface.Dock = [System.Windows.Forms.DockStyle]::Fill
    $surface.BackColor = [System.Drawing.Color]::FromArgb(12, 16, 18)
    $form.Controls.Add($surface)

    $brand = New-Object System.Windows.Forms.Label
    $brand.AutoSize = $false
    $brand.Location = [System.Drawing.Point]::new(28, 22)
    $brand.Size = [System.Drawing.Size]::new(364, 18)
    $brand.ForeColor = [System.Drawing.Color]::FromArgb(154, 176, 182)
    $brand.Font = [System.Drawing.Font]::new('Bahnschrift', 9, [System.Drawing.FontStyle]::Bold)
    $brand.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
    $brand.Text = 'UPDATING HORMACHUELOS'
    $surface.Controls.Add($brand)

    $percentLabel = New-Object System.Windows.Forms.Label
    $percentLabel.AutoSize = $false
    $percentLabel.Location = [System.Drawing.Point]::new(28, 52)
    $percentLabel.Size = [System.Drawing.Size]::new(364, 78)
    $percentLabel.ForeColor = [System.Drawing.Color]::FromArgb(232, 247, 255)
    $percentLabel.Font = [System.Drawing.Font]::new('Bahnschrift', 42, [System.Drawing.FontStyle]::Bold)
    $percentLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
    $percentLabel.Text = '90%'
    $percentLabel.AccessibleName = 'Update percent'
    $surface.Controls.Add($percentLabel)

    $headline = New-Object System.Windows.Forms.Label
    $headline.AutoSize = $false
    $headline.Location = [System.Drawing.Point]::new(28, 132)
    $headline.Size = [System.Drawing.Size]::new(364, 22)
    $headline.ForeColor = [System.Drawing.Color]::FromArgb(168, 188, 194)
    $headline.Font = [System.Drawing.Font]::new('Segoe UI', 10)
    $headline.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
    $headline.Text = "Installing v$ExpectedVersion"
    $surface.Controls.Add($headline)

    $track = New-Object System.Windows.Forms.Panel
    $track.Location = [System.Drawing.Point]::new(36, 172)
    $track.Size = [System.Drawing.Size]::new(348, 8)
    $track.BackColor = [System.Drawing.Color]::FromArgb(36, 44, 48)
    $surface.Controls.Add($track)

    $fill = New-Object System.Windows.Forms.Panel
    $fill.Location = [System.Drawing.Point]::new(0, 0)
    $fill.Size = [System.Drawing.Size]::new(313, 8)
    $fill.BackColor = [System.Drawing.Color]::FromArgb(107, 211, 243)
    $track.Controls.Add($fill)

    $form.Tag = @{
      Track = $track
      Fill = $fill
      PercentLabel = $percentLabel
      Headline = $headline
      AllowClose = $false
    }
    $form.Add_FormClosing({
      param($sender, $eventArgs)
      if (!$sender.Tag['AllowClose']) { $eventArgs.Cancel = $true }
    })
    return $form
  } catch {
    Write-UpdateLog "Native update window could not be created: $($_.Exception.Message)"
    return $null
  }
}

function Wait-InstallerWithStatus {
  param(
    [Parameter(Mandatory = $true)]$Process,
    $Window
  )
  if ($null -eq $Window) {
    $Process.WaitForExit()
    return [int]$Process.ExitCode
  }

  $Window.Show()
  $Window.Activate()
  Set-InstallStatus -Window $Window -Percent 90 -Headline "Installing v$ExpectedVersion"
  $startedAt = [DateTimeOffset]::Now
  while (!$Process.HasExited) {
    $elapsedMs = ([DateTimeOffset]::Now - $startedAt).TotalMilliseconds
    $percent = [Math]::Min(99, 90 + [int]($elapsedMs / 900))
    Set-InstallStatus -Window $Window -Percent $percent -Headline "Installing v$ExpectedVersion"
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 40
    $Process.Refresh()
  }
  $Process.WaitForExit()
  return [int]$Process.ExitCode
}

function Get-HormachuelosCandidates {
  $candidates = @($AppPath)
  foreach ($manufacturerKey in @(
    'HKCU:\Software\Hormachuelos\Hormachuelos',
    'HKLM:\Software\Hormachuelos\Hormachuelos'
  )) {
    try {
      $item = Get-Item -LiteralPath $manufacturerKey -ErrorAction Stop
      $candidates += [string]$item.GetValue('')
      $candidates += [string]$item.GetValue('InstallDir')
    } catch {}
  }

  foreach ($uninstallRoot in @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )) {
    try {
      foreach ($key in Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction Stop) {
        $entry = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
        if ($null -eq $entry) { continue }
        $displayNameProperty = $entry.PSObject.Properties['DisplayName']
        if ($null -ne $displayNameProperty -and [string]$displayNameProperty.Value -eq 'Hormachuelos Optimized') {
          $installLocationProperty = $entry.PSObject.Properties['InstallLocation']
          if ($null -ne $installLocationProperty) {
            $candidates += [string]$installLocationProperty.Value
          }
        }
      }
    } catch {}
  }

  foreach ($baseDirectory in @($env:ProgramW6432, $env:ProgramFiles)) {
    if (![string]::IsNullOrWhiteSpace($baseDirectory)) {
      $candidates += Join-Path -Path $baseDirectory -ChildPath 'Hormachuelos Optimized'
    }
  }
  if (![string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $candidates += Join-Path -Path $env:LOCALAPPDATA -ChildPath 'Hormachuelos Optimized'
    $candidates += Join-Path -Path $env:LOCALAPPDATA -ChildPath 'Programs\Hormachuelos Optimized'
  }
  return $candidates
}

function Test-HormachuelosVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][bool]$RequireExpectedVersion
  )
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  if (!$RequireExpectedVersion) { return $true }
  try {
    $actualVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($Path).ProductVersion
    if ([string]::IsNullOrWhiteSpace($actualVersion)) { return $false }
    return ([version]$actualVersion).ToString(3) -eq ([version]$ExpectedVersion).ToString(3)
  } catch {
    return $false
  }
}

function Resolve-HormachuelosPath {
  param([Parameter(Mandatory = $true)][bool]$RequireExpectedVersion)
  foreach ($candidateValue in Get-HormachuelosCandidates) {
    if ([string]::IsNullOrWhiteSpace($candidateValue)) { continue }
    $candidate = $candidateValue.Trim().Trim('"')
    if ([IO.Path]::GetExtension($candidate).ToLowerInvariant() -ne '.exe') {
      $candidate = Join-Path -Path $candidate -ChildPath 'hormachuelos-optimized.exe'
    }
    if (Test-HormachuelosVersion -Path $candidate -RequireExpectedVersion $RequireExpectedVersion) {
      return $candidate
    }
  }
  return $null
}

function Assert-InstallerHash {
  $actualSha256 = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $ExpectedSha256.ToLowerInvariant()) {
    throw 'The verified installer changed before it could be started.'
  }
}

function Remove-UpdateHelperFiles {
  Remove-Item -LiteralPath $ReadyPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
  if (![string]::IsNullOrWhiteSpace($BootstrapPath)) {
    Remove-Item -LiteralPath $BootstrapPath -Force -ErrorAction SilentlyContinue
  }
}

function Open-PreviousHormachuelos {
  $fallbackPath = Resolve-HormachuelosPath -RequireExpectedVersion $false
  if (![string]::IsNullOrWhiteSpace($fallbackPath)) {
    try {
      Start-Process -FilePath $fallbackPath
      Write-UpdateLog "Reopened previous app after update failure: $fallbackPath"
    } catch {
      Write-UpdateLog "Previous app could not be reopened: $($_.Exception.Message)"
    }
  } else {
    Write-UpdateLog 'No runnable Hormachuelos executable was found after the update failure.'
  }
}

try {
  $logDirectory = Split-Path -Parent $LogPath
  if (![string]::IsNullOrWhiteSpace($logDirectory)) {
    [IO.Directory]::CreateDirectory($logDirectory) | Out-Null
  }
  if (!(Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    throw "Verified installer is missing: $InstallerPath"
  }
  if (!(Test-Path -LiteralPath $AppPath -PathType Leaf)) {
    throw "Running application is missing: $AppPath"
  }
  Assert-InstallerHash
  Write-UpdateLog "Helper ready for Hormachuelos $ExpectedVersion."
  [IO.File]::WriteAllText(
    $ReadyPath,
    "ready:$ExpectedVersion",
    [Text.UTF8Encoding]::new($false)
  )
} catch {
  Write-UpdateLog "Helper initialization failed: $($_.Exception.Message)"
  exit 10
}

try {
  Wait-Process -Id $ParentProcessId -Timeout 120 -ErrorAction SilentlyContinue
} catch {}
if ($null -ne (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue)) {
  Write-UpdateLog 'The running app did not close within 120 seconds; installation was cancelled.'
  Remove-UpdateHelperFiles
  exit 11
}

try {
  Assert-InstallerHash
} catch {
  Write-UpdateLog "Installer integrity check failed after app exit: $($_.Exception.Message)"
  Open-PreviousHormachuelos
  Remove-UpdateHelperFiles
  exit 13
}

$exitCode = -1
$statusWindow = $null
try {
  $extension = [IO.Path]::GetExtension($InstallerPath).ToLowerInvariant()
  Write-UpdateLog "Installing $extension update silently."
  if ($extension -eq '.msi') {
    $quotedInstaller = '"' + $InstallerPath + '"'
    $result = Start-Process -FilePath 'msiexec.exe' -ArgumentList @(
      '/i', $quotedInstaller, '/quiet', '/norestart'
    ) -WindowStyle Hidden -PassThru
  } elseif ($extension -eq '.exe') {
    $result = Start-Process -FilePath $InstallerPath -ArgumentList @(
      '/S', '/UPDATE'
    ) -WindowStyle Hidden -PassThru
  } else {
    throw "Unsupported installer type: $extension"
  }
  $statusWindow = New-InstallStatusWindow
  $exitCode = Wait-InstallerWithStatus -Process $result -Window $statusWindow
  Write-UpdateLog "Installer exited with code $exitCode."
} catch {
  Write-UpdateLog "Installer failed to start: $($_.Exception.Message)"
}

if ($exitCode -in @(0, 1641, 3010)) {
  if ($exitCode -in @(1641, 3010)) {
    Write-UpdateLog "Windows reported that a reboot may still be required (code $exitCode)."
  }
  $launchPath = Resolve-HormachuelosPath -RequireExpectedVersion $true
  if (![string]::IsNullOrWhiteSpace($launchPath)) {
    try {
      Set-InstallStatus -Window $statusWindow -Percent 100 -Headline 'Restarting…'
      Start-Sleep -Milliseconds 280
      # The silent installer never launches the app. Restart it exactly once
      # here so the user only experiences the original app closing and opening.
      $startedProcess = Start-Process -FilePath $launchPath -PassThru
      Start-Sleep -Milliseconds 500
      if ($startedProcess.HasExited) {
        throw "Updated app exited immediately with code $($startedProcess.ExitCode)."
      }
      Write-UpdateLog "Restarted updated app: $launchPath"
      Remove-Item -LiteralPath $InstallerPath -Force -ErrorAction SilentlyContinue
      Close-InstallStatusWindow -Window $statusWindow
      Remove-UpdateHelperFiles
      exit 0
    } catch {
      Write-UpdateLog "Updated app could not be opened: $($_.Exception.Message)"
    }
  } else {
    Write-UpdateLog "Installer succeeded, but Hormachuelos $ExpectedVersion was not found."
  }
}

Close-InstallStatusWindow -Window $statusWindow
Open-PreviousHormachuelos
Remove-UpdateHelperFiles
exit 12
"#
}

#[cfg(windows)]
fn elevation_bootstrap_script() -> &'static str {
    r#"
param(
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$HelperPath,
  [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ParentProcessId,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$InstallerPath,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$AppPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ReadyPath,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$LogPath,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$BootstrapPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-BootstrapLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  try {
    $line = '{0} {1}' -f [DateTimeOffset]::Now.ToString('o'), $Message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch {}
}

function Quote-WindowsArgument {
  param([Parameter(Mandatory = $true)][string]$Value)
  # Windows file paths cannot contain a double quote, so wrapping the value is
  # sufficient and preserves spaces in the cache and Program Files paths.
  return '"' + $Value + '"'
}

try {
  $arguments = @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden', '-File', (Quote-WindowsArgument $HelperPath),
    '-ParentProcessId', $ParentProcessId.ToString(),
    '-InstallerPath', (Quote-WindowsArgument $InstallerPath),
    '-AppPath', (Quote-WindowsArgument $AppPath),
    '-ExpectedVersion', $ExpectedVersion,
    '-ExpectedSha256', $ExpectedSha256,
    '-ReadyPath', (Quote-WindowsArgument $ReadyPath),
    '-LogPath', (Quote-WindowsArgument $LogPath),
    '-BootstrapPath', (Quote-WindowsArgument $BootstrapPath)
  ) -join ' '
  Write-BootstrapLog 'Requesting administrator approval for the Windows installer.'
  $child = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments -PassThru -Wait
  exit [int]$child.ExitCode
} catch {
  Write-BootstrapLog "Administrator approval was not granted: $($_.Exception.Message)"
  Remove-Item -LiteralPath $ReadyPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $BootstrapPath -Force -ErrorAction SilentlyContinue
  exit 20
}
"#
}

#[cfg(windows)]
fn update_helper_log_path() -> Result<PathBuf, String> {
    let dirs = directories::ProjectDirs::from("com", "hormachuelos", "Hormachuelos Optimized")
        .ok_or_else(|| "Could not locate the Hormachuelos update log folder.".to_string())?;
    let directory = dirs.data_local_dir().join("logs");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not prepare the update log folder: {error}"))?;
    Ok(directory.join("update-helper.log"))
}

#[cfg(windows)]
struct InstallHelperCommand<'a> {
    helper_path: &'a Path,
    bootstrap_path: &'a Path,
    installer: &'a Path,
    current_exe: &'a Path,
    expected_version: &'a str,
    expected_sha256: &'a str,
    ready_path: &'a Path,
    log_path: &'a Path,
    parent_id: u32,
}

#[cfg(windows)]
fn install_helper_command(options: &InstallHelperCommand<'_>) -> std::process::Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = std::process::Command::new("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
        ])
        .arg(options.helper_path)
        .arg("-ParentProcessId")
        .arg(options.parent_id.to_string())
        .arg("-InstallerPath")
        .arg(options.installer)
        .arg("-AppPath")
        .arg(options.current_exe)
        .arg("-ExpectedVersion")
        .arg(options.expected_version)
        .arg("-ExpectedSha256")
        .arg(options.expected_sha256)
        .arg("-ReadyPath")
        .arg(options.ready_path)
        .arg("-LogPath")
        .arg(options.log_path)
        .arg("-BootstrapPath")
        .arg(options.bootstrap_path)
        .creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(windows)]
fn elevation_bootstrap_command(options: &InstallHelperCommand<'_>) -> std::process::Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = std::process::Command::new("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
        ])
        .arg(options.bootstrap_path)
        .arg("-HelperPath")
        .arg(options.helper_path)
        .arg("-ParentProcessId")
        .arg(options.parent_id.to_string())
        .arg("-InstallerPath")
        .arg(options.installer)
        .arg("-AppPath")
        .arg(options.current_exe)
        .arg("-ExpectedVersion")
        .arg(options.expected_version)
        .arg("-ExpectedSha256")
        .arg(options.expected_sha256)
        .arg("-ReadyPath")
        .arg(options.ready_path)
        .arg("-LogPath")
        .arg(options.log_path)
        .arg("-BootstrapPath")
        .arg(options.bootstrap_path)
        .creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(windows)]
fn installer_requires_administrator_elevation(installer: &Path) -> bool {
    installer
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("msi"))
}

#[cfg(windows)]
async fn launch_install_helper(
    app: Option<&AppHandle>,
    installer: &Path,
    current_exe: &Path,
    expected_version: &str,
    expected_sha256: &str,
    installing_message: &'static str,
) -> Result<(), String> {
    let cache_directory = installer
        .parent()
        .ok_or_else(|| "The downloaded installer has no parent folder.".to_string())?;
    let process_id = std::process::id();
    let helper_path = cache_directory.join(format!("update-helper-{process_id}.ps1"));
    let bootstrap_path = cache_directory.join(format!("update-elevation-{process_id}.ps1"));
    let ready_path = cache_directory.join(format!("update-helper-{process_id}.ready"));
    let log_path = update_helper_log_path()?;
    let _ = std::fs::remove_file(&ready_path);
    std::fs::write(&helper_path, install_helper_script())
        .map_err(|error| format!("Could not prepare the internal update helper: {error}"))?;
    if let Err(error) = std::fs::write(&bootstrap_path, elevation_bootstrap_script()) {
        let _ = std::fs::remove_file(&helper_path);
        return Err(format!(
            "Could not prepare the administrator approval helper: {error}"
        ));
    }

    let options = InstallHelperCommand {
        helper_path: &helper_path,
        bootstrap_path: &bootstrap_path,
        installer,
        current_exe,
        expected_version,
        expected_sha256,
        ready_path: &ready_path,
        log_path: &log_path,
        parent_id: process_id,
    };
    let requires_elevation = installer_requires_administrator_elevation(installer);
    let mut command = if requires_elevation {
        elevation_bootstrap_command(&options)
    } else {
        install_helper_command(&options)
    };
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = std::fs::remove_file(&ready_path);
            let _ = std::fs::remove_file(&helper_path);
            let _ = std::fs::remove_file(&bootstrap_path);
            return Err(format!(
                "Could not start the internal update helper: {error}"
            ));
        }
    };

    let expected_ready = format!("ready:{expected_version}");
    // A Windows UAC consent prompt is intentionally shown before the app
    // exits. Give the user enough time to review and approve it instead of
    // treating a normal approval delay as an updater failure.
    let helper_startup_timeout = if requires_elevation { 120 } else { 30 };
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_secs(helper_startup_timeout);
    let started = tokio::time::Instant::now();
    let mut last_percent = 90_u8;
    if let Some(app) = app {
        emit_progress(app, "installing", Some(90), installing_message);
    }
    loop {
        if let Ok(value) = std::fs::read_to_string(&ready_path) {
            if value.trim() == expected_ready {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                if let Some(status) = child.try_wait().map_err(|error| {
                    format!("Could not monitor the internal update helper: {error}")
                })? {
                    let _ = std::fs::remove_file(&ready_path);
                    let _ = std::fs::remove_file(&helper_path);
                    let _ = std::fs::remove_file(&bootstrap_path);
                    return Err(format!(
                        "The update helper stopped before the app could close (exit code {}). Hormachuelos stayed open. Details: {}",
                        status.code().unwrap_or(-1),
                        log_path.display()
                    ));
                }
                let _ = std::fs::remove_file(&ready_path);
                return Ok(());
            }
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not monitor the internal update helper: {error}"))?
        {
            let _ = std::fs::remove_file(&ready_path);
            let _ = std::fs::remove_file(&helper_path);
            let _ = std::fs::remove_file(&bootstrap_path);
            if status.code() == Some(20) {
                return Err(
                    "Windows administrator approval was not granted. The update was cancelled and Hormachuelos stayed open."
                        .into(),
                );
            }
            return Err(format!(
                "The update helper could not initialize (exit code {}). Hormachuelos stayed open. Details: {}",
                status.code().unwrap_or(-1),
                log_path.display()
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&ready_path);
            let _ = std::fs::remove_file(&helper_path);
            let _ = std::fs::remove_file(&bootstrap_path);
            return Err(format!(
                "The update helper did not become ready. Hormachuelos stayed open. Details: {}",
                log_path.display()
            ));
        }
        let next_percent = 90 + started.elapsed().as_secs().min(6) as u8;
        if next_percent > last_percent {
            last_percent = next_percent;
            if let Some(app) = app {
                emit_progress(app, "installing", Some(next_percent), installing_message);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

#[cfg(not(windows))]
async fn launch_install_helper(
    _app: Option<&AppHandle>,
    _installer: &Path,
    _current_exe: &Path,
    _expected_version: &str,
    _expected_sha256: &str,
    _installing_message: &'static str,
) -> Result<(), String> {
    Err("Internal updates are currently supported on Windows only.".into())
}

async fn install_app_update_inner(
    app: &AppHandle,
    state: &crate::state::AppState,
    download_url: String,
    version: String,
    sha256: String,
) -> Result<(), String> {
    let version = validate_version(&version)?;
    let sha256 = validate_sha256(&sha256)?;
    let current_version = app.package_info().version.to_string();
    if !is_version_newer(&version, &current_version)? {
        return Err(format!(
            "Hormachuelos v{version} is not newer than the installed v{current_version}."
        ));
    }
    if !update_backup_path()?.exists() {
        return Err("Local data must be backed up before installing an update.".into());
    }
    let (url, extension) = validate_download_url(&download_url, &version)?;
    emit_progress(app, "preparing", Some(0), "Preparing the secure update…");
    let installer = download_installer(app, url, extension, &version, &sha256).await?;
    emit_progress(
        app,
        "verifying",
        Some(85),
        "Verifying the downloaded installer…",
    );
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("Could not locate the running Hormachuelos app: {error}"))?;
    let installation_message = if extension == "msi" {
        "Waiting for Windows administrator approval…"
    } else {
        "Starting the internal installer…"
    };
    emit_progress(app, "installing", Some(90), installation_message);
    launch_install_helper(
        Some(app),
        &installer,
        &current_exe,
        &version,
        &sha256,
        installation_message,
    )
    .await?;
    state.stop_all_runs();
    emit_progress(
        app,
        "restarting",
        Some(100),
        "Opening the updated Hormachuelos app…",
    );
    tokio::time::sleep(std::time::Duration::from_millis(450)).await;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    download_url: String,
    version: String,
    sha256: String,
) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err(
            "This is a local debug build. Installing the GitHub release would replace it with the older published app.".into(),
        );
    }
    if UPDATE_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("An app update is already running.".into());
    }
    let result = install_app_update_inner(&app, &state, download_url, version, sha256).await;
    UPDATE_RUNNING.store(false, Ordering::SeqCst);
    if result.is_err() {
        emit_progress(
            &app,
            "error",
            None,
            "The internal update could not be completed.",
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{overall_download_percent, validate_download_url, validate_sha256, validate_version};

    #[test]
    fn download_percent_covers_known_and_unknown_sizes() {
        assert_eq!(overall_download_percent(0, Some(100)), 1);
        assert_eq!(overall_download_percent(50, Some(100)), 40);
        assert_eq!(overall_download_percent(100, Some(100)), 80);
        assert!(overall_download_percent(40 * 1024 * 1024, None) < 80);
        assert_eq!(overall_download_percent(80 * 1024 * 1024, None), 79);
    }

    #[test]
    fn accepts_plain_semver_and_numeric_revision_builds() {
        assert_eq!(validate_version("v0.1.9").unwrap(), "0.1.9");
        assert_eq!(validate_version("v1.2.11-1").unwrap(), "1.2.11-1");
        assert!(validate_version("0.1").is_err());
        assert!(validate_version("0.1.9;calc").is_err());
        assert!(validate_version("1.2.11-beta").is_err());
        assert!(super::is_version_newer("1.2.11-1", "1.2.11").unwrap());
        assert!(super::is_version_newer("1.2.11", "1.0.2").unwrap());
        assert!(!super::is_version_newer("1.2.11", "1.2.11-1").unwrap());
        assert!(!super::is_version_newer("1.2.11-1", "1.2.11-1").unwrap());
        assert!(super::is_version_newer("1.2.12", "1.2.11-beta").unwrap());
    }

    #[test]
    fn requires_a_full_sha256_checksum() {
        assert!(validate_sha256(&"a".repeat(64)).is_ok());
        assert!(validate_sha256("abc123").is_err());
        assert!(validate_sha256(&"z".repeat(64)).is_err());
    }

    #[test]
    fn restricts_updates_to_the_optimized_release_channel() {
        assert!(validate_download_url(
            "https://chmoralla-code.github.io/HORMACHUELOS-OPTIMIZED/downloads/Hormachuelos_Optimized_0.1.9_x64-setup.exe",
            "0.1.9"
        )
        .is_ok());
        assert!(validate_download_url(
            "https://github.com/chmoralla-code/HORMACHUELOS-OPTIMIZED/releases/download/v0.1.9/Hormachuelos_Optimized_0.1.9_x64.msi",
            "0.1.9"
        )
        .is_ok());
        assert!(validate_download_url(
            "https://github.com/chmoralla-code/HORMACHUELOS-OPTIMIZED/releases/download/v1.2.11-1/Hormachuelos_Optimized_1.2.11-1_x64-setup.exe",
            "1.2.11-1"
        )
        .is_ok());
        assert!(validate_download_url(
            "http://chmoralla-code.github.io/HORMACHUELOS-OPTIMIZED/downloads/Hormachuelos_Optimized_0.1.9_x64-setup.exe",
            "0.1.9"
        )
        .is_err());
        assert!(validate_download_url(
            "https://github.com/chmoralla-code/HORMACHUELOS/releases/download/v0.1.9/Hormachuelos_0.1.9_x64-setup.exe",
            "0.1.9"
        )
        .is_err());
        assert!(validate_download_url(
            "https://github.com/chmoralla-code/HORMACHUELOS-OPTIMIZED/releases/download/v0.1.8/Hormachuelos_Optimized_0.1.8_x64-setup.exe",
            "0.1.9"
        )
        .is_err());
        assert!(validate_download_url(
            "https://example.com/Hormachuelos_Optimized_0.1.9_x64-setup.exe",
            "0.1.9"
        )
        .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn update_helper_shows_secure_progress_while_the_silent_installer_runs() {
        let script = super::install_helper_script();
        assert!(script.contains("param("));
        assert!(!script.contains("$args["));
        assert!(script.contains("[IO.File]::WriteAllText("));
        assert!(script.contains("ready:$ExpectedVersion"));
        assert!(script.contains("Assert-InstallerHash"));
        assert!(script.contains("Resolve-HormachuelosPath -RequireExpectedVersion $true"));
        assert!(script.contains("'/i', $quotedInstaller, '/quiet', '/norestart'"));
        assert!(script.contains("'/S', '/UPDATE'"));
        assert!(script.contains("-WindowStyle Hidden"));
        assert!(!script.contains("'/passive'"));
        assert!(!script.contains("'AUTOLAUNCHAPP=True'"));
        assert!(!script.contains("'/R'"));
        assert!(!script.contains("$nativeRestarted"));
        assert!(script.contains("New-InstallStatusWindow"));
        assert!(script.contains("Wait-InstallerWithStatus"));
        assert!(script.contains("Set-InstallStatus"));
        assert!(script.contains("Close-InstallStatusWindow"));
        assert!(script.contains("Update percent"));
        assert!(script.contains("Restarting…"));
        assert!(!script.contains("INSTALL // 03 OF 04"));
        assert!(!script.contains("INSTALL SEQUENCE"));
        assert!(script.contains("[System.Windows.Forms.Application]::DoEvents()"));
        assert!(script.contains("Start-Process -FilePath $launchPath"));
        assert_eq!(
            script
                .matches("Start-Process -FilePath $launchPath")
                .count(),
            1
        );
        assert!(script.contains("update failure"));
    }

    #[cfg(windows)]
    #[test]
    fn msi_updates_request_administrator_approval_before_closing_the_app() {
        let bootstrap = super::elevation_bootstrap_script();
        assert!(bootstrap.contains("-Verb RunAs"));
        assert!(bootstrap.contains("-PassThru -Wait"));
        assert!(bootstrap.contains("Administrator approval was not granted"));
        assert!(super::installer_requires_administrator_elevation(
            std::path::Path::new(r"C:\Temp\Hormachuelos.msi")
        ));
        assert!(!super::installer_requires_administrator_elevation(
            std::path::Path::new(r"C:\Temp\Hormachuelos.exe")
        ));
    }

    #[cfg(windows)]
    #[test]
    fn update_helper_is_started_as_a_real_powershell_file() {
        let helper = std::path::Path::new(r"C:\Temp Folder\update-helper.ps1");
        let installer = std::path::Path::new(r"C:\Temp Folder\Hormachuelos update.exe");
        let app = std::path::Path::new(
            r"C:\Program Files\Hormachuelos Optimized\hormachuelos-optimized.exe",
        );
        let bootstrap = std::path::Path::new(r"C:\Temp Folder\update-elevation.ps1");
        let ready = std::path::Path::new(r"C:\Temp Folder\update.ready");
        let log = std::path::Path::new(r"C:\Temp Folder\update.log");
        let sha256 = "a".repeat(64);
        let options = super::InstallHelperCommand {
            helper_path: helper,
            bootstrap_path: bootstrap,
            installer,
            current_exe: app,
            expected_version: "0.1.12",
            expected_sha256: &sha256,
            ready_path: ready,
            log_path: log,
            parent_id: 4321,
        };
        let command = super::install_helper_command(&options);
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert_eq!(command.get_program(), "powershell.exe");
        assert!(args.iter().any(|arg| arg == "-WindowStyle"));
        assert!(args.iter().any(|arg| arg == "Hidden"));
        assert!(args.iter().any(|arg| arg == "-File"));
        assert!(!args.iter().any(|arg| arg == "-Command"));
        let file_index = args.iter().position(|arg| arg == "-File").unwrap();
        assert_eq!(args[file_index + 1], helper.to_string_lossy());
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-ParentProcessId", "4321"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-InstallerPath", installer.to_string_lossy().as_ref()]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-AppPath", app.to_string_lossy().as_ref()]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-ExpectedVersion", "0.1.12"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-ExpectedSha256", sha256.as_str()]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-BootstrapPath", bootstrap.to_string_lossy().as_ref()]));

        let elevated = super::elevation_bootstrap_command(&options);
        let elevated_args: Vec<String> = elevated
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let elevated_file_index = elevated_args.iter().position(|arg| arg == "-File").unwrap();
        assert_eq!(
            elevated_args[elevated_file_index + 1],
            bootstrap.to_string_lossy()
        );
        assert!(elevated_args
            .windows(2)
            .any(|pair| pair == ["-HelperPath", helper.to_string_lossy().as_ref()]));
    }

    #[cfg(windows)]
    #[test]
    fn detects_the_installed_windows_installer_family() {
        let directory = std::env::temp_dir().join(format!(
            "hormachuelos-install-kind-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let app = directory.join("hormachuelos-optimized.exe");
        std::fs::write(&app, []).unwrap();

        assert_eq!(super::install_kind_for_executable(&app), "msi");
        std::fs::write(directory.join("uninstall.exe"), []).unwrap();
        assert_eq!(super::install_kind_for_executable(&app), "nsis");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn update_helper_failure_is_acknowledged_before_the_app_can_exit() {
        let directory = std::env::temp_dir().join(format!(
            "hormachuelos-update-helper-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let missing_installer = directory.join("missing-installer.exe");
        let current_exe = std::env::current_exe().unwrap();

        let error = super::launch_install_helper(
            None,
            &missing_installer,
            &current_exe,
            "9.9.9",
            &"a".repeat(64),
            "Starting the internal installer…",
        )
        .await
        .unwrap_err();

        assert!(error.contains("exit code 10"), "{error}");
        assert!(error.contains("Hormachuelos stayed open"), "{error}");
        let _ = std::fs::remove_dir_all(directory);
    }
}
