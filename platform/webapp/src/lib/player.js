/* Live tile player: WebRTC (WHEP) from the relay, HLS fallback, on-demand transcodes for browsers/cameras that need them. */
import Hls from "hls.js";
import { store, withTok } from "./api.js";

// Browsers without H.264 (some Linux Chromium builds) get an on-demand VP8 transcode from the relay.
const H264 = (() => { try { return RTCRtpReceiver.getCapabilities("video").codecs.some((c) => /h264/i.test(c.mimeType)); } catch (_) { return true; } })();
// Sources the browser cannot decode (H.265 / HEVC cameras) are rejected by the relay with "codecs not supported"
// (HTTP 400): the tile then switches to the relay's on-demand H.264 transcode ("<cam>/<profile>-h264").
// Remembered per camera so the next play goes straight to the working variant.
const COMPAT = (() => { try { return JSON.parse(store.get("uvp.compat", "{}")); } catch (_) { return {}; } })();
// a remembered transcode is re-checked against the direct stream after 6 h (the vendor may switch back to H.264)
const compatSuffix = (cam) => (!H264 ? "-vp8" : Date.now() - (COMPAT[cam] || 0) < 6 * 3600e3 ? "-h264" : "");
function rememberCompat(cam, on = true) {
  if (on) COMPAT[cam] = Date.now(); else delete COMPAT[cam];
  store.set("uvp.compat", JSON.stringify(COMPAT));
}

// Behind the TLS proxy (RELAY_PUBLIC_BASE=https://host/relay) both protocols go through one origin.
// In a relay cluster each camera lives on one relay; /api/cameras carries that relay's public host.
function camRelay(cfg, cam) {
  return { host: cam.relay_host || cfg.relay.host || location.hostname, whep: cam.relay_webrtc_port || cfg.relay.webrtc_port, hls: cam.relay_hls_port || cfg.relay.hls_port };
}
const whepUrl = (cfg, cam, path) => { const r = camRelay(cfg, cam); return cfg.relay.base ? `${cfg.relay.base}/webrtc/${path}/whep` : `${location.protocol}//${r.host}:${r.whep}/${path}/whep`; };
const hlsUrl = (cfg, cam, path) => { const r = camRelay(cfg, cam); return cfg.relay.base ? `${cfg.relay.base}/hls/${path}/index.m3u8` : `${location.protocol}//${r.host}:${r.hls}/${path}/index.m3u8`; };

export class Player {
  /** @param {{video: HTMLVideoElement, cam: object, profile: string, cfg: object, onState: (s: string) => void}} o */
  constructor(o) { Object.assign(this, o); this.stopped = false; this.compatFails = 0; }

  stop() {
    this.stopped = true;
    this.teardown();
  }
  teardown() {
    clearTimeout(this.retry); clearTimeout(this.hlsCheck);
    try { this.pc && this.pc.close(); } catch (_) {}
    try { this.hls && this.hls.destroy(); } catch (_) {}
    this.pc = this.hls = null;
  }
  later(ms) { clearTimeout(this.retry); this.retry = setTimeout(() => !this.stopped && this.play(), ms); }
  state(s) { if (!this.stopped) this.onState(s); }

  async play() {
    if (this.stopped) return;
    this.teardown();
    const id = this.cam.id, suffix = compatSuffix(id);
    const path = `${id}/${this.profile}${suffix}`;
    const label = this.profile === "main" ? "main stream" : "sub-stream";
    try {
      await this.playWhep(withTok(whepUrl(this.cfg, this.cam, path)));
      this.compatFails = 0;
      if (!suffix && COMPAT[id]) rememberCompat(id, false);   // direct stream works again (camera back to H.264)
      this.state(`WebRTC · ${label}${suffix === "-vp8" ? " · VP8 compat" : suffix === "-h264" ? " · H.264 transcode (HEVC source)" : ""}`);
    } catch (e) {
      if (this.stopped) return;
      const msg = String(e.message || e);
      if (msg.includes("403")) { this.state("refused: source at its stream cap or no permission"); return; }
      if (msg.includes("400") && !suffix) {      // relay: codecs not supported by client -> H.265 camera, use the transcode
        console.warn(`${id}: browser cannot decode this source, switching to the H.264 transcode`);
        rememberCompat(id);
        this.state("starting H.264 transcode…");
        return this.later(1500);
      }
      console.warn("WebRTC failed, trying HLS", e);
      if (suffix === "-h264") { // the transcode did not come up: after two tries go back to the direct stream and re-detect
        this.compatFails++;
        if (this.compatFails >= 2) { rememberCompat(id, false); this.compatFails = 0; this.state("retrying direct stream…"); }
        else this.state("starting H.264 transcode…");
        return this.later(2000);
      }
      if (suffix) { // VP8 compat stream cannot go over HLS: keep retrying WebRTC while ffmpeg starts
        this.state("starting compatibility stream…");
        return this.later(3000);
      }
      try { this.playHls(hlsUrl(this.cfg, this.cam, path)); this.state("HLS fallback"); }
      catch (_) { this.state("offline, retrying"); this.later(5000); }
    }
  }

