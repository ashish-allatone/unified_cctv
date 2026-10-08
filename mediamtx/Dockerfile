# Unified CCTV by Allatone - media relay (MediaMTX) with the platform's configuration baked in.
#   docker build -f mediamtx/Dockerfile -t <ocir>/uvp-relay:$(cat VERSION) .
# Upstream image is pinned; only mediamtx.yml is added (it can still be overridden by a ConfigMap mount at /mediamtx.yml).
FROM bluenviron/mediamtx:1.15.1-ffmpeg
COPY mediamtx/mediamtx.yml /mediamtx.yml
ENV TZ=UTC
EXPOSE 8554 8889 8888 9997 9996 9998 8189/udp 8189/tcp
