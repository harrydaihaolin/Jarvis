#!/usr/bin/env bash
# Set up the local Kokoro neural-TTS for Jarvis.
#
# Note the onnxruntime pin: kokoro-onnx declares onnxruntime>=1.20.1, which has
# no Intel-macOS wheel — but 1.19.2 runs the model fine. So we install kokoro-onnx
# WITHOUT its deps and supply a compatible onnxruntime + the g2p libraries.
set -euo pipefail
cd "$(dirname "$0")"

python3 -m venv .venv
.venv/bin/python -m pip install -U pip
.venv/bin/python -m pip install --no-deps kokoro-onnx
.venv/bin/python -m pip install "onnxruntime==1.19.2" numpy soundfile \
  "espeakng_loader>=0.2.4" "phonemizer-fork>=3.3.2"

BASE=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
[ -f kokoro-v1.0.onnx ] || curl -L -o kokoro-v1.0.onnx "$BASE/kokoro-v1.0.onnx"
[ -f voices-v1.0.bin ]  || curl -L -o voices-v1.0.bin  "$BASE/voices-v1.0.bin"

echo "Done. Start the TTS server with:  ./tts/start.sh"
