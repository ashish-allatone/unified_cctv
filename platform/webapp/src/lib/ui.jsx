import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

/* Toasts + a single modal dialog. The hosts render inside the app tree (<UIHosts/>) so dialog
   components can use every context (app, i18n). */
const UICtx = createContext(null);
let seq = 0;

export function UIProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [modalNode, setModalNode] = useState(null);
  const timers = useRef({});

  const dismiss = useCallback((id) => { clearTimeout(timers.current[id]); setToasts((l) => l.filter((x) => x.id !== id)); }, []);
  /** Plain text toast; kind "ok" gets a green border ("err" / "warn" keep the default). */
  const toast = useCallback((msg, kind) => {
    const id = ++seq;
    setToasts((l) => [{ id, msg, kind }, ...l]);
    timers.current[id] = setTimeout(() => dismiss(id), 4000);
  }, [dismiss]);
  /** Rich toast (alerts): content is a node, click runs onClick. */
  const richToast = useCallback((node, { onClick, timeout = 12000 } = {}) => {
    const id = ++seq;
    setToasts((l) => [{ id, node, onClick }, ...l]);
    timers.current[id] = setTimeout(() => dismiss(id), timeout);
  }, [dismiss]);
  const modal = useCallback((node) => setModalNode(node), []);
  const closeModal = useCallback(() => setModalNode(null), []);

  const value = useMemo(() => ({ toast, richToast, dismiss, modal, closeModal, toasts, modalNode }), [toast, richToast, dismiss, modal, closeModal, toasts, modalNode]);
  return <UICtx.Provider value={value}>{children}</UICtx.Provider>;
}

export const useUI = () => useContext(UICtx);

export function UIHosts() {
  const { toasts, dismiss, modalNode, closeModal } = useUI();
  return (
    <>
      <div id="modal" className={`modal${modalNode ? "" : " hidden"}`} role="dialog" aria-modal="true"
        onClick={(e) => { if (e.target.id === "modal") closeModal(); }}>
        <div className="modal-card">
          <button className="modal-x" id="modal-x" aria-label="Close" onClick={closeModal}>×</button>
          <div id="modal-body">{modalNode}</div>
        </div>
      </div>
      <div id="toasts" role="status" aria-live="polite">
        {toasts.map((x) => x.node
          ? <div key={x.id} className="toast" onClick={() => { dismiss(x.id); x.onClick?.(); }}>{x.node}</div>
          : <div key={x.id} className="toast" style={{ gridTemplateColumns: "1fr", ...(x.kind === "ok" ? { borderColor: "var(--ok)" } : {}) }}>{x.msg}</div>)}
      </div>
    </>
  );
}
