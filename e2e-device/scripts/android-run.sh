#!/usr/bin/env bash
# Runs inside android-emulator-runner: starts Appium, records the emulator
# screen in chunks (screenrecord stops at 180 s), runs the spec, pulls the clips.
set -uo pipefail

cd "$(dirname "$0")/.."
OUT="${OUT_DIR:?OUT_DIR is required}"
mkdir -p "$OUT"

prop() {
  adb shell getprop "$1" | tr -d '\r'
}

adb wait-for-device
adb shell input keyevent 82 || true
{
  echo "android_release=$(prop ro.build.version.release)"
  echo "android_sdk=$(prop ro.build.version.sdk)"
  echo "device_model=$(prop ro.product.model)"
  echo "abi=$(prop ro.product.cpu.abi)"
  echo "chrome=$(adb shell dumpsys package com.android.chrome | grep -m1 versionName | tr -d '\r' | xargs)"
} > "$OUT/android-facts.txt"
cat "$OUT/android-facts.txt"
ANDROID_FACTS="$(tr '\n' ' ' < "$OUT/android-facts.txt")"
OS_LABEL="Android $(prop ro.build.version.release) (API $(prop ro.build.version.sdk))"
export ANDROID_FACTS OS_LABEL

npx appium --log "$OUT/appium.log" --log-level info \
  --allow-insecure=uiautomator2:chromedriver_autodownload > "$OUT/appium.stdout" 2>&1 &
APPIUM_PID=$!
for _ in $(seq 1 60); do
  if curl -sf http://localhost:4723/status > /dev/null; then break; fi
  sleep 1
done

touch "$OUT/.recording"
(
  i=0
  while [ -f "$OUT/.recording" ]; do
    adb shell screenrecord --time-limit 170 --bit-rate 4000000 "/sdcard/rec_${i}.mp4"
    i=$((i + 1))
  done
) &
REC_PID=$!
sleep 3

export PLATFORM=android
bash scripts/run-wdio.sh
STATUS=$?

rm -f "$OUT/.recording"
adb shell pkill -2 screenrecord || true
wait "$REC_PID" 2>/dev/null || true
sleep 2
mkdir -p "$OUT/chunks"
for f in $(adb shell ls /sdcard/ | tr -d '\r' | grep -E '^rec_[0-9]+\.mp4$' | sort -V); do
  adb pull "/sdcard/$f" "$OUT/chunks/$f" > /dev/null
done
ls -la "$OUT/chunks"
kill "$APPIUM_PID" 2>/dev/null || true
exit "$STATUS"
