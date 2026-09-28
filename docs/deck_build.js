const pptxgen = require("pptxgenjs");
const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.33 x 7.5
pres.title = "Unified CCTV Viewing Platform — Pilot";

const NAVY = "0E1621", PANEL = "17212E", LINE = "2A3646", CREAM = "F3F1EB", CARD = "FBFAF6", CARDLINE = "DDD8CC";
const AMBER = "F2A93B", AMBERDK = "9A5A08", TEAL = "3BB8A8", INK = "0E1621", MUTED = "3F4A57", MUTEDL = "B9C4CF", GREY = "8391A1";
const HF = "Cambria", BF = "Calibri";
let n = 0;

function footer(s, dark, text) {
  n += 1;
  s.addText(text || "Unified CCTV Viewing Platform · Pilot proposal", { x: 0.6, y: 7.0, w: 9, h: 0.3, fontFace: BF, fontSize: 10, color: dark ? GREY : "6B7480", isTextBox: true, margin: 0 });
  s.addText(String(n), { x: 12.2, y: 7.0, w: 0.5, h: 0.3, fontFace: BF, fontSize: 10, color: dark ? GREY : "6B7480", align: "right", isTextBox: true, margin: 0 });
}
function title(s, text, dark) {
  s.addText(text, { x: 0.6, y: 0.45, w: 12.1, h: 0.9, fontFace: HF, fontSize: 32, bold: true, color: dark ? CREAM : INK, isTextBox: true, margin: 0, valign: "top" });
}
function card(s, x, y, w, h, opts) {
  const dark = opts.dark;
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.12, fill: { color: dark ? PANEL : CARD }, line: { color: dark ? LINE : CARDLINE, width: 1 } });
  let yy = y + 0.2;
  if (opts.eyebrow) { s.addText(opts.eyebrow, { x: x + 0.25, y: yy, w: w - 0.5, h: 0.3, fontFace: BF, fontSize: 10, bold: true, color: dark ? AMBER : AMBERDK, charSpacing: 2, isTextBox: true, margin: 0 }); yy += 0.35; }
  if (opts.big) { s.addText(opts.big, { x: x + 0.25, y: yy, w: w - 0.5, h: 0.8, fontFace: HF, fontSize: 40, bold: true, color: dark ? AMBER : AMBERDK, isTextBox: true, margin: 0 }); yy += 0.85; }
  if (opts.head) { s.addText(opts.head, { x: x + 0.25, y: yy, w: w - 0.5, h: opts.headH || 0.5, fontFace: HF, fontSize: opts.headSize || 18, bold: true, color: dark ? CREAM : INK, isTextBox: true, margin: 0, valign: "top" }); yy += (opts.headH || 0.5) + 0.05; }
  if (opts.body) s.addText(opts.body, { x: x + 0.25, y: yy, w: w - 0.5, h: y + h - yy - 0.15, fontFace: BF, fontSize: opts.bodySize || 13, color: dark ? MUTEDL : MUTED, isTextBox: true, margin: 0, valign: "top", paraSpaceAfter: 4 });
}

// 1 Cover ---------------------------------------------------------------
{
  const s = pres.addSlide(); s.background = { color: NAVY };
  const cells = [[0,0,PANEL],[1,0,PANEL],[2,0,AMBER],[0,1,PANEL],[1,1,TEAL],[2,1,PANEL],[0,2,PANEL],[1,2,PANEL],[2,2,PANEL]];
  cells.forEach(([c, r, col]) => s.addShape(pres.ShapeType.rect, { x: 9.4 + c * 1.1, y: 0.8 + r * 0.75, w: 1.0, h: 0.65, fill: { color: col }, line: { color: LINE, width: 1 } }));
  s.addText("UNIFIED CCTV VIEWING PLATFORM · INTERNAL PILOT", { x: 0.6, y: 2.2, w: 8.5, h: 0.4, fontFace: BF, fontSize: 12, bold: true, color: AMBER, charSpacing: 3, isTextBox: true, margin: 0 });
  s.addText("One screen for every department's CCTV", { x: 0.6, y: 2.7, w: 8.6, h: 2.0, fontFace: HF, fontSize: 48, bold: true, color: CREAM, isTextBox: true, margin: 0, valign: "top" });
  s.addText("Pilot proposal and prototype results", { x: 0.6, y: 4.8, w: 8.5, h: 0.5, fontFace: BF, fontSize: 20, color: MUTEDL, isTextBox: true, margin: 0 });
  s.addText("September 2026 · [Presenter name, command centre]", { x: 0.6, y: 6.9, w: 8, h: 0.35, fontFace: BF, fontSize: 11, color: GREY, isTextBox: true, margin: 0 });
  n += 1;
  s.addNotes("Purpose: approve an 8-week pilot. We are not asking for a new VMS or new cameras. A working prototype has been built and tested on real footage, so this deck reports results, not just intent.");
}

