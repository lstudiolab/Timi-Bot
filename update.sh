#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail

cd "$(dirname "$0")"

if ! command -v git >/dev/null 2>&1; then
  echo "Git is not installed. Run: pkg install git"
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust/Cargo is not installed. Install the Rust toolchain first."
  exit 1
fi

echo "[1/3] Downloading the latest Timi update..."
git pull --ff-only origin main

echo "[2/3] Building Timi..."
cargo build --release

mkdir -p data logs
PID_FILE="data/timi.pid"

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$OLD_PID" =~ ^[0-9]+$ ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    OLD_ARGS="$(ps -p "$OLD_PID" -o args= 2>/dev/null || true)"
    if [[ "$OLD_ARGS" == *"target/release/timi-bot"* ]]; then
      echo "Stopping the previous Timi process..."
      kill "$OLD_PID" 2>/dev/null || true
      for _ in {1..10}; do
        kill -0 "$OLD_PID" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$OLD_PID" 2>/dev/null; then
        kill -9 "$OLD_PID" 2>/dev/null || true
      fi
    fi
  fi
fi

echo "[3/3] Starting Timi in the background..."
nohup ./target/release/timi-bot >> logs/timi.log 2>&1 < /dev/null &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
sleep 2

if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "Timi is running (PID: $NEW_PID)."
  echo "View logs with: tail -f logs/timi.log"
else
  echo "Timi did not stay running. Recent logs:"
  tail -n 40 logs/timi.log || true
  rm -f "$PID_FILE"
  exit 1
fi
