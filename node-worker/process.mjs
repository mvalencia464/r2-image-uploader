/**
 * Node sidecar: stdin JSON job → NDJSON events on stdout.
 * Invoked by the Tauri host with `node process.mjs` (see Rust).
 */
import { lstat, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function errMsg(message, extra = {}) {
  out({ type: "error", message, ...extra });
}

function isJpegPath(p) {
  const e = extname(p).toLowerCase();
  return e === ".jpg" || e === ".jpeg";
}

async function collectJpegPaths(paths) {
  const files = [];
  for (const raw of paths) {
    const p = raw.replace(/\/$/, "");
    let st;
    try {
      st = await lstat(p);
    } catch (e) {
      errMsg(`Cannot access path: ${p}`, { path: p });
      continue;
    }
    if (st.isFile()) {
      if (isJpegPath(p)) files.push(p);
      continue;
    }
    if (st.isDirectory()) {
      await walkDir(p, files);
    }
  }
  return files;
}

async function walkDir(dir, acc) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkDir(full, acc);
    else if (e.isFile() && isJpegPath(full)) acc.push(full);
  }
}

function outputBasenames(originalPath) {
  const base = basename(originalPath, extname(originalPath));
  return {
    avifKey: `${base}.avif`,
    webpKey: `${base}.webp`,
  };
}

function readStdinText() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function readStdinJson() {
  const raw = await readStdinText();
  return JSON.parse(raw);
}

const AVIF_QUALITY = 55;
const WEBP_QUALITY = 80;
const MAX_EDGE = 1920;

async function main() {
  let job;
  try {
    job = await readStdinJson();
  } catch (e) {
    errMsg(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const { paths, r2 } = job;
  if (!r2?.accountId || !r2?.accessKeyId || !r2?.secretAccessKey || !r2?.bucket) {
    errMsg("Invalid job: missing R2 credentials or bucket");
    process.exit(1);
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    errMsg("No paths to process");
    process.exit(1);
  }

  const publicBase = (r2.publicBaseUrl || "").replace(/\/$/, "");
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
    },
  });

  const JPEGs = await collectJpegPaths(paths);
  if (JPEGs.length === 0) {
    out({ type: "complete", ok: true, results: [], message: "No JPEG files found" });
    return;
  }

  const total = JPEGs.length;
  out({ type: "start", total });

  const results = [];

  for (let i = 0; i < JPEGs.length; i++) {
    const filePath = JPEGs[i];
    const current = i + 1;
    out({ type: "progress", current, total, file: filePath });

    try {
      const pipeline = sharp(filePath, { failOn: "none" })
        .rotate()
        .resize({
          width: MAX_EDGE,
          height: MAX_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        });

      const { avifKey, webpKey } = outputBasenames(filePath);

      const [avifBuf, webpBuf] = await Promise.all([
        pipeline
          .clone()
          .avif({ quality: AVIF_QUALITY, effort: 4 })
          .toBuffer(),
        pipeline
          .clone()
          .webp({ quality: WEBP_QUALITY, effort: 4 })
          .toBuffer(),
      ]);

      await client.send(
        new PutObjectCommand({
          Bucket: r2.bucket,
          Key: avifKey,
          Body: avifBuf,
          ContentType: "image/avif",
        }),
      );
      await client.send(
        new PutObjectCommand({
          Bucket: r2.bucket,
          Key: webpKey,
          Body: webpBuf,
          ContentType: "image/webp",
        }),
      );

      const avifUrl = publicBase ? `${publicBase}/${avifKey}` : avifKey;
      const webpUrl = publicBase ? `${publicBase}/${webpKey}` : webpKey;

      const row = {
        source: filePath,
        avifKey,
        webpKey,
        avifUrl,
        webpUrl,
      };
      results.push(row);
      out({ type: "file_done", ...row });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errMsg(message, { file: filePath });
      out({ type: "file_failed", file: filePath, message });
    }
  }

  out({ type: "complete", ok: true, results });
}

main().catch((e) => {
  errMsg(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
