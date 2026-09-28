const pptxgen = require("pptxgenjs");
const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.33 x 7.5
pres.title = "Unified CCTV Viewing Platform — Enterprise edition";

const NAVY = "0E1621", PANEL = "17212E", LINE = "2A3646", CREAM = "F3F1EB", CARD = "FBFAF6", CARDLINE = "DDD8CC";
const AMBER = "F2A93B", AMBERDK = "9A5A08", TEAL = "3BB8A8", INK = "0E1621", MUTED = "3F4A57", MUTEDL = "B9C4CF", GREY = "8391A1";
const HF = "Cambria", BF = "Calibri";
let n = 0;

function footer(s, dark) {
  n += 1;
  s.addText("Unified CCTV Viewing Platform · Enterprise edition", { x: 0.6, y: 7.0, w: 9, h: 0.3, fontFace: BF, fontSize: 10, color: dark ? GREY : "6B7480", isTextBox: true, margin: 0 });
  s.addText(String(n), { x: 12.2, y: 7.0, w: 0.5, h: 0.3, fontFace: BF, fontSize: 10, color: dark ? GREY : "6B7480", align: "right", isTextBox: true, margin: 0 });
}
function title(s, text, dark) {
  s.addText(text, { x: 0.6, y: 0.45, w: 12.1, h: 0.9, fontFace: HF, fontSize: 30, bold: true, color: dark ? CREAM : INK, isTextBox: true, margin: 0, valign: "top" });
}
function card(s, x, y, w, h, o) {
  const dark = o.dark;
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.12, fill: { color: dark ? PANEL : CARD }, line: { color: dark ? LINE : CARDLINE, width: 1 } });
  let yy = y + 0.18;
  if (o.eyebrow) { s.addText(o.eyebrow, { x: x + 0.22, y: yy, w: w - 0.44, h: 0.28, fontFace: BF, fontSize: 10, bold: true, color: dark ? AMBER : AMBERDK, charSpacing: 2, isTextBox: true, margin: 0 }); yy += 0.32; }
  if (o.head) { s.addText(o.head, { x: x + 0.22, y: yy, w: w - 0.44, h: o.headH || 0.45, fontFace: HF, fontSize: o.headSize || 16, bold: true, color: dark ? CREAM : INK, isTextBox: true, margin: 0, valign: "top" }); yy += (o.headH || 0.45) + 0.04; }
  if (o.body) s.addText(o.body, { x: x + 0.22, y: yy, w: w - 0.44, h: y + h - yy - 0.12, fontFace: BF, fontSize: o.bodySize || 12, color: dark ? MUTEDL : MUTED, isTextBox: true, margin: 0, valign: "top", paraSpaceAfter: 3 });
}
function shot(s, file, x, y, w, h, caption) {
  s.addImage({ path: file, x, y, w, h, sizing: { type: "contain", w, h } });
  if (caption) s.addText(caption, { x, y: y + h + 0.05, w, h: 0.3, fontFace: BF, fontSize: 10, color: GREY, isTextBox: true, margin: 0 });
}

// 1 Cover
{
  const s = pres.addSlide(); s.background = { color: NAVY };
  const cells = [[0,0,PANEL],[1,0,TEAL],[2,0,PANEL],[0,1,PANEL],[1,1,PANEL],[2,1,AMBER],[0,2,AMBER],[1,2,PANEL],[2,2,PANEL]];
  cells.forEach(([c, r, col]) => s.addShape(pres.ShapeType.rect, { x: 9.4 + c * 1.1, y: 0.8 + r * 0.75, w: 1.0, h: 0.65, fill: { color: col }, line: { color: LINE, width: 1 } }));
  s.addText("UNIFIED CCTV VIEWING PLATFORM · ENTERPRISE EDITION", { x: 0.6, y: 2.2, w: 8.5, h: 0.4, fontFace: BF, fontSize: 12, bold: true, color: AMBER, charSpacing: 3, isTextBox: true, margin: 0 });
  s.addText("From pilot to a product a state can procure", { x: 0.6, y: 2.7, w: 8.6, h: 2.0, fontFace: HF, fontSize: 44, bold: true, color: CREAM, isTextBox: true, margin: 0, valign: "top" });
  s.addText("What was added in six phases, and what remains a customer-side dependency", { x: 0.6, y: 4.8, w: 8.5, h: 0.6, fontFace: BF, fontSize: 18, color: MUTEDL, isTextBox: true, margin: 0 });
  s.addText("September 2026 · v1.0.0", { x: 0.6, y: 6.9, w: 8, h: 0.35, fontFace: BF, fontSize: 11, color: GREY, isTextBox: true, margin: 0 });
  n += 1;
  s.addNotes("The pilot proved the concept. This deck covers what turns it into an enterprise product: security and compliance, investigation tooling, analytics, integration, scale, and product polish. Every item is in the shipped build with tests; where something depends on a government API or a trained model that we cannot obtain ourselves, the slide says so.");
}

