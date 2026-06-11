#!/usr/bin/env bash
set -euo pipefail
ARCH=$(uname -m)
TRIPLE="${ARCH/arm64/aarch64}-apple-darwin"
# Embed Info.plist (TCC usage descriptions) into each binary — unbundled
# processes are SIGABRT'd by macOS if they touch speech/mic/camera without it.
PLIST="frontend/src-tauri/sidecar/Info.plist"
mkdir -p frontend/src-tauri/binaries
for name in jarvus-eye-tracker jarvus-stt; do
  src="frontend/src-tauri/sidecar/${name}.swift"
  [ -f "$src" ] || continue
  out="frontend/src-tauri/binaries/${name}-${TRIPLE}"
  swiftc -O "$src" -o "$out" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST"
  # Re-sign: the linker's ad-hoc signature leaves the embedded Info.plist
  # unbound, so TCC ignores it. codesign binds it (Info.plist=embedded).
  codesign --force --sign - --identifier "com.jarvus.${name}" "$out"
  echo "Built $out"
done
