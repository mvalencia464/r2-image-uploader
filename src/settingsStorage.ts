import { BaseDirectory, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { R2Settings } from "./types";

const FILE = "r2-uploader-settings.json";

const empty: R2Settings = {
  accountId: "",
  accessKeyId: "",
  secretAccessKey: "",
  bucket: "",
  publicBaseUrl: "",
};

export async function loadSettings(): Promise<R2Settings> {
  try {
    const raw = await readTextFile(FILE, { baseDir: BaseDirectory.AppConfig });
    return { ...empty, ...JSON.parse(raw) };
  } catch {
    return { ...empty };
  }
}

export async function saveSettings(s: R2Settings): Promise<void> {
  await writeTextFile(FILE, JSON.stringify(s, null, 2), {
    baseDir: BaseDirectory.AppConfig,
  });
}