  async playWhep(url) {
    const pc = new RTCPeerConnection();
    this.pc = pc;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (ev) => { this.video.srcObject = ev.streams[0]; };
    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected"].includes(pc.connectionState) && this.pc === pc && !this.stopped) {
        this.state("reconnecting…");
        this.later(3000);
      }
    };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((res) => {
      if (pc.iceGatheringState === "complete") return res();
      const t = setTimeout(res, 1500);
      pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && (clearTimeout(t), res());
    });
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/sdp" }, body: pc.localDescription.sdp });
    if (!r.ok) throw new Error(`WHEP ${r.status}`);
    if (this.stopped || this.pc !== pc) return;
    await pc.setRemoteDescription({ type: "answer", sdp: await r.text() });
  }

  playHls(url) {
    const video = this.video;
    video.srcObject = null;
    if (Hls.isSupported()) {
      const h = new Hls({ lowLatencyMode: true, xhrSetup: (xhr, u) => xhr.open("GET", withTok(u), true) });
      this.hls = h; h.loadSource(url); h.attachMedia(video);
      h.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) { this.state("offline, retrying"); this.later(5000); } });
    } else { video.src = withTok(url); }
    // "HLS fallback" must mean pictures, not a black tile: if no frame arrives within 12 s, start over (WebRTC first)
    const started = Date.now();
    const check = () => {
      if (this.stopped) return;
      if (video.readyState >= 2 && !video.paused && video.currentTime > 0) { this.state("HLS fallback · playing"); return; }
      if (Date.now() - started > 12000) { this.state("no video over HLS, retrying…"); return this.later(1500); }
      this.hlsCheck = setTimeout(check, 1000);
    };
    clearTimeout(this.hlsCheck); this.hlsCheck = setTimeout(check, 1000);
  }
}

/** Draw analytics / ANPR boxes over a tile. Returns the badge text. */
export function drawDets(tileEl, cv, video, m) {
  const W = tileEl.clientWidth, H = tileEl.clientHeight;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  // the video is letterboxed with object-fit: contain; map frame coordinates into the displayed area
  const fw = m.w || video.videoWidth || W, fh = m.h || video.videoHeight || H;
  const sc = Math.min(W / fw, H / fh), ox = (W - fw * sc) / 2, oy = (H - fh * sc) / 2;
  let vehicles = 0, people = 0, plates = 0, faces = 0;
  ctx.lineWidth = 2; ctx.font = "12px system-ui, sans-serif";
  for (const b of m.boxes || []) {
    const [cls, conf, x1, y1, x2, y2] = b;
    const isPlate = String(cls).startsWith("plate"), isFace = String(cls).startsWith("face");
    const known = isFace && String(cls).startsWith("face:");
    if (isPlate) plates++; else if (isFace) { if (known) faces++; } else if (cls === "person") people++; else vehicles++;
    ctx.strokeStyle = isPlate ? "#ffd166" : known ? "#ff5fd2" : isFace ? "#9aa5b1" : cls === "person" ? "#ef476f" : "#06d6a0";
    ctx.lineWidth = known ? 3 : 2;
    ctx.strokeRect(ox + x1 * sc, oy + y1 * sc, (x2 - x1) * sc, (y2 - y1) * sc);
    const label = isPlate ? String(cls).replace("plate:", "") || "plate" : known ? String(cls).slice(5) : isFace ? "" : `${cls} ${Math.round(conf * 100)}%`;
    if (!label) continue;
    const tw = ctx.measureText(label).width + 6;
    ctx.fillStyle = "rgba(0,0,0,.65)"; ctx.fillRect(ox + x1 * sc, Math.max(0, oy + y1 * sc - 14), tw, 14);
    ctx.fillStyle = ctx.strokeStyle; ctx.fillText(label, ox + x1 * sc + 3, Math.max(11, oy + y1 * sc - 3));
  }
  const parts = [];
  if (vehicles) parts.push(`${vehicles} vehicle${vehicles > 1 ? "s" : ""}`);
  if (people) parts.push(`${people} person${people > 1 ? "s" : ""}`);
  if (plates) parts.push(`${plates} plate${plates > 1 ? "s" : ""}`);
  if (faces) parts.push(`${faces} person${faces > 1 ? "s" : ""} of interest`);
  if (m.lag_ms > 1500) parts.push(`overlay ${(m.lag_ms / 1000).toFixed(1)}s behind`);   // capture -> inference -> console
  return parts.join(" · ") || (["plate", "face"].includes(m.kind) ? "" : "no objects");
}
