import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadSettings, saveSettings } from "./settingsStorage";
import type { BatchEvent, ListedUrlRow, R2Settings, UploadRow } from "./types";

const SUPPORTED_SOURCE_FORMATS_LABEL =
  "Supported input formats: JPG, JPEG, PNG, WebP, TIFF, GIF, BMP, AVIF, HEIC, HEIF.";

function isSettingsReady(s: R2Settings): boolean {
  return (
    s.accountId.trim() !== "" &&
    s.accessKeyId.trim() !== "" &&
    s.secretAccessKey.trim() !== "" &&
    s.bucket.trim() !== ""
  );
}

function sanitizeAccountId(input: string): string {
  let s = input.trim();
  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/\.r2\.cloudflarestorage\.com\/?$/i, "");
  s = s.split("/")[0] ?? s;
  return s.trim();
}

function looksLikeAccountId(input: string): boolean {
  return /^[a-f0-9]{32}$/i.test(sanitizeAccountId(input));
}

export function App() {
  const [view, setView] = useState<"process" | "settings">("process");
  const [workflow, setWorkflow] = useState<"upload" | "list">("upload");
  const [settings, setSettings] = useState<R2Settings | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaveFeedback, setSettingsSaveFeedback] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [listedRows, setListedRows] = useState<ListedUrlRow[]>([]);
  const [listPrefix, setListPrefix] = useState("");
  const [listTypeFilter, setListTypeFilter] = useState<"both" | "avif" | "webp">("avif");
  const [listBusy, setListBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const unlisten = useRef<UnlistenFn | null>(null);
  const copyFeedbackTimeout = useRef<number | null>(null);

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  const pushLog = useCallback((m: string) => {
    setLog((l) => [...l.slice(-200), m]);
  }, []);

  useEffect(() => {
    const w = getCurrentWebviewWindow();
    let u: UnlistenFn | undefined;
    void w
      .onDragDropEvent((e) => {
        if (e.payload.type === "drop") {
          const pathsDropped = e.payload.paths;
          if (pathsDropped.length) {
            setPaths((p) => {
              const set = new Set([...p, ...pathsDropped]);
              return Array.from(set);
            });
          }
        }
      })
      .then((fn) => {
        u = fn;
      });
    return () => {
      u?.();
    };
  }, []);

  const runBatch = useCallback(async () => {
    if (!settings || !isSettingsReady(settings) || paths.length === 0 || busy) return;
    setErr(null);
    setBusy(true);
    setRows([]);
    setProgress(null);
    setLog([]);
    if (unlisten.current) {
      unlisten.current();
      unlisten.current = null;
    }
    unlisten.current = await listen<BatchEvent>("batch-event", (e) => {
      const p = e.payload;
      if (p.type === "start") {
        setProgress({ current: 0, total: p.total });
        pushLog(`Processing ${p.total} image(s)…`);
      } else if (p.type === "progress") {
        setProgress({ current: p.current, total: p.total });
        pushLog(`Image ${p.current} of ${p.total} — ${p.file}`);
      } else if (p.type === "info") {
        pushLog(`Info: ${p.message}`);
      } else if (p.type === "file_done") {
        setRows((r) => [
          ...r,
          {
            source: p.source,
            avifKey: p.avifKey,
            webpKey: p.webpKey,
            avifUrl: p.avifUrl,
            webpUrl: p.webpUrl,
          },
        ]);
      } else if (p.type === "file_failed") {
        pushLog(`Failed: ${p.file} — ${p.message}`);
      } else if (p.type === "error") {
        pushLog(p.message);
      } else if (p.type === "complete") {
        if (p.message) pushLog(p.message);
        setProgress((pr) => (pr ? { ...pr, current: pr.total } : pr));
      }
    });
    try {
      await invoke("run_image_batch", { paths, settings });
    } catch (e) {
      setErr(String(e));
    } finally {
      if (unlisten.current) {
        unlisten.current();
        unlisten.current = null;
      }
      setBusy(false);
    }
  }, [busy, paths, settings, pushLog]);

  const pickFiles = useCallback(async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Images",
          extensions: ["jpg", "jpeg", "png", "webp", "tif", "tiff", "gif", "bmp", "avif", "heic", "heif"],
        },
      ],
    });
    if (selected == null) return;
    const list = Array.isArray(selected) ? selected : [selected];
    setPaths((p) => {
      const set = new Set([...p, ...list]);
      return Array.from(set);
    });
  }, []);

  const pickFolder = useCallback(async () => {
    const selected = await open({ directory: true, multiple: true });
    if (selected == null) return;
    const list = Array.isArray(selected) ? selected : [selected];
    setPaths((p) => {
      const set = new Set([...p, ...list]);
      return Array.from(set);
    });
  }, []);

  const showCopyFeedback = useCallback((text: string) => {
    setCopyFeedback(text);
    if (copyFeedbackTimeout.current) {
      window.clearTimeout(copyFeedbackTimeout.current);
    }
    copyFeedbackTimeout.current = window.setTimeout(() => {
      setCopyFeedback(null);
      copyFeedbackTimeout.current = null;
    }, 1800);
  }, []);

  const copyText = useCallback(
    async (t: string, successMessage = "Copied to clipboard.") => {
      try {
        await navigator.clipboard.writeText(t);
        showCopyFeedback(successMessage);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    },
    [showCopyFeedback],
  );

  const allUrls = rows.map((r) => r.avifUrl).join("\n");
  const listedAllUrls = listedRows.map((r) => r.url).join("\n");

  const runListUrls = useCallback(async () => {
    if (!settings || !isSettingsReady(settings) || listBusy) return;
    setErr(null);
    setListBusy(true);
    try {
      const extensions =
        listTypeFilter === "avif"
          ? [".avif"]
          : listTypeFilter === "webp"
            ? [".webp"]
            : [".avif", ".webp"];
      const items = await invoke<ListedUrlRow[]>("run_list_public_urls", {
        settings,
        prefix: listPrefix,
        extensions,
      });
      setListedRows(items);
    } catch (e) {
      setErr(String(e));
    } finally {
      setListBusy(false);
    }
  }, [listBusy, listPrefix, listTypeFilter, settings]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeout.current) {
        window.clearTimeout(copyFeedbackTimeout.current);
      }
    };
  }, []);

  if (!settings) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-950 p-6 text-slate-100">
        <p className="text-slate-400">Loading…</p>
      </div>
    );
  }
  const normalizedAccountId = sanitizeAccountId(settings.accountId);
  const accountIdValid = looksLikeAccountId(settings.accountId);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <h1 className="text-lg font-semibold tracking-tight">R2 Image Uploader</h1>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
            onClick={() => setView("process")}
          >
            Process
          </button>
          <button
            type="button"
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
            onClick={() => setView("settings")}
          >
            R2 settings
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl p-4">
        {view === "settings" ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-400">Stored locally in your app config directory. Never committed to git by this app.</p>
            <div className="space-y-3">
              {(
                [
                  ["accountId", "Cloudflare Account ID"],
                  ["accessKeyId", "R2 Access Key ID"],
                  ["secretAccessKey", "R2 Secret Access Key"],
                  ["bucket", "Bucket name (e.g. media)"],
                  ["publicBaseUrl", "Public base URL (e.g. https://media.example.com or R2 public URL; no trailing slash)"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="block text-sm">
                  <span className="mb-1 block text-slate-400">{label}</span>
                  <input
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
                    value={settings[key]}
                    onChange={(e) => setSettings({ ...settings, [key]: e.target.value })}
                    type={key === "secretAccessKey" ? "password" : "text"}
                    autoComplete="off"
                  />
                </label>
              ))}
              {!accountIdValid && settings.accountId.trim() !== "" && (
                <p className="text-xs text-amber-400">
                  Account ID looks unusual. Expected 32 hex chars (for example `e1ef...`). If you paste a full
                  endpoint URL, the app strips it automatically.
                </p>
              )}
              {accountIdValid && (
                <p className="text-xs text-slate-500">
                  Endpoint preview:{" "}
                  <code className="text-slate-400">
                    {`https://${normalizedAccountId}.r2.cloudflarestorage.com`}
                  </code>
                </p>
              )}
              <div className="border-t border-slate-800 pt-4">
                <p className="mb-3 text-xs font-medium tracking-wide text-slate-500">PATH & COMPRESSION</p>
                <label className="mb-3 block text-sm">
                  <span className="mb-1 block text-slate-400">
                    Object key prefix (client or site slug, optional)
                  </span>
                  <input
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
                    value={settings.keyPrefix}
                    onChange={(e) => setSettings({ ...settings, keyPrefix: e.target.value })}
                    placeholder="e.g. epsak or acme-corp/case-studies"
                    autoComplete="off"
                  />
                  <span className="mt-1 block text-xs text-slate-500">
                    Files land at <code className="text-slate-400">{`{prefix}/filename.avif`}</code> in the bucket. Leave empty to use the bucket root.
                  </span>
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm">
                    <span className="mb-1 block text-slate-400">AVIF quality (1–100)</span>
                    <input
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
                      type="number"
                      min={1}
                      max={100}
                      value={settings.avifQuality}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        setSettings({
                          ...settings,
                          avifQuality: Number.isFinite(v) ? Math.min(100, Math.max(1, v)) : settings.avifQuality,
                        });
                      }}
                    />
                    <span className="mt-1 block text-xs text-slate-500">Default 58 (visually strong, smaller files).</span>
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1 block text-slate-400">WebP quality (1–100)</span>
                    <input
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
                      type="number"
                      min={1}
                      max={100}
                      value={settings.webpQuality}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        setSettings({
                          ...settings,
                          webpQuality: Number.isFinite(v) ? Math.min(100, Math.max(1, v)) : settings.webpQuality,
                        });
                      }}
                    />
                    <span className="mt-1 block text-xs text-slate-500">Default 82 (usually a bit higher than AVIF for similar look).</span>
                  </label>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={settingsSaving}
                onClick={() => {
                  setSettingsSaveFeedback(null);
                  setSettingsSaving(true);
                  void saveSettings(settings)
                    .then(() => {
                      setSettingsSaveFeedback({ kind: "ok", text: "Saved." });
                    })
                    .catch((e) => {
                      setSettingsSaveFeedback({
                        kind: "err",
                        text: e instanceof Error ? e.message : String(e),
                      });
                    })
                    .finally(() => {
                      setSettingsSaving(false);
                    });
                }}
              >
                {settingsSaving ? "Saving…" : "Save settings"}
              </button>
              {settingsSaveFeedback && (
                <span
                  className={
                    settingsSaveFeedback.kind === "err"
                      ? "text-sm text-rose-400"
                      : "text-sm text-emerald-400/90"
                  }
                >
                  {settingsSaveFeedback.text}
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="inline-flex rounded-lg border border-slate-700 bg-slate-900/50 p-1">
              <button
                type="button"
                className={`rounded-md px-3 py-1.5 text-sm ${workflow === "upload" ? "bg-slate-700 text-slate-100" : "text-slate-300 hover:bg-slate-800"}`}
                onClick={() => setWorkflow("upload")}
              >
                Upload images
              </button>
              <button
                type="button"
                className={`rounded-md px-3 py-1.5 text-sm ${workflow === "list" ? "bg-slate-700 text-slate-100" : "text-slate-300 hover:bg-slate-800"}`}
                onClick={() => setWorkflow("list")}
              >
                List URLs
              </button>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
              <label className="block text-sm">
                <span className="mb-1 block text-slate-400">
                  Default folder prefix for uploads and URL listing
                </span>
                <input
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
                  value={settings.keyPrefix}
                  onChange={(e) => setSettings({ ...settings, keyPrefix: e.target.value })}
                  placeholder="e.g. roofing or client/campaign"
                  autoComplete="off"
                />
                <span className="mt-1 block text-xs text-slate-500">
                  Set once here to avoid switching to Settings. Leave empty to use bucket root.
                </span>
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="rounded border border-slate-600 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={settingsSaving}
                  onClick={() => {
                    setSettingsSaveFeedback(null);
                    setSettingsSaving(true);
                    void saveSettings(settings)
                      .then(() => {
                        setSettingsSaveFeedback({ kind: "ok", text: "Default prefix saved." });
                      })
                      .catch((e) => {
                        setSettingsSaveFeedback({
                          kind: "err",
                          text: e instanceof Error ? e.message : String(e),
                        });
                      })
                      .finally(() => {
                        setSettingsSaving(false);
                      });
                  }}
                >
                  {settingsSaving ? "Saving…" : "Save default"}
                </button>
                {settingsSaveFeedback && (
                  <span
                    className={
                      settingsSaveFeedback.kind === "err"
                        ? "text-xs text-rose-400"
                        : "text-xs text-emerald-400/90"
                    }
                  >
                    {settingsSaveFeedback.text}
                  </span>
                )}
              </div>
            </div>

            {workflow === "upload" ? (
              <>
                <div
                  className={`grid min-h-40 place-content-center rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
                    busy ? "border-slate-700 text-slate-500" : "border-slate-600 text-slate-300 hover:border-emerald-700/60"
                  }`}
                >
                  <p className="font-medium">Drop image files or a folder here</p>
                  <p className="mt-1 text-sm text-slate-500">Requires real paths (use controls below to pick files or folder).</p>
                  <p className="mt-2 text-xs text-slate-500">{SUPPORTED_SOURCE_FORMATS_LABEL}</p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800"
                    onClick={() => void pickFiles()}
                    disabled={busy}
                  >
                    Add images…
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800"
                    onClick={() => void pickFolder()}
                    disabled={busy}
                  >
                    Add folder…
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-rose-800/50 px-3 py-2 text-sm text-rose-300 hover:bg-rose-950/40"
                    onClick={() => setPaths([])}
                    disabled={busy || paths.length === 0}
                  >
                    Clear list
                  </button>
                </div>

                {paths.length > 0 && (
                  <div className="max-h-36 overflow-auto rounded-lg border border-slate-800 bg-slate-900/50 p-2 text-xs text-slate-400">
                    {paths.map((p) => (
                      <div key={p} className="truncate font-mono">
                        {p}
                      </div>
                    ))}
                  </div>
                )}

                {progress && (
                  <div>
                    <div className="mb-1 flex justify-between text-sm text-slate-400">
                      <span>Progress</span>
                      <span>
                        {progress.current} of {progress.total} processed
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full bg-emerald-500 transition-all"
                        style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                )}

                {err && <p className="text-sm text-rose-400">{err}</p>}

                <button
                  type="button"
                  className="w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={busy || paths.length === 0 || !isSettingsReady(settings)}
                  onClick={() => void runBatch()}
                >
                  {busy ? "Processing…" : "Process & upload to R2"}
                </button>
                {!isSettingsReady(settings) && (
                  <p className="text-center text-sm text-amber-500/90">Add Account ID, API keys, and bucket in R2 settings.</p>
                )}
                {isSettingsReady(settings) && settings.keyPrefix.trim() !== "" && (
                  <p className="text-center text-xs text-slate-500">
                    R2 object path:{" "}
                    <code className="text-slate-400">
                      {settings.keyPrefix.replace(/\/$/, "")}/
                    </code>
                    filename.avif / .webp
                  </p>
                )}

                {log.length > 0 && (
                  <div className="max-h-40 overflow-auto rounded-lg border border-slate-800 bg-slate-900/40 p-2 font-mono text-xs text-slate-500">
                    {log.map((l, i) => (
                      <div key={`${i}-${l.slice(0, 20)}`}>{l}</div>
                    ))}
                  </div>
                )}

                {rows.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-sm font-medium text-slate-300">Uploaded</h2>
                      <button
                        type="button"
                        className="rounded border border-slate-600 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800"
                        onClick={() => void copyText(allUrls, "Copied all AVIF URLs.")}
                      >
                        Copy all AVIF URLs
                      </button>
                    </div>
                    {copyFeedback && <p className="text-xs text-emerald-400/90">{copyFeedback}</p>}
                    <ul className="space-y-3">
                      {rows.map((r) => (
                        <li key={r.source} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-sm">
                          <div className="mb-3 truncate rounded border border-slate-800 bg-slate-950/60 px-2 py-1 font-mono text-xs text-slate-400">
                            {r.source}
                          </div>
                          <div className="space-y-2">
                            <div className="flex flex-col gap-2 rounded border border-slate-800/80 bg-slate-950/40 p-2 sm:flex-row sm:items-center sm:justify-between">
                              <a
                                href={r.avifUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="truncate text-emerald-400/90 hover:underline"
                              >
                                {r.avifUrl}
                              </a>
                              <button
                                type="button"
                                className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                                onClick={() => void copyText(r.avifUrl, "Copied AVIF URL.")}
                              >
                                Copy AVIF URL
                              </button>
                            </div>
                            <div className="flex flex-col gap-2 rounded border border-slate-800/80 bg-slate-950/40 p-2 sm:flex-row sm:items-center sm:justify-between">
                              <a
                                href={r.webpUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="truncate text-sky-400/90 hover:underline"
                              >
                                {r.webpUrl}
                              </a>
                              <button
                                type="button"
                                className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                                onClick={() => void copyText(r.webpUrl, "Copied WebP URL.")}
                              >
                                Copy WebP URL
                              </button>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <>
                <label className="block text-sm">
                  <span className="mb-1 block text-slate-400">Prefix / folder path in bucket (optional)</span>
                  <input
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
                    value={listPrefix}
                    onChange={(e) => setListPrefix(e.target.value)}
                    placeholder={settings.keyPrefix || "e.g. roofing or client/campaign"}
                    autoComplete="off"
                  />
                  <span className="mt-1 block text-xs text-slate-500">
                    Lists <code className="text-slate-400">.avif</code> and <code className="text-slate-400">.webp</code> objects from this public path.
                    Defaults to AVIF (recommended for Astro image usage) and you can switch anytime.
                  </span>
                </label>
                <button
                  type="button"
                  className="rounded border border-slate-600 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800"
                  onClick={() => setListPrefix(settings.keyPrefix)}
                >
                  Use default prefix
                </button>
                <div className="space-y-2">
                  <p className="text-sm text-slate-400">Image type filter</p>
                  <div className="inline-flex rounded-lg border border-slate-700 bg-slate-900/50 p-1">
                    <button
                      type="button"
                      className={`rounded-md px-3 py-1.5 text-sm ${listTypeFilter === "both" ? "bg-slate-700 text-slate-100" : "text-slate-300 hover:bg-slate-800"}`}
                      onClick={() => setListTypeFilter("both")}
                    >
                      Both
                    </button>
                    <button
                      type="button"
                      className={`rounded-md px-3 py-1.5 text-sm ${listTypeFilter === "avif" ? "bg-slate-700 text-slate-100" : "text-slate-300 hover:bg-slate-800"}`}
                      onClick={() => setListTypeFilter("avif")}
                    >
                      AVIF only
                    </button>
                    <button
                      type="button"
                      className={`rounded-md px-3 py-1.5 text-sm ${listTypeFilter === "webp" ? "bg-slate-700 text-slate-100" : "text-slate-300 hover:bg-slate-800"}`}
                      onClick={() => setListTypeFilter("webp")}
                    >
                      WebP only
                    </button>
                  </div>
                </div>

                {err && <p className="text-sm text-rose-400">{err}</p>}

                <button
                  type="button"
                  className="w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={listBusy || !isSettingsReady(settings)}
                  onClick={() => void runListUrls()}
                >
                  {listBusy ? "Fetching URLs…" : "Fetch URLs from R2"}
                </button>
                {!isSettingsReady(settings) && (
                  <p className="text-center text-sm text-amber-500/90">Add Account ID, API keys, and bucket in R2 settings.</p>
                )}

                {listedRows.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-sm font-medium text-slate-300">
                        Retrieved URLs ({listedRows.length})
                      </h2>
                      <button
                        type="button"
                        className="rounded border border-slate-600 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800"
                        onClick={() => void copyText(listedAllUrls, "Copied all retrieved URLs.")}
                      >
                        Copy all URLs
                      </button>
                    </div>
                    {copyFeedback && <p className="text-xs text-emerald-400/90">{copyFeedback}</p>}
                    <ul className="max-h-96 space-y-2 overflow-auto">
                      {listedRows.map((r) => (
                        <li
                          key={r.key}
                          className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="min-w-0 space-y-1">
                            <div className="truncate font-mono text-xs text-slate-500">{r.key}</div>
                            <a
                              href={r.url}
                              target="_blank"
                              rel="noreferrer"
                              className="block truncate text-emerald-400/90 hover:underline"
                            >
                              {r.url}
                            </a>
                          </div>
                          <button
                            type="button"
                            className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                            onClick={() => void copyText(r.url, "Copied URL.")}
                          >
                            Copy URL
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
