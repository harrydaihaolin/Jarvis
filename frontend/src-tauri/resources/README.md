# Jarvus bundled resources

## `hey-jarvus.ppn` — custom wake word

The "Hey Jarvus" wake word is detected on-device by [Picovoice Porcupine](https://picovoice.ai).
Porcupine needs a custom keyword model file (`.ppn`) trained for your platform.

1. Sign in to the [Picovoice Console](https://console.picovoice.ai) (free tier).
2. Train a custom wake word **"Hey Jarvus"** for **macOS** and download the `.ppn`.
3. Save it here as `hey-jarvus.ppn`.
4. Put your `PICOVOICE_ACCESS_KEY` in the repo-root `.env`.
5. Build/run with the wake-word feature enabled:

   ```bash
   cd frontend
   npm run tauri:dev -- --features wake-word     # dev
   npm run tauri:build -- --features wake-word   # release
   ```

Without the `wake-word` feature (the default), the listener is a no-op and the app still runs;
start conversations from the UI instead.
