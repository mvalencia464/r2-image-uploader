# R2 Image Uploader

Desktop app for **bulk image processing** on your machine: resize (longest edge ≤ 1920, no upscaling), encode **AVIF** and **WebP** in parallel with [Sharp](https://sharp.pixelplumbing.com/), and upload to **Cloudflare R2** (S3-compatible). Built with **Tauri 2**, **React**, and **TypeScript**.

R2 credentials and bucket settings are stored locally via the app (not in this repo). Do not commit real API keys.

## Requirements

- [Node.js](https://nodejs.org/) on your `PATH` (the Rust shell spawns `node` for `node-worker/process.mjs`)
- [Rust](https://rustup.rs/) and platform tooling for Tauri (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))

## Development

```bash
npm install
npm run dev
```

## Build (macOS app)

```bash
npm run build
```

Release bundles include `node-worker` as a resource; for a fully standalone `.app` without a system Node, you would need to ship a Node binary or replace the worker with a compiled sidecar.

## Processing behavior (worker)

- Resize: `fit: "inside"`, max edge 1920, `withoutEnlargement: true`, auto `rotate()` from EXIF
- Outputs: AVIF (quality 55) and WebP (quality 80), uploaded with AWS SDK v3 to your R2 bucket

## License

Private / use at your own discretion unless you add an explicit license.