// 2 Problem ---------------------------------------------------------------
{
  const s = pres.addSlide(); s.background = { color: CREAM };
  title(s, "Today, each department's cameras need their own viewer");
  const items = [["SWITCHING", "Operators move between separate vendor viewers", "Each VMS has its own login, layout and controls. Incident response slows down."],
    ["BLIND SPOTS", "A vehicle is lost when it crosses into another department's area", "There is no shared record of where a number plate was seen."],
    ["CONSTRAINT", "Departments must keep running their own systems", "No migration, no change to recording or retention. Whatever we build sits on top."]];
  items.forEach((it, i) => card(s, 0.6 + i * 4.1, 1.8, 3.9, 3.6, { eyebrow: it[0], head: it[1], headH: 1.2, body: it[2] }));
  footer(s);
  s.addNotes("The third card is the design constraint that shapes everything: the platform must not change any departmental system.");
}

// 3 Approach ---------------------------------------------------------------
{
  const s = pres.addSlide(); s.background = { color: CREAM };
  title(s, "The approach: read directly, pull once, keep only metadata");
  const items = [["Connect directly, read-only", "One viewer account per VMS, over RTSP, ONVIF, vendor API or SDK. No federation layer between departments. Every non-read call is blocked in code."],
    ["Pull each stream once", "A relay serves any number of operators and the ANPR engine from one pull. Pulls start on demand and stop 10 s after the last viewer leaves."],
    ["Store metadata, not video", "Plate events, evidence crops, tags and indexes. Recorded video stays in each department's VMS, which remains the system of record."]];
  items.forEach((it, i) => {
    card(s, 0.6 + i * 4.1, 1.8, 3.9, 3.6, { head: it[0], headH: 0.8, body: it[1], bodySize: 14 });
    s.addShape(pres.ShapeType.ellipse, { x: 0.85 + i * 4.1, y: 1.35, w: 0.55, h: 0.55, fill: { color: AMBER }, line: { color: AMBER } });
    s.addText(String(i + 1), { x: 0.85 + i * 4.1, y: 1.35, w: 0.55, h: 0.55, fontFace: HF, fontSize: 18, bold: true, color: INK, align: "center", valign: "middle", isTextBox: true, margin: 0 });
  });
  footer(s);
  s.addNotes("These three rules are what let us promise that departmental systems are unaffected. Each is enforced in code and each was tested (slide 8).");
}

