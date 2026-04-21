#!/bin/bash
# Strand computer-use sandbox entrypoint.
#
# Starts Xvfb on :1, fluxbox as the window manager, and x11vnc listening on
# :5900 for optional human observation. Blocks on `tail -f /dev/null` so the
# container stays alive for `docker exec` commands driven by DockerExecutor.

set -euo pipefail

# Clean any stale X lock from previous runs.
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true

Xvfb :1 -screen 0 1280x800x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!

# Give Xvfb a beat to come up before clients attach.
sleep 0.5

DISPLAY=:1 fluxbox >/dev/null 2>&1 &
FLUXBOX_PID=$!

# VNC server — no auth, only safe behind --network=none / isolated network.
DISPLAY=:1 x11vnc \
    -display :1 \
    -rfbport 5900 \
    -nopw \
    -forever \
    -shared \
    -quiet \
    >/dev/null 2>&1 &
X11VNC_PID=$!

cleanup() {
    kill "$XVFB_PID" "$FLUXBOX_PID" "$X11VNC_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Keep the container alive.
exec tail -f /dev/null
