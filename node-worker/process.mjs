/**
 * Node sidecar: stdin JSON job → NDJSON events on stdout.
 * Invoked by the Tauri host with `node process.mjs` (see Rust).
 */
import dns from "node:dns";
import https from "node:https";
import { lstat, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import sharp from "sharp";

// Prefer IPv4 first — avoids TLS handshake issues some Mac/Node builds see with Cloudflare R2 over IPv6.
dns.setDefaultResultOrder("ipv4first");

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function errMsg(message, extra = {}) {
  out({ type: "error", message, ...extra });
}

const SUPPORTED_SOURCE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".tif",
  ".tiff",
  ".gif",
  ".bmp",
  ".avif",
  ".heic",
  ".heif",
]);

function isSupportedImagePath(p) {
  const e = extname(p).toLowerCase();
  return SUPPORTED_SOURCE_EXTENSIONS.has(e);
}

async function collectImagePaths(paths) {
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
      if (isSupportedImagePath(p)) files.push(p);
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
    else if (e.isFile() && isSupportedImagePath(full)) acc.push(full);
  }
}

/** Sanitize optional folder prefix inside the bucket (client / site slug). */
function normalizeKeyPrefix(raw) {
  if (raw == null || typeof raw !== "string") return "";
  const s = raw.trim().replace(/^\/+|\/+$/g, "");
  if (!s) return "";
  if (!/^[a-zA-Z0-9/_.-]+$/.test(s)) {
    throw new Error(
      "Object key prefix may only contain letters, numbers, and . - _ / (no spaces or .. )",
    );
  }
  if (s.includes("..")) throw new Error("Invalid object key prefix");
  return s;
}

function objectKeys(prefix, originalPath) {
  const base = basename(originalPath, extname(originalPath));
  const avifName = `${base}.avif`;
  const webpName = `${base}.webp`;
  if (!prefix) {
    return { avifKey: avifName, webpKey: webpName };
  }
  return {
    avifKey: `${prefix}/${avifName}`,
    webpKey: `${prefix}/${webpName}`,
  };
}

function joinPublicUrl(base, key) {
  if (!base) return key;
  return `${base.replace(/\/$/, "")}/${key.replace(/^\//, "")}`;
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(max, Math.max(min, Math.round(x)));
}

function formatErrorDetail(err) {
  if (!(err instanceof Error)) return String(err);
  const code = err.code ? `code=${String(err.code)}` : "";
  const cause = err.cause;
  const causeCode =
    cause && typeof cause === "object" && "code" in cause
      ? ` cause.code=${String(cause.code)}`
      : "";
  const causeMsg =
    cause && typeof cause === "object" && "message" in cause
      ? ` cause.message=${String(cause.message)}`
      : "";
  const msg = err.message || err.name || "unknown error";
  return [msg, code, causeCode, causeMsg].filter(Boolean).join(" | ");
}

function normalizeExtensions(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [".avif", ".webp"];
  const cleaned = raw
    .map((e) => String(e || "").trim().toLowerCase())
    .filter((e) => e !== "")
    .map((e) => (e.startsWith(".") ? e : `.${e}`));
  return cleaned.length > 0 ? Array.from(new Set(cleaned)) : [".avif", ".webp"];
}

function matchesExtension(key, exts) {
  const k = key.toLowerCase();
  return exts.some((ext) => k.endsWith(ext));
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

const MAX_EDGE = 1920;

function sanitizeAccountId(raw) {
  let s = (raw || "").trim();
  // Strip protocol if present
  s = s.replace(/^https?:\/\//i, "");
  // Strip the R2 domain if they pasted the whole thing
  s = s.replace(/\.r2\.cloudflarestorage\.com\/?$/i, "");
  // Strip any trailing slashes or path parts
  s = s.split("/")[0];
  return s.trim();
}

function isValidAccountId(accountId) {
  return /^[a-f0-9]{32}$/i.test(accountId);
}

function makeS3Client(r2) {
  const accountId = sanitizeAccountId(r2.accountId);
  const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 50,
  });
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: (r2.accessKeyId || "").trim(),
      secretAccessKey: (r2.secretAccessKey || "").trim(),
    },
    requestHandler: new NodeHttpHandler({
      httpsAgent,
      requestTimeout: 300_000,
      connectionTimeout: 30_000,
    }),
  });
}

