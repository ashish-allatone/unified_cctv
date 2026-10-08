import { useEffect, useRef } from "react";
import { useParams } from "react-router-dom";

/** Admin sections not yet rebuilt in React: the legacy Admin page, opened at that section, inside an iframe. */
export default function AdminLegacy() {
  const { section = "overview" } = useParams();
  const frame = useRef<HTMLIFrameElement>(null);
  const initial = useRef(section);
  useEffect(() => { if (section !== initial.current) frame.current?.contentWindow?.postMessage({ type: "uvp:show", view: "admin", sec: section }, location.origin); }, [section]);
  return <iframe ref={frame} className="legacy-frame" style={{ height: "calc(100vh - 140px)", borderRadius: 12 }} title={`admin ${section}`} src={`/legacy/?embed=1#view=admin&sec=${initial.current}`} />;
}
