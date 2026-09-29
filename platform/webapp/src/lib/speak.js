/* Spoken alerts (browser text-to-speech, en / hi / gu). */
import { store } from "./api.js";
import { tr } from "./i18n.jsx";

export const SPEAK = { on: store.get("uvp-speak") === "1", last: "" };
const SPEAK_LANG = { en: "en-IN", hi: "hi-IN", gu: "gu-IN" };

export function speakVoice(lang) {
  const want = SPEAK_LANG[lang] || "en-IN", vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  return vs.find((v) => v.lang.replace("_", "-") === want) || vs.find((v) => v.lang.startsWith(want.slice(0, 2))) || null;
}
export function speak(text, lang = document.documentElement.lang || "en") {
  if (!SPEAK.on || !window.speechSynthesis || !text) return;
  SPEAK.last = text;
  const u = new SpeechSynthesisUtterance(text);
  const v = speakVoice(lang) || speakVoice("en");
  if (v) u.voice = v;
  u.lang = v ? v.lang : SPEAK_LANG[lang] || "en-IN";
  u.rate = 0.95;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
const speakPlate = (p) => String(p || "").split("").join(" ");   // "G J 0 1 A B 1 2 3 4" reads clearly in every language
export function speakAlert(a, camName) {
  const kind = a.match === "rule" ? tr("speak.rule", "violation") : a.match === "face" ? tr("speak.person", "person of interest sighted") : tr("speak.watchlist", "watchlist vehicle");
  const plate = a.match === "face" ? (a.reason || "").split(/[:(]/)[0].trim() : speakPlate(a.plate);
  speak(tr("speak.alert", "Alert. {kind} {plate} at {camera}, {department}.").replace("{kind}", kind).replace("{plate}", plate)
    .replace("{camera}", camName).replace("{department}", a.department || ""));
}
export function setSpeakOn(on) { SPEAK.on = on; store.set("uvp-speak", on ? "1" : "0"); }
