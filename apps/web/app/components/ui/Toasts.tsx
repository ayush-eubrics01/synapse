"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/** Shorter than the 5 s Undo deferral (`UNDO_DELAY_MS`), so Undo closes before a commit starts. */
export const TOAST_MS = 4500;

interface Toast {
  id: number;
  text: string;
  undo?: () => void;
}

interface ToastApi {
  show(text: string, undo?: () => void): void;
}

interface ToastState {
  toast: Toast | null;
  dismiss(id: number): void;
}

const noop: ToastApi = { show: () => {} };
const ShowContext = createContext<ToastApi>(noop);
const StateContext = createContext<ToastState>({ toast: null, dismiss: () => {} });

/** One toast at a time: the newest replaces any earlier one, each shows for 4.5 s. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const nextId = useRef(0);
  const show = useCallback((text: string, undo?: () => void) => {
    nextId.current += 1;
    setToast({ id: nextId.current, text, undo });
  }, []);
  const dismiss = useCallback((id: number) => {
    setToast((t) => (t?.id === id ? null : t));
  }, []);
  const api = useMemo<ToastApi>(() => ({ show }), [show]);
  const state = useMemo<ToastState>(() => ({ toast, dismiss }), [toast, dismiss]);
  return (
    <ShowContext.Provider value={api}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </ShowContext.Provider>
  );
}

/** Outside a provider, show() does nothing. */
export function useToast(): ToastApi {
  return useContext(ShowContext);
}

export function Toasts() {
  const { toast, dismiss } = useContext(StateContext);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => dismiss(toast.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast, dismiss]);
  return (
    <div className="syn-toasts" role="status" aria-live="polite">
      {toast && (
        <div key={toast.id} className="syn-toast">
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              type="button"
              className="syn-toast-undo"
              onClick={() => {
                toast.undo?.();
                dismiss(toast.id);
              }}
            >
              Undo
            </button>
          )}
          <button
            type="button"
            className="syn-toast-close"
            aria-label="Dismiss"
            onClick={() => dismiss(toast.id)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
