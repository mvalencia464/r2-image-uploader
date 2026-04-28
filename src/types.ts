export type R2Settings = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
};

export type BatchEvent =
  | { type: "start"; total: number }
  | { type: "progress"; current: number; total: number; file: string }
  | {
      type: "file_done";
      source: string;
      avifKey: string;
      webpKey: string;
      avifUrl: string;
      webpUrl: string;
    }
  | { type: "file_failed"; file: string; message: string }
  | { type: "error"; message: string }
  | { type: "complete"; ok: boolean; results?: UploadRow[]; message?: string };

export type UploadRow = {
  source: string;
  avifKey: string;
  webpKey: string;
  avifUrl: string;
  webpUrl: string;
};