// 4 Architecture ---------------------------------------------------------------
{
  const s = pres.addSlide(); s.background = { color: NAVY };
  title(s, "Architecture: every arrow out of a department is a read-only pull", true);
  const box = (x, y, w, h, head, sub, opts = {}) => {
    s.addShape(pres.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.1, fill: { color: opts.fill || PANEL }, line: { color: opts.line || LINE, width: 1.5 } });
    s.addText(head, { x: x + 0.15, y: y + 0.12, w: w - 0.3, h: 0.4, fontFace: HF, fontSize: 16, bold: true, color: opts.text || CREAM, isTextBox: true, margin: 0 });
    s.addText(sub, { x: x + 0.15, y: y + 0.55, w: w - 0.3, h: 0.5, fontFace: BF, fontSize: 11, color: opts.sub || MUTEDL, isTextBox: true, margin: 0, valign: "top" });
  };
  s.addShape(pres.ShapeType.roundRect, { x: 0.6, y: 1.7, w: 3.0, h: 4.6, rectRadius: 0.12, fill: { color: NAVY }, line: { color: "5B6878", width: 1.5, dashType: "dash" } });
  s.addText("Departments, unchanged", { x: 0.8, y: 1.8, w: 2.7, h: 0.3, fontFace: BF, fontSize: 11, bold: true, color: AMBER, isTextBox: true, margin: 0 });
  box(0.8, 2.3, 2.6, 1.15, "Police NVR", "ONVIF + RTSP");
  box(0.8, 4.4, 2.6, 1.15, "Municipal VMS", "REST API + RTSP");
  box(4.4, 2.3, 2.7, 1.15, "Stream relay", "Adapters; one pull per stream", { line: TEAL });
  box(4.4, 4.4, 2.7, 1.15, "ANPR workers", "Detect, PaddleOCR, track, vote");
  box(7.7, 4.4, 2.5, 1.15, "Kafka + indexer", "Tags, watchlist, challan rules");
  box(10.4, 4.4, 2.3, 1.15, "Search stores", "PostgreSQL, Elasticsearch");
  box(10.4, 2.3, 2.3, 1.15, "Web console", "Wall, search, alerts", { fill: AMBER, line: AMBER, text: INK, sub: INK });
  const arrow = (x1, y1, x2, y2, col) => s.addShape(pres.ShapeType.line, { x: x1, y: y1, w: x2 - x1, h: y2 - y1, line: { color: col, width: 2.5, endArrowType: "triangle" }, flipV: y2 < y1 });
  arrow(3.4, 2.87, 4.4, 2.87, TEAL);
  s.addShape(pres.ShapeType.line, { x: 3.4, y: 2.95, w: 1.0, h: 2.02, flipV: true, line: { color: TEAL, width: 2.5, endArrowType: "triangle" } });
  arrow(7.1, 2.87, 10.4, 2.87, AMBER);
  s.addText("WebRTC / HLS", { x: 7.3, y: 2.45, w: 3, h: 0.3, fontFace: BF, fontSize: 11, color: AMBER, align: "center", isTextBox: true, margin: 0 });
  arrow(5.75, 3.45, 5.75, 4.4, MUTEDL);
  arrow(7.1, 4.97, 7.7, 4.97, MUTEDL);
  arrow(10.2, 4.97, 10.4, 4.97, MUTEDL);
  s.addShape(pres.ShapeType.line, { x: 11.55, y: 3.45, w: 0, h: 0.95, flipV: true, line: { color: MUTEDL, width: 2.5, endArrowType: "triangle" } });
  s.addText("API", { x: 11.65, y: 3.75, w: 0.8, h: 0.3, fontFace: BF, fontSize: 11, color: MUTEDL, isTextBox: true, margin: 0 });
  s.addText("Teal arrows are the only contact with departmental systems. Nothing flows back. ANPR reads the relay's copy, never the department directly.", { x: 0.6, y: 6.4, w: 12, h: 0.45, fontFace: BF, fontSize: 12, color: MUTEDL, isTextBox: true, margin: 0 });
  footer(s, true);
  s.addNotes("If the platform is switched off, the departments keep running exactly as today.");
}

// 5 Video wall ---------------------------------------------------------------
{
  const s = pres.addSlide(); s.background = { color: NAVY };
  title(s, "8 live feeds, 2 departments, 1 wall", true);
  s.addImage({ path: "1_video_wall.png", x: 0.6, y: 1.5, w: 8.4, h: 4.725, rounding: false });
  const pts = [["WebRTC", "Sub-second live view, HLS as fallback"], ["1 to 16 tiles", "Grids, full-HD view, saved layouts"], ["Live ANPR", "Plate ticker, watchlist and challan pop-ups"]];
  pts.forEach((p, i) => {
    s.addText(p[0], { x: 9.4, y: 1.6 + i * 1.5, w: 3.3, h: 0.45, fontFace: HF, fontSize: 20, bold: true, color: AMBER, isTextBox: true, margin: 0 });
    s.addText(p[1], { x: 9.4, y: 2.05 + i * 1.5, w: 3.3, h: 0.8, fontFace: BF, fontSize: 13, color: MUTEDL, isTextBox: true, margin: 0, valign: "top" });
  });
  footer(s, true, "Prototype run against simulated Police (ONVIF) and Municipal (REST API) systems");
  s.addNotes("Screenshot from the automated browser test: 8 tiles from both departments on one WebRTC wall; live ANPR ticker at the bottom; alert card at the right.");
}

