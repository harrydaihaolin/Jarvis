// "Hey Jarvus" wake word detection.
//
// When built with the `wake-word` feature, a background thread initialises
// Picovoice Porcupine with the bundled custom keyword (resources/hey-jarvus.ppn),
// opens the default microphone via CPAL, and feeds 16 kHz mono frames to
// Porcupine. On detection it emits the Tauri `"wake-word"` event, which the
// frontend uses to start a Tavus conversation.
//
// Without the feature the listener is a no-op, so the default desktop build needs
// no Picovoice AccessKey or native Porcupine library.

#[cfg(feature = "wake-word")]
mod engine {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use porcupine::PorcupineBuilder;
    use std::sync::mpsc::channel;
    use tauri::path::BaseDirectory;
    use tauri::{AppHandle, Emitter, Manager};

    pub fn run(app: AppHandle) {
        let access_key = std::env::var("PICOVOICE_ACCESS_KEY").unwrap_or_default();
        if access_key.is_empty() {
            log::warn!("[wake-word] PICOVOICE_ACCESS_KEY not set — \"Hey Jarvus\" disabled.");
            return;
        }
        let ppn_path = match app.path().resolve("resources/hey-jarvus.ppn", BaseDirectory::Resource) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("[wake-word] could not resolve hey-jarvus.ppn: {e}");
                return;
            }
        };
        if !ppn_path.exists() {
            log::warn!(
                "[wake-word] keyword file missing at {:?} — \"Hey Jarvus\" disabled.",
                ppn_path
            );
            return;
        }

        std::thread::spawn(move || {
            let path = ppn_path.to_string_lossy().to_string();
            if let Err(e) = listen(app, &access_key, &path) {
                log::error!("[wake-word] listener stopped: {e}");
            }
        });
    }

    fn listen(app: AppHandle, access_key: &str, keyword_path: &str) -> Result<(), String> {
        let porcupine = PorcupineBuilder::new_with_keyword_paths(access_key, &[keyword_path])
            .init()
            .map_err(|e| format!("Porcupine init failed: {e:?}"))?;

        let frame_length = porcupine.frame_length() as usize;
        let required_sr = porcupine.sample_rate();

        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or("no default input device")?;
        let supported = device
            .default_input_config()
            .map_err(|e| e.to_string())?;
        if supported.sample_rate().0 != required_sr {
            log::warn!(
                "[wake-word] input sample rate {} != required {} Hz — detection may be unreliable.",
                supported.sample_rate().0,
                required_sr
            );
        }
        let channels = supported.channels().max(1) as usize;
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();

        let (tx, rx) = channel::<Vec<i16>>();
        let err_fn = |e| log::error!("[wake-word] stream error: {e}");

        // Downmix to mono by taking the first channel of each frame.
        let stream = match sample_format {
            cpal::SampleFormat::I16 => {
                let tx = tx.clone();
                device.build_input_stream(
                    &config,
                    move |data: &[i16], _: &_| {
                        let mono: Vec<i16> = data.iter().step_by(channels).copied().collect();
                        let _ = tx.send(mono);
                    },
                    err_fn,
                    None,
                )
            }
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config,
                move |data: &[f32], _: &_| {
                    let mono: Vec<i16> = data
                        .iter()
                        .step_by(channels)
                        .map(|s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                        .collect();
                    let _ = tx.send(mono);
                },
                err_fn,
                None,
            ),
            other => return Err(format!("unsupported sample format {other:?}")),
        }
        .map_err(|e| e.to_string())?;

        stream.play().map_err(|e| e.to_string())?;
        log::info!("[wake-word] listening for \"Hey Jarvus\"…");

        let mut buf: Vec<i16> = Vec::with_capacity(frame_length * 2);
        for chunk in rx {
            buf.extend_from_slice(&chunk);
            while buf.len() >= frame_length {
                let frame: Vec<i16> = buf.drain(..frame_length).collect();
                match porcupine.process(&frame) {
                    Ok(idx) if idx >= 0 => {
                        log::info!("[wake-word] \"Hey Jarvus\" detected.");
                        let _ = app.emit("wake-word", ());
                    }
                    Ok(_) => {}
                    Err(e) => log::error!("[wake-word] process error: {e:?}"),
                }
            }
        }
        Ok(())
    }
}

/// Start the background wake-word listener. No-op unless built with `wake-word`.
#[cfg(feature = "wake-word")]
pub fn spawn_wake_word_listener(app: tauri::AppHandle) {
    engine::run(app);
}

/// No-op listener used when the `wake-word` feature is disabled.
#[cfg(not(feature = "wake-word"))]
pub fn spawn_wake_word_listener(_app: tauri::AppHandle) {
    log::info!("[wake-word] built without the `wake-word` feature; \"Hey Jarvus\" disabled.");
}