// 2 Overview of the six phases
{
  const s = pres.addSlide(); s.background = { color: CREAM };
  title(s, "Six additions on top of the pilot", false);
  const items = [
    ["01 SECURITY & COMPLIANCE", "AD/LDAP + SSO, 2FA, fine-grained RBAC, break-glass, hash-chained audit, signed exports, retention + legal hold, DPDP endpoints, TLS, Vault"],
    ["02 INVESTIGATION", "Cases with chain of custody, court bundle PDF, stitched vehicle timeline, bookmarks, GIS map with coverage cones and nearest-camera search"],
    ["03 ANALYTICS", "Vehicle type / colour, wrong-way, over-speed, triple riding, red-light, parking, intrusion, abandoned object, crowd; challan workflow; hotlists"],
    ["04 OPERATIONS", "Multi-tenancy, camera SLA + image quality, email/SMS/WhatsApp/CAD notifications, API keys + webhooks, Vahan lookup, field-officer app, vendor presets"],
    ["05 HA & SCALE", "Relay cluster with automatic failover, Prometheus/Grafana, capacity per department, ANPR sharding + GPU, edge nodes with offline buffer, Kubernetes"],
    ["06 PRODUCT", "Installer/updater/backup, signed licensing with channel limits, English/Hindi, accessibility, weekly ANPR accuracy report with a review queue and retraining set"],
  ];
  items.forEach(([h, b], i) => card(s, 0.6 + (i % 3) * 4.1, 1.55 + Math.floor(i / 3) * 2.6, 3.9, 2.4, { eyebrow: h, body: b, bodySize: 12.5 }));
  footer(s, false);
  s.addNotes("Each phase shipped as a tested build: 63 automated tests, browser runs of every screen, and the non-interference evidence test re-run after every phase, including with two relays.");
}

// 3 Security & compliance
{
  const s = pres.addSlide(); s.background = { color: NAVY };
  title(s, "Security and compliance: the first gate in any tender", true);
  shot(s, "8_admin.png", 0.6, 1.5, 7.2, 4.3, "Admin: compliance status, users, time-bound grants, legal holds, DPDP tools");
  card(s, 8.1, 1.5, 4.6, 5.2, { dark: true, eyebrow: "WHAT IS ENFORCED", body:
    "• Sign-in via local users, Active Directory / LDAP groups, or OpenID Connect SSO; TOTP two-factor with backup codes; lockout\n" +
    "• 13 feature permissions, department and per-camera scope, time-bound grants, break-glass with justification and live admin alert\n" +
    "• Audit log hash-chained (tamper detection), ≥180-day retention (CERT-In)\n" +
    "• Every export signed (Ed25519) and watermarked with user + time\n" +
    "• Retention per department, legal holds, DPDP subject-access and erasure\n" +
    "• Plates masked for roles without plate_search; faces blurred in evidence frames\n" +
    "• HTTPS front door, secrets from files or Vault, encrypted archive bucket", bodySize: 11.5 });
  footer(s, true);
  s.addNotes("docs/compliance.md maps each control to the code that implements it so an auditor can verify rather than trust.");
}

// 4 Investigation
{
  const s = pres.addSlide(); s.background = { color: CREAM };
  title(s, "Investigation: from a sighting to a court-ready bundle", false);
  shot(s, "11_cases.png", 0.6, 1.5, 6.3, 3.8, "Case with filed sightings, notes and the chain of custody");
  shot(s, "12_map.png", 7.1, 1.5, 5.6, 3.4, "Map: coverage cones, nearest cameras to an incident");
  card(s, 0.6, 5.5, 12.1, 1.3, { body:
    "Cases group sightings, clips, bookmarks and notes with an assigned officer. Export produces report.pdf (evidence table, SHA-256 of every file, custody log, certificate block), watermarked media and a signed manifest. " +
    "Stitch clips joins every archived clip of a plate into one captioned video; bookmarks keep ±10 s from any tile.", bodySize: 12.5 });
  footer(s, false);
}

// 5 Analytics
{
  const s = pres.addSlide(); s.background = { color: NAVY };
  title(s, "Analytics beyond plates, with an honest line on what needs a model", true);
  shot(s, "13_violations.png", 0.6, 1.5, 7.2, 4.0, "Violations: challan queue (approve → e-challan hand-off), incidents, review queue, weekly accuracy");
  card(s, 8.1, 1.5, 4.6, 2.55, { dark: true, eyebrow: "WORKS OUT OF THE BOX", body:
    "Vehicle type, colour, plate colour, rider count (bundled Apache-licensed detector) · wrong-way · two-camera over-speed · triple riding · non-standard plate · red-light (signal read from picture, schedule or ITMS) · illegal parking · perimeter intrusion · abandoned object · crowd density", bodySize: 11.5 });
  card(s, 8.1, 4.2, 4.6, 2.5, { dark: true, eyebrow: "NEEDS SOMETHING FROM THE CUSTOMER", body:
    "Helmet and make/model: plug in a trained ONNX classifier (contract documented) · Vahan / NCRB / e-challan: live credentials from the authority; connectors and a simulator are included · Face search: disabled, legally gated (HTTP 451)", bodySize: 11.5 });
  footer(s, true);
  s.addNotes("Fine amounts in the challan schedule are the central MV Act defaults and are flagged for confirmation with the traffic department before anything is issued.");
}

