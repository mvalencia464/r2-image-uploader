use serde::{Deserialize, Serialize};
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
  let res = app
    .path()
    .resource_dir()
    .map_err(|e| e.to_string())?
    .join("node-worker")
    .join("process.mjs");
  if res.exists() {
    return Ok(res);
  }
  Err(format!(
    "Worker not found. Dev path expected next to src-tauri, or bundled under Resources: {}",
    res.display()
  ))
}

#[tauri::command]
async fn run_image_batch(
  app: tauri::AppHandle,
  paths: Vec<String>,
  settings: R2Settings,
) -> Result<(), String> {
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
  let mut child = Command::new("node")
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

  let mut child = Command::new("node")
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

  let parsed: ListUrlsResponse = serde_json::from_str(stdout.trim())
    .map_err(|e| format!("Failed to parse list response: {e}. Raw: {}", stdout.trim()))?;
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