// 6 Search ---------------------------------------------------------------
{
  const s = pres.addSlide(); s.background = { color: NAVY };
  title(s, "Search a plate and trace its route across departments", true);
  s.addImage({ path: "2_search_dashboard.png", x: 0.6, y: 1.5, w: 5.9, h: 3.32 });
  s.addImage({ path: "3_vehicle_movement.png", x: 6.85, y: 1.5, w: 5.9, h: 3.32 });
  s.addText([{ text: "Search: ", options: { bold: true, color: CREAM } }, { text: "exact, wildcard (MH12*) or one-character fuzzy; filter by camera, tag and time; CSV export.", options: { color: MUTEDL } }], { x: 0.6, y: 4.95, w: 5.9, h: 1.0, fontFace: BF, fontSize: 13, isTextBox: true, margin: 0, valign: "top" });
  s.addText([{ text: "Route: ", options: { bold: true, color: CREAM } }, { text: "MH12AB1234 seen at a Police toll lane, a Municipal gate, then a Police junction, drawn on the camera map.", options: { color: MUTEDL } }], { x: 6.85, y: 4.95, w: 5.9, h: 1.0, fontFace: BF, fontSize: 13, isTextBox: true, margin: 0, valign: "top" });
  footer(s, true, "Access is scoped by department; every plate search is written to the audit log");
  s.addNotes("This is the capability no single departmental system has today: one record of where a vehicle went, across department boundaries.");
}

// 7 ANPR results ---------------------------------------------------------------
{
  const s = pres.addSlide(); s.background = { color: CREAM };
  title(s, "ANPR: 98.1% exact-plate accuracy on the test clips");
  s.addText("98.1%", { x: 0.6, y: 1.5, w: 4.2, h: 1.2, fontFace: HF, fontSize: 66, bold: true, color: AMBERDK, isTextBox: true, margin: 0 });
  s.addText("152 of 155 vehicles read exactly; 99.9% of characters correct. 4 cameras, recorded clips, CPU only.", { x: 0.6, y: 2.75, w: 4.2, h: 1.0, fontFace: BF, fontSize: 14, color: MUTED, isTextBox: true, margin: 0, valign: "top" });
  s.addText("How it got there", { x: 0.6, y: 3.9, w: 4.2, h: 0.4, fontFace: HF, fontSize: 16, bold: true, color: INK, isTextBox: true, margin: 0 });
  s.addText([
    { text: "82.6% — small generic OCR model", options: { bullet: true, breakLine: true } },
    { text: "88.4% — two-line plate handling + character voting across frames", options: { bullet: true, breakLine: true } },
    { text: "98.1% — PaddleOCR reading each plate row, format correction, home-state rule", options: { bullet: true } }],
    { x: 0.6, y: 4.35, w: 4.4, h: 1.8, fontFace: BF, fontSize: 13, color: MUTED, isTextBox: true, margin: 0, valign: "top", paraSpaceAfter: 6 });
  s.addChart(pres.ChartType.bar, [{ name: "Exact-plate rate", labels: ["Toll lane (Police)", "Junction (Police)", "Entry gate (Municipal)", "Depot exit (Municipal)"], values: [97.1, 94.4, 100, 100] }],
    { x: 5.4, y: 1.5, w: 7.3, h: 4.7, barDir: "bar", chartColors: [AMBER], showValue: true, dataLabelPosition: "outEnd", dataLabelFormatCode: '0.0"%"', dataLabelFontSize: 12, dataLabelColor: INK,
      valAxisMinVal: 0, valAxisMaxVal: 100, valAxisLabelColor: MUTED, catAxisLabelColor: INK, catAxisLabelFontSize: 13, valAxisLabelFontSize: 11, valGridLine: { color: "E3DED2", size: 0.5 }, catGridLine: { style: "none" }, showLegend: false, showTitle: true, title: "Exact-plate rate by camera (%)", titleColor: INK, titleFontSize: 14, titleFontFace: HF });
  footer(s, false, "Pipeline: YOLOv9-t plate detector · PaddleOCR PP-OCRv4 · Indian-format correction · multi-frame voting");
  s.addNotes("Synthetic footage is cleaner than real roadside video. Real accuracy is measured in the pilot on labelled frames from each ANPR camera; the same evaluation script runs on real clips.");
}