// 6 Operations
{
  const s = pres.addSlide(); s.background = { color: CREAM };
  title(s, "Operations: run it for many departments, keep the cameras healthy", false);
  shot(s, "14_sla.png", 0.6, 1.5, 7.6, 4.0, "Sources: capacity per department and per-camera SLA with image-quality verdicts");
  shot(s, "15_field_app.png", 8.5, 1.5, 2.0, 4.1, "Field-officer app");
  card(s, 0.6, 5.65, 12.1, 1.15, { body:
    "Tenants with their own branding · outage and image-quality tickets to the helpdesk · email / SMS / WhatsApp / Dial-112 routing with a delivery log · API keys and signed webhooks for other systems · Vahan registration lookup · presets for Hikvision, Dahua, CP Plus, Uniview, Axis, Honeywell, Bosch, Milestone, Genetec.", bodySize: 12 });
  footer(s, false);
}

// 7 HA & scale
{
  const s = pres.addSlide(); s.background = { color: NAVY };
  title(s, "Scale and availability: measured, not promised", true);
  const rows = [
    ["Relay failure", "Cameras move to surviving relays in ~20 s; move back when the relay returns (tested by killing a relay)"],
    ["ANPR capacity", "Shard cameras across workers; GPU image ≈ 40 channels per T4 worker; CPU ≈ 3–4 channels per worker"],
    ["Edge sites", "Worker at the junction reads the camera directly, buffers events in an outbox, replays in order after a WAN outage"],
    ["Observability", "Prometheus on every service, Grafana dashboard, 9 alert rules (camera offline, source unreachable, relay down, ANPR stalled…)"],
    ["Kubernetes", "20 validated manifests: relay + ANPR StatefulSets, HPA, KEDA on Kafka lag, Ingress with TLS, PDB"],
    ["Data services", "PostgreSQL HA, 3-broker Kafka, Elasticsearch cluster, Oracle/S3 object storage with SSE (docs/ha.md)"],
  ];
  rows.forEach(([h, b], i) => card(s, 0.6 + (i % 2) * 6.15, 1.5 + Math.floor(i / 2) * 1.75, 5.95, 1.6, { dark: true, head: h, headSize: 15, headH: 0.35, body: b, bodySize: 11.5 }));
  footer(s, true);
}

// 8 Product polish + accuracy programme
{
  const s = pres.addSlide(); s.background = { color: CREAM };
  title(s, "Product polish and the accuracy programme", false);
  shot(s, "16_review_report.png", 0.6, 1.5, 7.4, 4.0, "Violations: plate review queue and the weekly per-camera accuracy report");
  card(s, 8.3, 1.5, 4.4, 5.2, { eyebrow: "SHIPPED", body:
    "• One-command install (Linux / Windows), update with backup, backup script\n" +
    "• Signed licence: camera, ANPR and analytics channel limits, expiry with grace; evaluation mode keeps a pilot running\n" +
    "• English / हिंदी console and field app; keyboard shortcuts, ARIA, reduced motion\n" +
    "• Operators confirm or correct reads; corrections fix records, alerts and challans\n" +
    "• Weekly accuracy per camera on reviewed reads, with correction reasons\n" +
    "• Retraining set export (crops + labels) to fine-tune OCR per site", bodySize: 12 });
  footer(s, false);
  s.addNotes("Accuracy is measured on operator-reviewed reads, including a random sample of ordinary reads, so the number is not biased towards hard cases.");
}

// 9 What we ask
{
  const s = pres.addSlide(); s.background = { color: NAVY };
  title(s, "What is needed from the departments to go live", true);
  const rows = [
    ["Directory & SSO", "AD/LDAP service account or OIDC client; group names for roles"],
    ["Camera access", "Read-only VMS accounts, RTSP/ONVIF reachability, agreed pull caps"],
    ["Government feeds", "Vahan / NCRB / e-challan credentials and endpoints"],
    ["Legal", "Retention periods per department, challan schedule confirmation, DPIA if face search is ever wanted"],
    ["Infrastructure", "Object storage bucket, HA database/Kafka (or managed), TLS certificate, NTP"],
    ["Models (optional)", "Helmet and make/model classifiers trained on local footage"],
  ];
  rows.forEach(([h, b], i) => card(s, 0.6 + (i % 2) * 6.15, 1.5 + Math.floor(i / 2) * 1.55, 5.95, 1.4, { dark: true, head: h, headSize: 15, headH: 0.35, body: b, bodySize: 12 }));
  s.addText("Nothing on this list changes how a department's own VMS works: the platform still only reads.", { x: 0.6, y: 6.25, w: 12, h: 0.5, fontFace: BF, fontSize: 14, color: AMBER, isTextBox: true, margin: 0 });
  footer(s, true);
}

pres.writeFile({ fileName: "Unified_CCTV_Enterprise.pptx" }).then(() => console.log("written"));
