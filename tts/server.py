"""Local Kokoro neural-TTS server for Jarvis.

Loads the Kokoro ONNX model once and exposes a tiny HTTP API the frontend calls:
  GET  /health           → {"status":"ok","ready":bool,"voice":...}
  POST /speak  {"text"}   → synthesize + play through the speakers; returns when
                            playback finishes (so the caller knows it's done)
  POST /cancel            → stop playback immediately (barge-in / interruption)

Audio plays locally via `afplay`. Cancelling kills the player. Runs fully
offline once the model is downloaded.
"""

import os
import json
import time
import tempfile
import threading
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from kokoro_onnx import Kokoro
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
VOICE = os.environ.get("JARVUS_TTS_VOICE", "am_adam")
SPEED = float(os.environ.get("JARVUS_TTS_SPEED", "1.0"))
PORT = int(os.environ.get("JARVUS_TTS_PORT", "8788"))

kokoro = None
play_proc = None
play_lock = threading.Lock()
synth_lock = threading.Lock()


def load_model():
    global kokoro
    t0 = time.time()
    kokoro = Kokoro(os.path.join(HERE, "kokoro-v1.0.onnx"), os.path.join(HERE, "voices-v1.0.bin"))
    print(f"[tts] model loaded in {time.time()-t0:.1f}s; voice={VOICE}", flush=True)


def cancel_playback():
    global play_proc
    with play_lock:
        if play_proc and play_proc.poll() is None:
            play_proc.terminate()
        play_proc = None


def speak(text):
    global play_proc
    while kokoro is None:  # model still loading
        time.sleep(0.1)
    with synth_lock:
        samples, sr = kokoro.create(text, voice=VOICE, speed=SPEED, lang="en-us")
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    sf.write(tmp.name, samples, sr)
    cancel_playback()  # stop anything currently playing (barge-in)
    with play_lock:
        proc = subprocess.Popen(["afplay", tmp.name])
        play_proc = proc
    proc.wait()
    try:
        os.unlink(tmp.name)
    except OSError:
        pass


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body=b""):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, json.dumps({"status": "ok", "ready": kokoro is not None, "voice": VOICE}).encode())
        else:
            self._send(404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n) if n else b"{}"
        if self.path == "/cancel":
            cancel_playback()
            self._send(200, b'{"ok":true}')
            return
        if self.path == "/speak":
            try:
                text = (json.loads(raw).get("text") or "").strip()
            except Exception:
                text = ""
            if not text:
                self._send(200, b'{"ok":true,"empty":true}')
                return
            try:
                speak(text)
                self._send(200, b'{"ok":true}')
            except (BrokenPipeError, ConnectionResetError):
                pass  # client went away
            except Exception as e:  # noqa: BLE001
                try:
                    self._send(500, json.dumps({"error": str(e)}).encode())
                except Exception:
                    pass
            return
        self._send(404)

    def log_message(self, *args):
        pass  # quiet


def main():
    threading.Thread(target=load_model, daemon=True).start()
    print(f"[tts] listening on http://localhost:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
