export const IST: Intl.DateTimeFormatOptions = { timeZone: "Asia/Kolkata", hour12: false };
export const fmtTime = (iso?: string | null) => iso ? new Date(iso).toLocaleString("en-IN", { ...IST, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "–";
export const fmtDay = (iso: string) => new Date(iso).toLocaleString("en-IN", { ...IST, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export const toIso = (v: string) => (v ? new Date(v).toISOString() : "");
export const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
