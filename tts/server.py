"""Local Kokoro neural-TTS server for Jarvis, with a pipelined queue.

The frontend streams sentences as they arrive; this server synthesizes them
*ahead* of playback (a synth worker fills a ready queue, a play worker drains it),
so sentences play back-to-back with no synthesis gap between them.

  GET  /health           → {"status","ready","voice"}
  GET  /events           → SSE lifecycle: {"type":"state","state":"speaking|idle"}
  POST /speak  {"text"}   → enqueue a sentence (returns immediately)
  POST /done              → mark end of the current turn (idle fires when drained)
  POST /cancel            → drop everything + stop playback now (barge-in)
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

cv = threading.Condition()   # guards everything below
synth_q = []                 # [(gen, text)] awaiting synthesis
ready_q = []                 # [(gen, wav_path)] synthesized, awaiting playback
gen = 0                      # bumped on cancel to invalidate in-flight work
turn_open = False            # frontend is still sending sentences this turn
pending = 0                  # accepted sentences not yet finished (or dropped)
play_proc = None

event_clients = []
event_lock = threading.Lock()


def broadcast(state):
    line = ("data: " + json.dumps({"type": "state", "state": state}) + "\n\n").encode()
    with event_lock:
        dead = []
        for w in event_clients:
            try:
                w.write(line)
                w.flush()
            except Exception:
                dead.append(w)
        for w in dead:
            event_clients.remove(w)


def maybe_idle_locked():
    # cv must be held. Turn is done when nothing is pending and the frontend
    # has signalled the end of this turn.
    if pending == 0 and not turn_open and not synth_q and not ready_q:
        broadcast("idle")


def synth_worker():
    while True:
        with cv:
            while not synth_q:
                cv.wait()
            g, text = synth_q.pop(0)
        if g != gen:
            continue  # cancelled; cancel already reset pending
        while kokoro is None:
            time.sleep(0.1)
        wav = None
        try:
            samples, sr = kokoro.create(text, voice=VOICE, speed=SPEED, lang="en-us")
            tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            tmp.close()
            sf.write(tmp.name, samples, sr)
            wav = tmp.name
        except Exception as e:  # noqa: BLE001
            print(f"[tts] synth error: {e}", flush=True)
        with cv:
            if g != gen:
                if wav:
                    _unlink(wav)
                continue
            if wav is None:
                pending = _dec_pending()
                maybe_idle_locked()
            else:
                ready_q.append((g, wav))
            cv.notify_all()


def play_worker():
    global play_proc, pending
    while True:
        with cv:
            while not ready_q:
                cv.wait()
            g, wav = ready_q.pop(0)
        if g != gen:
            _unlink(wav)  # cancelled; cancel already reset pending
            continue
        proc = subprocess.Popen(["afplay", wav])
        with cv:
            play_proc = proc
        broadcast("speaking")
        proc.wait()
        _unlink(wav)
        with cv:
            play_proc = None
            if g == gen:  # not cancelled mid-playback
                pending = _dec_pending()
                maybe_idle_locked()
            cv.notify_all()


def _dec_pending():
    global pending
    return max(0, pending - 1)


def _unlink(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def load_model():
    global kokoro
    t0 = time.time()
    kokoro = Kokoro(os.path.join(HERE, "kokoro-v1.0.onnx"), os.path.join(HERE, "voices-v1.0.bin"))
    print(f"[tts] model loaded in {time.time()-t0:.1f}s; voice={VOICE}", flush=True)


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
            return
        if self.path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            with event_lock:
                event_clients.append(self.wfile)
            try:
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                while True:
                    time.sleep(15)
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except Exception:
                pass
            finally:
                with event_lock:
                    if self.wfile in event_clients:
                        event_clients.remove(self.wfile)
            return
        self._send(404)

    def do_POST(self):
        global gen, turn_open, pending, play_proc
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n) if n else b"{}"

        if self.path == "/speak":
            try:
                text = (json.loads(raw).get("text") or "").strip()
            except Exception:
                text = ""
            if text:
                with cv:
                    synth_q.append((gen, text))
                    pending += 1
                    turn_open = True
                    cv.notify_all()
            self._send(200, b'{"ok":true}')
            return

        if self.path == "/done":
            with cv:
                turn_open = False
                maybe_idle_locked()
                cv.notify_all()
            self._send(200, b'{"ok":true}')
            return

        if self.path == "/cancel":
            with cv:
                gen += 1
                synth_q.clear()
                for _, w in ready_q:
                    _unlink(w)
                ready_q.clear()
                pending = 0
                turn_open = False
                if play_proc and play_proc.poll() is None:
                    play_proc.terminate()
                play_proc = None
                cv.notify_all()
            self._send(200, b'{"ok":true}')
            return

        self._send(404)

    def log_message(self, *args):
        pass


def main():
    threading.Thread(target=load_model, daemon=True).start()
    threading.Thread(target=synth_worker, daemon=True).start()
    threading.Thread(target=play_worker, daemon=True).start()
    print(f"[tts] listening on http://localhost:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
