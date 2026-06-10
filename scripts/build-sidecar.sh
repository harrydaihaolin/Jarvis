#!/usr/bin/env bash
set -euo pipefail
ARCH=$(uname -m)
TRIPLE="${ARCH/arm64/aarch64}-apple-darwin"
DEST="frontend/src-tauri/binaries/jarvus-eye-tracker-${TRIPLE}"
mkdir -p frontend/src-tauri/binaries
swiftc -O \
  frontend/src-tauri/sidecar/jarvus-eye-tracker.swift \
  -o "$DEST"
echo "Built $DEST"
