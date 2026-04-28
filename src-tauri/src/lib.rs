use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::Emitter;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct R2Settings {
  pub account_id: String,
  pub access_key_id: String,
  pub secret_access_key: String,
  pub bucket: String,
  pub public_base_url: String,
  pub key_prefix: String,
  pub avif_quality: u8,
  pub webp_quality: u8,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlRow {
  pub key: String,
  pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ListUrlsResponse {
  ok: bool,
  items: Option<Vec<UrlRow>>,
  error: Option<String>,
}

fn worker_script_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  if cfg!(debug_assertions) {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../node-worker/process.mjs");
    if p.exists() {
      return Ok(p);
    }
  }
  let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
  let direct = resource_dir.join("node-worker").join("process.mjs");
  if direct.exists() {
    return Ok(direct);
  }
  // Tauri bundle resources may be nested under `_up_` on macOS.
  let under_up = resource_dir
    .join("_up_")
    .join("node-worker")
    .join("process.mjs");
  if under_up.exists() {
    return Ok(under_up);
  }

  Err(format!(
    "Worker not found. Checked {} and {}.",
    direct.display(),
    under_up.display()
  ))
}

fn node_binary_path() -> Result<String, String> {
  if let Ok(explicit) = env::var("NODE_BINARY") {
    let trimmed = explicit.trim();
    if !trimmed.is_empty() {
      let p = PathBuf::from(trimmed);
      if p.exists() {
        return Ok(trimmed.to_string());
      }
    }
  }

  if let Some(path_os) = env::var_os("PATH") {
    for dir in env::split_paths(&path_os) {
      let candidate = dir.join("node");
      if candidate.exists() && candidate.is_file() {
        return Ok(candidate.to_string_lossy().to_string());
      }
    }
  }

  let common = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/opt/local/bin/node",
    "/usr/bin/node",
  ];
  for candidate in common {
    if Path::new(candidate).exists() {
      return Ok(candidate.to_string());
    }
  }

  if let Ok(home) = env::var("HOME") {
    let nvm_versions = PathBuf::from(&home).join(".nvm/versions/node");
    if nvm_versions.exists() {
      let mut candidates: Vec<PathBuf> = Vec::new();
      if let Ok(entries) = fs::read_dir(nvm_versions) {
        for entry in entries.flatten() {
          let node = entry.path().join("bin/node");
          if node.exists() && node.is_file() {
            candidates.push(node);
          }
        }
      }
      candidates.sort();
      if let Some(last) = candidates.last() {
        return Ok(last.to_string_lossy().to_string());
      }
    }
  }

  Err(
    "Node.js executable not found. Install Node.js, set NODE_BINARY, or ensure node is available in PATH."
      .to_string(),
  )
}

#[tauri::command]
async fn run_image_batch(
  app: tauri::AppHandle,
  paths: Vec<String>,
  settings: R2Settings,
) -> Result<(), String> {
  let node_bin = node_binary_path()?;
  let script = worker_script_path(&app)?;
  let payload = serde_json::json!({
    "paths": paths,
    "r2": {
      "accountId": settings.account_id,
      "accessKeyId": settings.access_key_id,
      "secretAccessKey": settings.secret_access_key,
      "bucket": settings.bucket,
      "publicBaseUrl": settings.public_base_url,
      "keyPrefix": settings.key_prefix,
      "avifQuality": settings.avif_quality,
      "webpQuality": settings.webp_quality,
    }
  });
  let mut child = Command::new(node_bin)
    .arg(&script)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| {
      format!("Failed to start `node` ({e}). Install Node.js and ensure it is on your PATH.")
    })?;
  if let Some(mut stdin) = child.stdin.take() {
    let body = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    stdin
      .write_all(body.as_bytes())
      .await
      .map_err(|e| e.to_string())?;
  }
  let stderr_handle = child.stderr.take();
  let stderr_task = async move {
    let mut v = Vec::new();
    if let Some(mut s) = stderr_handle {
      s.read_to_end(&mut v).await.ok();
    }
    v
  };
  let read_stderr = tokio::spawn(stderr_task);
  let stdout = child
    .stdout
    .take()
    .ok_or_else(|| "missing child stdout".to_string())?;
  let mut reader = BufReader::new(stdout).lines();
  while let Some(line) = reader.next_line().await.map_err(|e| e.to_string())? {
    if line.is_empty() {
      continue;
    }
    let v: serde_json::Value =
      serde_json::from_str(&line).unwrap_or_else(|_| serde_json::Value::String(line.clone()));
    app.emit("batch-event", v).map_err(|e| e.to_string())?;
  }
  drop(reader);
  let stderr_bytes = read_stderr.await.unwrap_or_default();
  let status = child.wait().await.map_err(|e| e.to_string())?;
  let stderr_text = String::from_utf8_lossy(&stderr_bytes);
  if !status.success() {
    return Err(format!(
      "Image worker exited with {status}. {}",
      stderr_text.trim()
    ));
  }
  Ok(())
}

#[tauri::command]
async fn run_list_public_urls(
  app: tauri::AppHandle,
  settings: R2Settings,
  prefix: String,
  extensions: Vec<String>,
) -> Result<Vec<UrlRow>, String> {
  let node_bin = node_binary_path()?;
  let script = worker_script_path(&app)?;
  let payload = serde_json::json!({
    "action": "list_urls",
    "prefix": prefix,
    "extensions": extensions,
    "r2": {
      "accountId": settings.account_id,
      "accessKeyId": settings.access_key_id,
      "secretAccessKey": settings.secret_access_key,
      "bucket": settings.bucket,
      "publicBaseUrl": settings.public_base_url,
      "keyPrefix": settings.key_prefix,
      "avifQuality": settings.avif_quality,
      "webpQuality": settings.webp_quality,
    }
  });

  let mut child = Command::new(node_bin)
    .arg(&script)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| {
      format!("Failed to start `node` ({e}). Install Node.js and ensure it is on your PATH.")
    })?;

  if let Some(mut stdin) = child.stdin.take() {
    let body = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    stdin
      .write_all(body.as_bytes())
      .await
      .map_err(|e| e.to_string())?;
  }

  let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
  let stdout = String::from_utf8_lossy(&out.stdout);
  let stderr = String::from_utf8_lossy(&out.stderr);

  if !out.status.success() {
    return Err(format!(
      "R2 list worker failed with {}. {}",
      out.status,
      stderr.trim()
    ));
  }

  let mut parsed: Option<ListUrlsResponse> = None;
  for line in stdout.lines() {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
      if v.get("ok").is_some() {
        let candidate: ListUrlsResponse =
          serde_json::from_value(v).map_err(|e| format!("Invalid list response payload: {e}"))?;
        parsed = Some(candidate);
      }
    }
  }
  let parsed = parsed.ok_or_else(|| {
    format!(
      "Failed to parse list response: missing final payload with `ok`. Raw: {}",
      stdout.trim()
    )
  })?;
  if !parsed.ok {
    return Err(parsed
      .error
      .unwrap_or_else(|| "Unknown list_urls worker error".to_string()));
  }
  Ok(parsed.items.unwrap_or_default())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![run_image_batch, run_list_public_urls])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
