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

/// Spawn the persistent STT sidecar and forward its stdout JSON to the webview.
pub fn spawn_stt(app: AppHandle) {
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
        let mut buf = String::new();
        while let Some(event) = rx.recv().await {
            match event {
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
                                    if state == "error" || state == "denied" {
                                        log::warn!("[stt] {state}: {detail}");
                                    }
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
                    log::debug!("[stt] sidecar stderr: {}", String::from_utf8_lossy(&bytes).trim());
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
