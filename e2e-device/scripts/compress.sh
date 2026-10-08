#!/usr/bin/env bash
# Compresses a screen recording to H.264 and keeps it under the 10 MB limit of
# a GitHub attachment. Burns a caption in when the platform font is available.
#
# Usage: compress.sh <input.mp4> <output.mp4> "<caption>"
set -euo pipefail

input="$1"
output="$2"
caption="${3:-simulator/emulator (CI)}"
limit=$((10 * 1024 * 1024 - 300000))

if [ ! -s "$input" ]; then
  echo "no recording at $input" >&2
  exit 1
fi

font=""
for candidate in "${FONT_FILE:-}" /System/Library/Fonts/Helvetica.ttc /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf /usr/share/fonts/dejavu/DejaVuSans.ttf; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    font="$candidate"
    break
  fi
done

safe_caption=$(printf '%s' "$caption" | tr -d "':\%,;[]")

encode() {
  local height="$1" crf="$2" with_text="$3"
  local filter="scale=-2:${height}:flags=lanczos,format=yuv420p"
  if [ "$with_text" = "yes" ] && [ -n "$font" ]; then
    filter="${filter},drawtext=fontfile=${font}:text=${safe_caption}:x=8:y=8:fontsize=h/55:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4"
  fi
  ffmpeg -y -loglevel error -i "$input" -vf "$filter" -c:v libx264 -preset veryfast -crf "$crf" -movflags +faststart -an "$output"
}

for profile in "720 30" "720 34" "540 34" "480 38" "360 40"; do
  set -- $profile
  if ! encode "$1" "$2" yes; then
    echo "caption overlay failed, encoding without it" >&2
    encode "$1" "$2" no
  fi
  size=$(wc -c < "$output" | tr -d ' ')
  echo "height=$1 crf=$2 size=$size"
  if [ "$size" -lt "$limit" ]; then
    exit 0
  fi
done

echo "could not get $output under the size limit" >&2
exit 1
