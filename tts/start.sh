#!/usr/bin/env bash
# Start the local Kokoro TTS server (http://localhost:8788). Voice via
# JARVUS_TTS_VOICE (default am_adam — e.g. am_michael, bm_george, af_sarah).
cd "$(dirname "$0")"
exec env JARVUS_TTS_VOICE="${JARVUS_TTS_VOICE:-am_adam}" .venv/bin/python server.py
