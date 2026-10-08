export default function Pager({ page, pages, total, onPage, size, onSize }: { page: number; pages: number; total: number; onPage: (p: number) => void; size?: number; onSize?: (n: number) => void }) {
  const around: number[] = []; for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++) around.push(p);
  const B = ({ p, label, cls = "" }: { p: number; label: string; cls?: string }) => <button className={`btn ghost small ${cls}`} disabled={p < 1 || p > pages} onClick={() => onPage(p)}>{label}</button>;
  return (
    <div className="pager">
      <span>{total} row{total === 1 ? "" : "s"}{onSize && size ? <> · <select value={size} onChange={(e) => onSize(+e.target.value)}>{[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} / page</option>)}</select></> : null}</span>
      <span>{pages > 1 && <><B p={1} label="«" /><B p={page - 1} label="‹" />{around[0] > 1 && <span>…</span>}{around.map((p) => <B key={p} p={p} label={String(p)} cls={p === page ? "active" : ""} />)}{around[around.length - 1] < pages && <span>…</span>}<B p={page + 1} label="›" /><B p={pages} label="»" /></>}</span>
    </div>
  );
}