// 8 Real footage ---------------------------------------------------------------
{
  const s = pres.addSlide(); s.background = { color: CREAM };
  title(s, "Tested on real roadside footage: two-line bike plates, stickers, hidden characters");
  const rows = [["n_white.png", "MP04ZR7493", "Two-line plate read row by row. The '4' in this font is read as 'Z' by one method; the digit other reads saw wins."],
    ["n_yellow.png", "MP70ZC2426", "Commercial plate; the handlebar hides the bottom of the 'Z'. A hidden-bar '7' in a letter slot is treated as 'Z'."],
    ["uc5.png", "MP04????", "Decorative font with a sticker. The sticker is masked before reading; the unreadable series is shown as '????' and flagged for a challan."]];
  rows.forEach((r, i) => {
    const y = 1.6 + i * 1.7;
    s.addShape(pres.ShapeType.roundRect, { x: 0.6, y, w: 12.1, h: 1.5, rectRadius: 0.1, fill: { color: CARD }, line: { color: CARDLINE, width: 1 } });
    s.addImage({ path: r[0], x: 0.8, y: y + 0.15, w: 2.0, h: 1.2 });
    s.addText(r[1], { x: 3.1, y: y + 0.2, w: 2.9, h: 0.55, fontFace: "Courier New", fontSize: 20, bold: true, color: INK, isTextBox: true, margin: 0 });
    s.addText(r[2], { x: 6.2, y: y + 0.15, w: 6.3, h: 1.2, fontFace: BF, fontSize: 13, color: MUTED, isTextBox: true, margin: 0, valign: "middle" });
  });
  footer(s, false, "Plate crops from a user-supplied motorcycle-traffic clip; the platform keeps the crop and full frame as evidence");
  s.addNotes("These three plates drove most of the OCR work: PaddleOCR replaced the small model, plus per-row reading, sticker masking, a home-state rule (MP) and per-position voting across frames.");
}

// 9 Non-standard plates / challan ---------------------------------------------------------------
{
  const s = pres.addSlide(); s.background = { color: AMBER };
  title(s, "Non-standard plates are flagged for a challan, with evidence");
  const cols = [["What is caught", "Decorative fonts, stickers or emoji on the plate, hidden or missing characters. The platform reads the state and RTO code and marks the rest '????'."],
    ["Legal basis", "Central Motor Vehicles Rules 50/51: HSRP plate, prescribed font, no decorations. Penalty under Motor Vehicles Act s.177: Rs 500 first offence, Rs 1,500 repeat (2019 amendment defaults; state notifications apply)."],
    ["What the operator sees", "An alert on the console with the plate crop and frame, tagged non_standard_plate and challan_suggested. A supervisor verifies the picture and acknowledges; the platform suggests, it does not issue."]];
  cols.forEach((c, i) => {
    s.addShape(pres.ShapeType.roundRect, { x: 0.6 + i * 4.1, y: 1.7, w: 3.9, h: 4.3, rectRadius: 0.12, fill: { color: NAVY }, line: { color: NAVY } });
    s.addText(c[0], { x: 0.85 + i * 4.1, y: 1.9, w: 3.4, h: 0.5, fontFace: HF, fontSize: 18, bold: true, color: AMBER, isTextBox: true, margin: 0 });
    s.addText(c[1], { x: 0.85 + i * 4.1, y: 2.5, w: 3.4, h: 3.3, fontFace: BF, fontSize: 14, color: CREAM, isTextBox: true, margin: 0, valign: "top", paraSpaceAfter: 6 });
  });
  footer(s, false, "Section and fine amounts are configurable in rules.yaml; confirm the current state notification with the traffic department before issuing");
  s.addNotes("Amounts and section are set in config/rules.yaml. Legal review of the exact section and state fine schedule is an open item before any challan is issued from this evidence.");
}

