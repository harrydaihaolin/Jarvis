// Session lifecycle + inactivity ("sleep") management for the always-listening
// Jarvus desktop app. After the wake word starts a Tavus conversation, the
// frontend hands the session here; an inactivity timer ends the conversation
// (stops billing) after JARVUS_IDLE_TIMEOUT_SECS of silence and emits
// "session-ended" so the UI returns to idle and Porcupine resumes listening.

use std::env;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

/// Default seconds of silence before a session auto-ends.
const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 300;

#[derive(Default)]
pub struct SessionState {
    inner: Arc<Mutex<SessionInner>>,
}

#[derive(Default)]
struct SessionInner {
    conversation_id: Option<String>,
    /// Monotonic token; bumping it invalidates any in-flight idle timer.
    generation: u64,
}

fn idle_timeout() -> Duration {
    let secs = env::var("JARVUS_IDLE_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_IDLE_TIMEOUT_SECS);
    Duration::from_secs(secs)
}

/// Begin tracking a freshly-created conversation and arm the idle timer.
#[tauri::command]
pub fn start_session(
    app: AppHandle,
    state: State<'_, SessionState>,
    conversation_id: String,
    conversation_url: Option<String>,
) {
    // conversation_url is accepted for parity with the frontend payload; only
    // the id is needed to end the conversation.
    let _ = conversation_url;
    {
        let mut inner = state.inner.lock().unwrap();
        inner.conversation_id = Some(conversation_id);
    }
    arm_idle_timer(&app, &state.inner);
    log::info!("[session] started; idle timeout = {:?}", idle_timeout());
}

/// Reset the inactivity timer (call on any audio/speech activity).
#[tauri::command]
pub fn reset_idle_timer(app: AppHandle, state: State<'_, SessionState>) {
    if state.inner.lock().unwrap().conversation_id.is_none() {
        return; // no active session
    }
    arm_idle_timer(&app, &state.inner);
}

/// End the active conversation now and return the app to idle.
#[tauri::command]
pub fn end_session(app: AppHandle, state: State<'_, SessionState>) {
    let conv_id = {
        let mut inner = state.inner.lock().unwrap();
        inner.generation = inner.generation.wrapping_add(1); // invalidate timers
        inner.conversation_id.take()
    };
    finish(app, conv_id);
}

/// Spawn (or re-arm) the inactivity timer. The latest call wins via `generation`.
fn arm_idle_timer(app: &AppHandle, inner: &Arc<Mutex<SessionInner>>) {
    let timeout = idle_timeout();
    let generation = {
        let mut g = inner.lock().unwrap();
        g.generation = g.generation.wrapping_add(1);
        g.generation
    };
    let app = app.clone();
    let inner = inner.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(timeout).await;
        let conv_id = {
            let mut g = inner.lock().unwrap();
            if g.generation != generation {
                return; // activity (or end) happened since this timer armed
            }
            g.generation = g.generation.wrapping_add(1);
            g.conversation_id.take()
        };
        log::info!("[session] idle timeout reached — ending session.");
        finish(app, conv_id);
    });
}

/// End the conversation with Tavus (best-effort) and notify the frontend.
fn finish(app: AppHandle, conversation_id: Option<String>) {
    tauri::async_runtime::spawn(async move {
        if let Some(id) = conversation_id {
            if let Err(e) = crate::tavus::end_conversation(id).await {
                log::warn!("[session] end_conversation failed: {e}");
            }
        }
        let _ = app.emit("session-ended", ());
    });
}
