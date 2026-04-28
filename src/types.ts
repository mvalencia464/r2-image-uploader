export type R2Settings = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
  /** Optional path prefix inside the bucket, e.g. epsak or client/reviews */
  keyPrefix: string;
  /** 1–100, Sharp AVIF quality */
  avifQuality: number;
  /** 1–100, Sharp WebP quality (often a few points higher than AVIF for similar visual weight) */
  webpQuality: number;
};

export type BatchEvent =
  | { type: "start"; total: number }
  | { type: "progress"; current: number; total: number; file: string }
  | { type: "info"; message: string }
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