// 10 Non-interference evidence ---------------------------------------------------------------
{
  const s = pres.addSlide(); s.background = { color: CREAM };
  title(s, "Departmental systems stayed untouched: 7 of 7 checks passed");
  const rows = [["Check", "Evidence, from the departmental side"],
    ["No write calls to the Police NVR", "16 requests, 0 writes; read-only ONVIF calls only"],
    ["No write calls to the Municipal VMS", "16 requests, 0 writes; login and GET only"],
    ["One session per stream", "1, 5 and 20 viewers each made exactly 1 session on the NVR"],
    ["Idle streams released", "0 sessions 20 s after the last viewer left"],
    ["Stream cap enforced", "Cap of 3: 1 new stream allowed, 3 refused"],
    ["Outage isolated", "Municipal VMS down: Police cameras kept working"],
    ["Platform shutdown harmless", "NVR kept streaming; VMS API kept answering"]];
  const tbl = rows.map((r, i) => r.map(c => ({ text: c, options: i === 0 ? { bold: true, color: CREAM, fill: { color: NAVY }, fontFace: BF, fontSize: 13 } : { color: INK, fontFace: BF, fontSize: 13, fill: { color: i % 2 ? CARD : CREAM } } })));
  s.addTable(tbl, { x: 0.6, y: 1.6, w: 12.1, colW: [4.6, 7.5], rowH: 0.5, border: { type: "solid", color: CARDLINE, pt: 0.75 }, valign: "middle", margin: 0.08 });
  s.addText("Automated test against simulated systems that log every request they receive; the same script is re-run on the real systems in week 8.", { x: 0.6, y: 5.85, w: 12.1, h: 0.5, fontFace: BF, fontSize: 12, color: MUTED, isTextBox: true, margin: 0 });
  footer(s);
  s.addNotes("The simulators deliberately expose write endpoints (PTZ, recording, user creation, reboot) so the test proves the platform never calls them.");
}

// 11 Pilot plan ---------------------------------------------------------------
{
  const s = pres.addSlide(); s.background = { color: CREAM };
  title(s, "An 8-week pilot, ending in a go/no-go");
  const ph = [["Weeks 1–2", "Onboard", "Accounts, firewall rules, adapters, baseline VMS load"], ["Weeks 3–4", "Live view", "Unified wall in the command centre on both sources"], ["Weeks 4–6", "ANPR", "4–8 cameras; label local frames, fine-tune, set thresholds"], ["Weeks 6–7", "Search, alerts", "Dashboard, watchlist, challan rules, operator training"], ["Week 8", "Prove, decide", "Non-interference and rollback tests; go/no-go"]];
  ph.forEach((p, i) => {
    const last = i === 4;
    s.addShape(pres.ShapeType.roundRect, { x: 0.6 + i * 2.46, y: 1.7, w: 2.3, h: 3.4, rectRadius: 0.12, fill: { color: last ? NAVY : CARD }, line: { color: last ? NAVY : CARDLINE, width: 1 } });
    s.addText(p[0], { x: 0.8 + i * 2.46, y: 1.9, w: 1.9, h: 0.3, fontFace: BF, fontSize: 11, bold: true, color: last ? AMBER : AMBERDK, isTextBox: true, margin: 0 });
    s.addText(p[1], { x: 0.8 + i * 2.46, y: 2.25, w: 1.9, h: 0.8, fontFace: HF, fontSize: 19, bold: true, color: last ? CREAM : INK, isTextBox: true, margin: 0, valign: "top" });
    s.addText(p[2], { x: 0.8 + i * 2.46, y: 3.1, w: 1.9, h: 1.8, fontFace: BF, fontSize: 12, color: last ? MUTEDL : MUTED, isTextBox: true, margin: 0, valign: "top" });
  });
  s.addText("Scope: 2 departments, 16–32 cameras, 4–8 of them with ANPR, about 10 operators.", { x: 0.6, y: 5.4, w: 12, h: 0.5, fontFace: BF, fontSize: 14, color: MUTED, isTextBox: true, margin: 0 });
  footer(s);
  s.addNotes("The prototype already covers the software. The pilot weeks go on connecting real systems, measuring on real footage and training operators.");
}

// 12 Acceptance ---------------------------------------------------------------
{
  const s = pres.addSlide(); s.background = { color: CREAM };
  title(s, "Acceptance criteria for scale-out");
  const rows = [["Criterion", "Pilot target", "Prototype so far"],
    ["Sources integrated", "At least 2 VMS from different vendors", "2 simulated (ONVIF, REST API)"],
    ["Live latency", "WebRTC under 1 s, 95th percentile", "Not yet measured"],
    ["Stream availability", "99% of streams start within 3 s", "Not yet measured"],
    ["ANPR accuracy", "90%+ exact plate on ANPR cameras, day", "98.1% on test clips; real footage being measured"],
    ["Alert latency", "Under 2 s from plate to console", "Not yet measured"],
    ["Search speed", "30-day plate query under 1 s", "Not yet at 30-day volume"],
    ["Department impact", "No config change; load within cap", "7 of 7 checks passed"]];
  const tbl = rows.map((r, i) => r.map(c => ({ text: c, options: i === 0 ? { bold: true, color: CREAM, fill: { color: NAVY }, fontFace: BF, fontSize: 13 } : { color: INK, fontFace: BF, fontSize: 13, fill: { color: i === 7 ? "FBE7C4" : (i % 2 ? CARD : CREAM) } } })));
  s.addTable(tbl, { x: 0.6, y: 1.6, w: 12.1, colW: [3.2, 4.6, 4.3], rowH: 0.5, border: { type: "solid", color: CARDLINE, pt: 0.75 }, valign: "middle", margin: 0.08 });
  footer(s);
  s.addNotes("Four criteria can only be measured on real systems and real traffic volumes. Department impact, the one departments care most about, already passes.");
}

