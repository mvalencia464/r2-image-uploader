import { appConfigDir } from "@tauri-apps/api/path";
import { BaseDirectory, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { R2Settings } from "./types";

const FILE = "r2-uploader-settings.json";

const empty: R2Settings = {
  accountId: "",
  accessKeyId: "",
  secretAccessKey: "",
  bucket: "",
  publicBaseUrl: "",
  keyPrefix: "",
  avifQuality: 58,
  webpQuality: 82,
};

/** Ensure `BaseDirectory.AppConfig` exists (Tauri does not create it before first write). */
async function ensureAppConfigDir(): Promise<void> {
  const root = await appConfigDir();
  try {
    await mkdir(root, { recursive: true });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (!/already exists|file exists|EEXIST/i.test(m)) throw e;
  }
}

export async function loadSettings(): Promise<R2Settings> {
  await ensureAppConfigDir();
  try {
    const raw = await readTextFile(FILE, { baseDir: BaseDirectory.AppConfig });
    return { ...empty, ...JSON.parse(raw) };
  } catch {
    return { ...empty };
  }
}

export async function saveSettings(s: R2Settings): Promise<void> {
  await ensureAppConfigDir();
  await writeTextFile(FILE, JSON.stringify(s, null, 2), {
    baseDir: BaseDirectory.AppConfig,
  });
}
