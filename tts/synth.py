import sys
from kokoro_onnx import Kokoro
import soundfile as sf

voice = sys.argv[1] if len(sys.argv) > 1 else "am_michael"
text = sys.argv[2] if len(sys.argv) > 2 else (
    "Hey, I'm Jarvis. I can hear you, search the web, and take notes. How can I help?"
)
out = f"sample_{voice}.wav"

kokoro = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
samples, sr = kokoro.create(text, voice=voice, speed=1.0, lang="en-us")
sf.write(out, samples, sr)
print(f"wrote {out}  ({len(samples)/sr:.1f}s @ {sr}Hz)")