// 13 Risks ---------------------------------------------------------------
{
  const s = pres.addSlide(); s.background = { color: CREAM };
  title(s, "Risks and how we handle them");
  const rows = [["Risk", "Mitigation"],
    ["A VMS has no RTSP, ONVIF or API", "Vendor SDK bridge, or read cameras directly with consent"],
    ["Vendor limits on live-view sessions", "One pull per stream; agree a cap with each department"],
    ["Decorative fonts and small plates on real roads", "PaddleOCR + per-row reading; fine-tune on local crops; ANPR only on suitable cameras"],
    ["Night and infrared footage", "Auto night mode: frame and crop enhancement (97% vs 94% on a darkened clip)"],
    ["Legal and privacy approvals, challan basis", "Start sign-off in week 1; ANPR only on approved cameras; legal confirms MV Act section and fines"],
    ["Clock drift across systems", "NTP on all nodes; store source and ingest time"]];
  const tbl = rows.map((r, i) => r.map(c => ({ text: c, options: i === 0 ? { bold: true, color: CREAM, fill: { color: NAVY }, fontFace: BF, fontSize: 13 } : { color: INK, fontFace: BF, fontSize: 13, fill: { color: i % 2 ? CARD : CREAM } } })));
  s.addTable(tbl, { x: 0.6, y: 1.6, w: 12.1, colW: [4.6, 7.5], rowH: 0.55, border: { type: "solid", color: CARDLINE, pt: 0.75 }, valign: "middle", margin: 0.08 });
  footer(s);
  s.addNotes("The biggest schedule risk is approvals, not technology. The design follows the Digital Personal Data Protection Act, 2023: minimal data, retention limits, access logs.");
}

// 14 Ask ---------------------------------------------------------------
{
  const s = pres.addSlide(); s.background = { color: NAVY };
  title(s, "To start, we need five things", true);
  const items = [["Two departments", "Named, each with a technical contact"], ["Read-only access", "One viewer account per VMS"], ["Network rules", "Platform to VMS on RTSP and ONVIF or HTTPS only"], ["Hardware", "3 servers and 1 GPU in the command centre"], ["ANPR sign-off", "Legal approval for named cameras and the challan basis"]];
  items.forEach((it, i) => {
    const x = 0.6 + (i % 3) * 4.1, y = 1.6 + Math.floor(i / 3) * 1.85;
    card(s, x, y, 3.9, 1.65, { dark: true, head: it[0], headH: 0.45, body: it[1], bodySize: 13 });
  });
  s.addShape(pres.ShapeType.roundRect, { x: 8.8, y: 3.45, w: 3.9, h: 1.65, rectRadius: 0.12, fill: { color: AMBER }, line: { color: AMBER } });
  s.addText("Decision: approve an 8-week pilot with [Department A] and [Department B], starting [date].", { x: 9.0, y: 3.6, w: 3.5, h: 1.35, fontFace: HF, fontSize: 15, bold: true, color: INK, isTextBox: true, margin: 0, valign: "middle" });
  s.addText("Prototype code, architecture note, accuracy and non-interference reports are ready to hand over.", { x: 0.6, y: 5.6, w: 12, h: 0.5, fontFace: BF, fontSize: 14, color: MUTEDL, isTextBox: true, margin: 0 });
  footer(s, true);
  s.addNotes("Indicative hardware: stream node 16 vCPU/32 GB, AI node 16 vCPU/64 GB + one NVIDIA L4 or RTX A4000, data node 16 vCPU/64 GB/2 TB NVMe. Fill in the departments and start date before presenting.");
}

pres.writeFile({ fileName: "Unified_CCTV_Pilot.pptx" }).then(f => console.log("wrote", f));
