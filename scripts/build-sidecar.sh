#!/usr/bin/env bash
set -euo pipefail
ARCH=$(uname -m)
TRIPLE="${ARCH/arm64/aarch64}-apple-darwin"
mkdir -p frontend/src-tauri/binaries
for name in jarvus-eye-tracker jarvus-stt; do
  src="frontend/src-tauri/sidecar/${name}.swift"
  [ -f "$src" ] || continue
  swiftc -O "$src" -o "frontend/src-tauri/binaries/${name}-${TRIPLE}"
  echo "Built frontend/src-tauri/binaries/${name}-${TRIPLE}"
done
