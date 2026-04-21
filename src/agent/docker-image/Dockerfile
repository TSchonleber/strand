# Strand computer-use sandbox.
#
# Minimal Debian base with:
#   • Xvfb         — virtual framebuffer display on :1
#   • fluxbox      — lightweight window manager
#   • x11vnc       — optional VNC server on :5900 for human observation
#   • xdotool      — keyboard + mouse injection
#   • scrot        — screenshot capture
#   • ffmpeg       — fallback capture path (image2pipe PNG)
#   • bash/coreutils — required by DockerExecutor.bash + textEditor
#
# DockerExecutor talks to this container via `docker exec`. The container
# itself runs no network-bound services beyond the optional VNC port; callers
# are expected to launch it with --network=none or an isolated network when
# running in gated/live modes.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xdotool \
    x11vnc \
    scrot \
    ffmpeg \
    fluxbox \
    ca-certificates \
    curl \
    bash \
    coreutils \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DISPLAY=:1

# VNC (optional; bind with -p 5900:5900 only when you want to observe).
EXPOSE 5900

WORKDIR /workdir

ENTRYPOINT ["/entrypoint.sh"]