async function main() {
  let job;
  try {
    job = await readStdinJson();
  } catch (e) {
    errMsg(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const action = job?.action === "list_urls" ? "list_urls" : "upload";
  const { paths, r2 } = job;
  const accountId = sanitizeAccountId(r2?.accountId);
  const accessKeyId = (r2?.accessKeyId || "").trim();
  const secretAccessKey = (r2?.secretAccessKey || "").trim();
  const bucket = (r2?.bucket || "").trim();

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    errMsg("Invalid job: missing R2 credentials or bucket (ensure they are not empty)");
    process.exit(1);
  }
  if (!isValidAccountId(accountId)) {
    errMsg(
      `Invalid Account ID after normalization: "${accountId}". Expected 32 hex chars (did you mix up 1 and l?)`,
    );
    process.exit(1);
  }

  // Help debugging: tell the user which Account ID we are actually using (partially masked)
  const maskedId = accountId.length > 8 
    ? `${accountId.slice(0, 4)}...${accountId.slice(-4)}`
    : accountId;
  out({ type: "info", message: `Connecting to R2 endpoint for Account ID: ${maskedId}` });

  const publicBase = (r2.publicBaseUrl || "").replace(/\/$/, "");
  const client = makeS3Client({ ...r2, accountId, accessKeyId, secretAccessKey, bucket });

  // Early network/auth preflight so we fail once with a useful error.
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    out({ type: "info", message: `Preflight OK for bucket: ${bucket}` });
  } catch (e) {
    const detail = formatErrorDetail(e);
    errMsg(`R2 preflight failed: ${detail}`);
    process.exit(1);
  }

  if (action === "list_urls") {
    let prefix;
    try {
      prefix = normalizeKeyPrefix(job.prefix || "");
    } catch (e) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
      process.exit(1);
    }
    const extensions = normalizeExtensions(job.extensions);
    const items = [];
    let token;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix || undefined,
          ContinuationToken: token,
          MaxKeys: 1000,
        }),
      );
      for (const obj of page.Contents || []) {
        if (!obj.Key || !matchesExtension(obj.Key, extensions)) continue;
        items.push({
          key: obj.Key,
          url: joinPublicUrl(publicBase, obj.Key),
        });
      }
      token = page.NextContinuationToken;
    } while (token);
    process.stdout.write(JSON.stringify({ ok: true, items }));
    return;
  }

  if (!Array.isArray(paths) || paths.length === 0) {
    errMsg("No paths to process");
    process.exit(1);
  }

  let keyPrefix;
  try {
    keyPrefix = normalizeKeyPrefix(r2.keyPrefix);
  } catch (e) {
    errMsg(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const avifQ = clampInt(r2.avifQuality, 1, 100, 58);
  const webpQ = clampInt(r2.webpQuality, 1, 100, 82);
  const sourceImages = await collectImagePaths(paths);
  if (sourceImages.length === 0) {
    out({ type: "complete", ok: true, results: [], message: "No supported image files found" });
    return;
  }

  const total = sourceImages.length;
  out({ type: "start", total });

  const results = [];
  let failCount = 0;

  for (let i = 0; i < sourceImages.length; i++) {
    const filePath = sourceImages[i];
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

      const { avifKey, webpKey } = objectKeys(keyPrefix, filePath);

      const [avifBuf, webpBuf] = await Promise.all([
        pipeline.clone().avif({ quality: avifQ, effort: 4 }).toBuffer(),
        pipeline.clone().webp({ quality: webpQ, effort: 4 }).toBuffer(),
      ]);

      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: avifKey,
          Body: avifBuf,
          ContentType: "image/avif",
        }),
      );
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: webpKey,
          Body: webpBuf,
          ContentType: "image/webp",
        }),
      );

      const avifUrl = joinPublicUrl(publicBase, avifKey);
      const webpUrl = joinPublicUrl(publicBase, webpKey);

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
      failCount += 1;
      const message = formatErrorDetail(e);
      errMsg(message, { file: filePath });
      out({ type: "file_failed", file: filePath, message });
    }
  }

  const ok = failCount === 0;
  const summary =
    failCount === 0
      ? `Done: ${results.length} image(s) uploaded to R2.`
      : `Finished: ${results.length} uploaded, ${failCount} failed (see log above).`;
  out({ type: "complete", ok, results, message: summary });
}

main().catch((e) => {
  errMsg(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
