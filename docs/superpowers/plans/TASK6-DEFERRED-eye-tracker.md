# Task 6 (DEFERRED): Eye-tracker Swift sidecar

**Status:** Deferred 2026-06-09 by user. The app fully works without it — `eyePosition` stays `null`, so the Jarvis face's eyeballs rest centered. Wire this up later to make the eyes track the user's face.

Full step-by-step is in `2026-06-09-tavus-removal-jarvis-face.md` → "Task 6". This note records what's required plus the corrections found during review, so a future session can pick it up cleanly.

## What it does

A Swift binary (Tauri **sidecar**) opens the Mac camera, runs `VNDetectFaceRectanglesRequest` (~10 fps), and prints JSON lines to stdout (`{"x":0.52,"y":0.41}` top-left normalized, or `{"x":null,"y":null}`). A Rust module (`eye_tracker.rs`, behind the `eye-tracking` cargo feature) spawns it via `tauri-plugin-shell`, reads stdout, and emits `face-position` Tauri events. `App.tsx` already listens for `face-position` and feeds it to `<JarvisFace eyePosition=…>` — **the frontend side is already done** (Task 5).

## Files to create / modify

- **Create** `frontend/src-tauri/sidecar/jarvus-eye-tracker.swift` — AVFoundation capture + Vision face detect → JSON stdout. (Full source in the plan.)
- **Create** `scripts/build-sidecar.sh` — `swiftc -O sidecar/jarvus-eye-tracker.swift -o binaries/jarvus-eye-tracker-<triple>` where `<triple>` = `aarch64-apple-darwin` (or `x86_64-apple-darwin`). `chmod +x`.
- **Create** `frontend/src-tauri/src/eye_tracker.rs` — `spawn_eye_tracker(app)`: `app.shell().sidecar("jarvus-eye-tracker")?.spawn()?`, loop `rx.recv()`, on `CommandEvent::Stdout(bytes)` split on newlines, parse each `{x,y}` line, `app.emit("face-position", pos)`.
- **Modify** `frontend/src-tauri/tauri.conf.json` — add `"externalBin": ["binaries/jarvus-eye-tracker"]` under `"bundle"`.
- **Modify** `frontend/src-tauri/Cargo.toml` — add `tauri-plugin-shell = { version = "2", optional = true }`; add feature `eye-tracking = ["dep:tauri-plugin-shell"]`.
- **Modify** `frontend/src-tauri/src/lib.rs` — already has `#[cfg(feature="eye-tracking")] mod eye_tracker;` and the `spawn_eye_tracker(...)` call in setup. Still need to register the plugin in setup: `#[cfg(feature="eye-tracking")] app.handle().plugin(tauri_plugin_shell::init())?;`.
- **Modify** `frontend/package.json` — scripts `tauri:dev:full` / `tauri:build:full` = `tauri dev|build --features wake-word,eye-tracking`.

## Corrections to the original plan (apply these)

1. **Do NOT add `objc2-av-foundation`** to Cargo.toml. The AV work is all in the Swift sidecar; the Rust side needs only `tauri-plugin-shell`. The plan listed objc2 as a dep — it would be dead weight.
2. **Simplify** `let shell = match app.shell() { s => s };` → `let shell = app.shell();`.
3. **Verify the `tauri-plugin-shell` v2 API** against the installed crate. `CommandEvent::Stdout`'s payload is likely `Vec<u8>` (bytes) in v2 — handle newline-splitting and partial lines so multiple `face-position` events per buffer are emitted. Adapt imports/variants to whatever the installed version exposes.

## Known risks / gotchas

- **Camera permission:** in `tauri dev` the sidecar is a separate binary and may not inherit the app's TCC camera grant — it can fail silently or need a one-time permission. Works best from the **packaged `.app`** (which carries `Info.plist` `NSCameraUsageDescription`). Two processes share the camera (webview `getUserMedia` preview + the Swift sidecar) — macOS allows this.
- **Commit the compiled binary** under `binaries/` (build artifact; `build-sidecar.sh` regenerates it). Use `git add -f` if gitignored.
- **Verify the default build still passes** (`cargo build` with no features) — the feature is optional and must not affect it.

## Verify when done

`./scripts/build-sidecar.sh` → smoke-test the binary prints JSON → `cargo build --features wake-word,eye-tracking` Finishes → launch `npm run tauri:dev:full`, move your face left/right, eyeballs follow; log shows `[eye-tracker] sidecar started`.
