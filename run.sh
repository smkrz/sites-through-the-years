#!/usr/bin/env bash
# Supervisor: keeps the capture running for as long as it takes, unattended.
# The capture already handles throttling internally (adaptive rate + escalating cooldowns)
# and checkpoints after every pick. This wrapper just relaunches it if the *process* dies
# (crash / OOM / kill), resuming via SKIP_EXISTING, and stops once a full pass adds nothing new.
#
#   ./run.sh [site]        # e.g. ./run.sh stripe   (default: stripe)
#
# Survives crashes and sleep. To also survive reboots, run it under launchd (ask Claude for a plist).
set -u
cd "$(dirname "$0")"
SITE="${1:-${SITE:-stripe}}"
DIR="sites/$SITE/shots"
LOG="capture-$SITE.log"

count() { ls "$DIR"/*.png 2>/dev/null | grep -v '\.tmp-' | wc -l | tr -d ' '; }

echo "[supervisor] $(date '+%F %T') starting for $SITE — logging to $LOG"
while true; do
  before=$(count)
  echo "[supervisor] $(date '+%F %T') launching capture ($before shots on disk)" | tee -a "$LOG"
  SITE="$SITE" GOVERN=1 SKIP_EXISTING=1 node capture.mjs >> "$LOG" 2>&1
  code=$?
  after=$(count)
  echo "[supervisor] $(date '+%F %T') capture exited code=$code ($before -> $after shots)" | tee -a "$LOG"
  if [ "$code" = "0" ] && [ "$after" = "$before" ]; then
    echo "[supervisor] $(date '+%F %T') clean pass with no new shots — all reachable picks captured. Done." | tee -a "$LOG"
    break
  fi
  echo "[supervisor] $(date '+%F %T') exited (crash or progress) — relaunching in 30s (Ctrl-C to stop)" | tee -a "$LOG"
  sleep 30
done
