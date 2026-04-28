import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadSettings, saveSettings } from "./settingsStorage";
import type { BatchEvent, R2Settings, UploadRow } from "./types";

function isSettingsReady(s: R2Settings): boolean {
  return (
    s.accountId.trim() !== "" &&
    s.accessKeyId.trim() !== "" &&
    s.secretAccessKey.trim() !== "" &&
    s.bucket.trim() !== ""
  );
}

export function App() {
  const [view, setView] = useState<"process" | "settings">("process");
  const [settings, setSettings] = useState<R2Settings | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const unlisten = useRef<UnlistenFn | null>(null);

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
    const selected = await open({ multiple: true, directory: false, filters: [{ name: "JPEG", extensions: ["jpg", "jpeg", "JPG", "JPEG"] }] });
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

  const copyText = (t: string) => {
    void navigator.clipboard.writeText(t);
  };

  if (!settings) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-950 p-6 text-slate-100">
        <p className="text-slate-400">Loading…</p>
      </div>
    );
  }

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
                  ["bucket", "Bucket name"],
                  ["publicBaseUrl", "Public base URL (e.g. https://media.example.com or https://…r2.dev)"],
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
            </div>
            <button
              type="button"
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
              onClick={() => void saveSettings(settings)}
            >
              Save settings
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div
              className={`grid min-h-40 place-content-center rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
                busy ? "border-slate-700 text-slate-500" : "border-slate-600 text-slate-300 hover:border-emerald-700/60"
              }`}
            >
              <p className="font-medium">Drop JPEG files or a folder here</p>
              <p className="mt-1 text-sm text-slate-500">Requires real paths (use controls below to pick files or folder).</p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800"
                onClick={() => void pickFiles()}
                disabled={busy}
              >
                Add JPEGs…
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

            {log.length > 0 && (
              <div className="max-h-40 overflow-auto rounded-lg border border-slate-800 bg-slate-900/40 p-2 font-mono text-xs text-slate-500">
                {log.map((l, i) => (
                  <div key={`${i}-${l.slice(0, 20)}`}>{l}</div>
                ))}
              </div>
            )}

            {rows.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-sm font-medium text-slate-300">Uploaded</h2>
                <ul className="space-y-3">
                  {rows.map((r) => (
                    <li key={r.source} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-sm">
                      <div className="mb-2 truncate text-slate-500">{r.source}</div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <a
                          href={r.avifUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate text-emerald-400/90 hover:underline"
                        >
                          {r.avifUrl}
                        </a>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                            onClick={() => copyText(r.avifUrl)}
                          >
                            Copy AVIF URL
                          </button>
                          <button
                            type="button"
                            className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                            onClick={() => copyText(r.webpUrl)}
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
          </div>
        )}
      </main>
    </div>
  );
}
