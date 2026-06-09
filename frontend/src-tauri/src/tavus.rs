// Server-side (Rust) Tavus client for the desktop app. Keeps TAVUS_API_KEY out
// of the webview/JS. Mirrors lib/tavus.mjs: ensure a persona wired to the Claude
// proxy, then create/end conversations. Config comes from the repo-root .env
// (found by walking up from the working dir) or the process environment.

use serde::Serialize;
use serde_json::{json, Value};
use std::env;
use std::sync::Mutex;
use tauri::State;

const TAVUS_BASE: &str = "https://tavusapi.com/v2";

/// Process-wide cache of the persona id so we don't recreate it every call.
#[derive(Default)]
pub struct AppState {
    persona_id: Mutex<Option<String>>,
}

#[derive(Serialize, Clone)]
pub struct ConversationInfo {
    pub conversation_id: String,
    pub conversation_url: String,
    pub status: String,
    pub test_mode: bool,
}

struct Config {
    tavus_api_key: String,
    replica_id: String,
    persona_id: Option<String>,
    anthropic_model: String,
    proxy_api_key: String,
    public_proxy_base_url: String,
    use_hosted: bool,
    hosted_model: String,
    persona_name: String,
    system_prompt: String,
    greeting: String,
    test_mode: bool,
}

fn var_or(key: &str, default: &str) -> String {
    env::var(key).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string())
}

fn is_true(key: &str, default: bool) -> bool {
    match env::var(key) {
        Ok(v) if !v.is_empty() => v == "true",
        _ => default,
    }
}

fn load_config() -> Result<Config, String> {
    // Best-effort: load a .env from the cwd or any parent (dev runs from frontend/).
    let _ = dotenvy::dotenv();
    let tavus_api_key = env::var("TAVUS_API_KEY")
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or("TAVUS_API_KEY is not set (add it to the repo-root .env or the environment).")?;
    Ok(Config {
        tavus_api_key,
        replica_id: var_or("TAVUS_REPLICA_ID", "r90bbd427f71"),
        persona_id: env::var("TAVUS_PERSONA_ID").ok().filter(|v| !v.is_empty()),
        anthropic_model: var_or("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
        proxy_api_key: var_or("PROXY_API_KEY", ""),
        public_proxy_base_url: var_or("PUBLIC_PROXY_BASE_URL", ""),
        use_hosted: is_true("USE_TAVUS_HOSTED_LLM", false),
        hosted_model: var_or("TAVUS_HOSTED_MODEL", "tavus-claude-haiku-4.5"),
        persona_name: var_or("PERSONA_NAME", "Jarvus"),
        system_prompt: var_or(
            "PERSONA_SYSTEM_PROMPT",
            "You are Jarvus, a capable personal agent with a face and voice, powered by Claude.",
        ),
        greeting: var_or(
            "PERSONA_GREETING",
            "Hey — I'm Jarvus. What do you need?",
        ),
        test_mode: is_true("TAVUS_TEST_MODE", true),
    })
}

/// Resolve the public URL Tavus uses to reach the proxy (Option B only).
async fn resolve_public_base_url(cfg: &Config) -> Result<Option<String>, String> {
    if cfg.use_hosted {
        return Ok(None);
    }
    if !cfg.public_proxy_base_url.is_empty() {
        return Ok(Some(cfg.public_proxy_base_url.trim_end_matches('/').to_string()));
    }
    // Auto-detect a running ngrok tunnel.
    if let Ok(resp) = reqwest::get("http://localhost:4040/api/tunnels").await {
        if let Ok(body) = resp.json::<Value>().await {
            if let Some(tunnels) = body.get("tunnels").and_then(|t| t.as_array()) {
                for t in tunnels {
                    if let Some(url) = t.get("public_url").and_then(|u| u.as_str()) {
                        if url.starts_with("https://") {
                            return Ok(Some(format!("{}/v1", url.trim_end_matches('/'))));
                        }
                    }
                }
            }
        }
    }
    Err("Could not determine the proxy's public URL. Start ngrok (docker compose up) or set PUBLIC_PROXY_BASE_URL in .env.".into())
}

async fn build_llm_layer(cfg: &Config) -> Result<Value, String> {
    if cfg.use_hosted {
        return Ok(json!({ "model": cfg.hosted_model }));
    }
    let base_url = resolve_public_base_url(cfg).await?.unwrap();
    let mut layer = json!({
        "model": cfg.anthropic_model,
        "base_url": base_url,
        "speculative_inference": true,
    });
    if !cfg.proxy_api_key.is_empty() {
        layer["api_key"] = json!(cfg.proxy_api_key);
    }
    Ok(layer)
}

async fn tavus_post(cfg: &Config, path: &str, body: Option<Value>) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let mut req = client
        .post(format!("{TAVUS_BASE}{path}"))
        .header("x-api-key", &cfg.tavus_api_key)
        .header("Content-Type", "application/json");
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.map_err(|e| format!("Tavus request failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Tavus {path} -> {status}: {text}"));
    }
    if text.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad Tavus JSON: {e}"))
}

async fn ensure_persona(cfg: &Config, cached: &Mutex<Option<String>>) -> Result<String, String> {
    // Reuse a configured or previously-created persona.
    if let Some(id) = &cfg.persona_id {
        return Ok(id.clone());
    }
    if let Some(id) = cached.lock().unwrap().clone() {
        return Ok(id);
    }

    let llm = build_llm_layer(cfg).await?;
    let payload = json!({
        "persona_name": cfg.persona_name,
        "system_prompt": cfg.system_prompt,
        "pipeline_mode": "full",
        "default_replica_id": cfg.replica_id,
        "layers": {
            "perception": { "perception_model": "raven-1" },
            "conversational_flow": {
                "turn_detection_model": "sparrow-1",
                "turn_taking_patience": "high"
            },
            "llm": llm
        }
    });
    let resp = tavus_post(cfg, "/personas", Some(payload)).await?;
    let id = resp
        .get("persona_id")
        .and_then(|v| v.as_str())
        .ok_or("Tavus did not return a persona_id")?
        .to_string();
    *cached.lock().unwrap() = Some(id.clone());
    Ok(id)
}

#[tauri::command]
pub async fn create_conversation(state: State<'_, AppState>) -> Result<ConversationInfo, String> {
    let cfg = load_config()?;
    let persona_id = ensure_persona(&cfg, &state.persona_id).await?;
    let payload = json!({
        "persona_id": persona_id,
        "replica_id": cfg.replica_id,
        "conversation_name": format!("{} (desktop)", cfg.persona_name),
        "custom_greeting": cfg.greeting,
        "test_mode": cfg.test_mode,
        "properties": { "enable_recording": false, "max_call_duration": 600 }
    });
    let resp = tavus_post(&cfg, "/conversations", Some(payload)).await?;
    Ok(ConversationInfo {
        conversation_id: resp.get("conversation_id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        conversation_url: resp
            .get("conversation_url")
            .and_then(|v| v.as_str())
            .ok_or("Tavus did not return a conversation_url")?
            .to_string(),
        status: resp.get("status").and_then(|v| v.as_str()).unwrap_or("active").to_string(),
        test_mode: cfg.test_mode,
    })
}

#[tauri::command]
pub async fn end_conversation(conversation_id: String) -> Result<(), String> {
    let cfg = load_config()?;
    tavus_post(&cfg, &format!("/conversations/{conversation_id}/end"), None).await?;
    Ok(())
}
