// Speech-to-text bridge for the macOS Speech sidecar (jarvus-stt).
//
// Spawns the persistent sidecar, forwards its stdout JSON to the webview as
// `stt-partial` / `stt-final` / `stt-status` events, and exposes `stt_start` /
// `stt_stop` commands that write to the sidecar's stdin. Feature-gated behind
// `voice-input` so the default build needs no shell plugin or sidecar.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the running sidecar's handle so commands can be written to its stdin.
#[derive(Default)]
pub struct SttState {
    child: Mutex<Option<CommandChild>>,
}

/// Give up respawning after this many consecutive quick deaths (crash loop).
const MAX_QUICK_DEATHS: u32 = 5;
/// A sidecar that lived at least this long resets the crash-loop counter.
const HEALTHY_LIFETIME_SECS: u64 = 30;

/// Spawn the persistent STT sidecar and forward its stdout JSON to the webview.
pub fn spawn_stt(app: AppHandle) {
    spawn_stt_inner(app, 0);
}

/// Spawn the sidecar; on death, respawn with crash-loop protection. The webview
/// re-sends `start` when it sees the fresh sidecar's `ready` status.
fn spawn_stt_inner(app: AppHandle, quick_deaths: u32) {
    let sidecar = match app.shell().sidecar("jarvus-stt") {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[stt] sidecar not found: {e}");
            return;
        }
    };
    let (mut rx, child) = match sidecar.spawn() {
        Ok(pair) => pair,
        Err(e) => {
            log::warn!("[stt] spawn failed: {e}");
            return;
        }
    };
    app.state::<SttState>().child.lock().unwrap().replace(child);
    log::info!("[stt] sidecar started");

    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        let mut buf = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Terminated(payload) => {
                    app.state::<SttState>().child.lock().unwrap().take();
                    let lived = started.elapsed();
                    let deaths = if lived.as_secs() >= HEALTHY_LIFETIME_SECS { 0 } else { quick_deaths + 1 };
                    log::warn!(
                        "[stt] sidecar died (code={:?}, signal={:?}) after {lived:.0?}",
                        payload.code, payload.signal
                    );
                    if deaths >= MAX_QUICK_DEATHS {
                        log::error!("[stt] sidecar crash-looping — giving up");
                        let _ = app.emit(
                            "stt-status",
                            serde_json::json!({ "state": "error", "detail": "Speech sidecar keeps crashing — voice input disabled." }),
                        );
                        return;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    log::info!("[stt] respawning sidecar");
                    spawn_stt_inner(app, deaths);
                    return;
                }
                CommandEvent::Stdout(bytes) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(i) = buf.find('\n') {
                        let line: String = buf.drain(..=i).collect();
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                            let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("");
                            match v.get("type").and_then(|t| t.as_str()) {
                                Some("partial") => {
                                    let _ = app.emit("stt-partial", text);
                                }
                                Some("final") => {
                                    log::info!("[stt] final: {text:?}");
                                    let _ = app.emit("stt-final", text);
                                }
                                Some("status") => {
                                    let state =
                                        v.get("state").and_then(|t| t.as_str()).unwrap_or("");
                                    let detail =
                                        v.get("detail").and_then(|t| t.as_str()).unwrap_or("");
                                    log::info!("[stt] status: {state} {detail}");
                                    let _ = app.emit(
                                        "stt-status",
                                        serde_json::json!({ "state": state, "detail": detail }),
                                    );
                                }
                                _ => {}
                            }
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    log::info!("[stt] sidecar: {}", String::from_utf8_lossy(&bytes).trim());
                }
                _ => {}
            }
        }
    });
}

#[tauri::command]
pub fn stt_start(state: State<'_, SttState>) {
    write_cmd(&state, "start\n");
}

#[tauri::command]
pub fn stt_stop(state: State<'_, SttState>) {
    write_cmd(&state, "stop\n");
}

#[tauri::command]
pub fn stt_pause(state: State<'_, SttState>) {
    write_cmd(&state, "pause\n");
}

#[tauri::command]
pub fn stt_resume(state: State<'_, SttState>) {
    write_cmd(&state, "resume\n");
}

fn write_cmd(state: &State<'_, SttState>, cmd: &str) {
    let mut guard = state.child.lock().unwrap();
    match guard.as_mut() {
        Some(child) => {
            log::debug!("[stt] -> sidecar {:?}", cmd.trim());
            if let Err(e) = child.write(cmd.as_bytes()) {
                log::warn!("[stt] write failed: {e}");
            }
        }
        None => log::warn!("[stt] no sidecar to send {:?}", cmd.trim()),
    }
}
