import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { X, Info, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";

export type ToastLevel = "info" | "success" | "warning" | "error";

interface ToastItem {
  id: string;
  message: string;
  level: ToastLevel;
  duration: number;
  createdAt: number;
}

type ShowToastFn = (message: string, level?: ToastLevel, duration?: number) => void;

const ToastContext = createContext<ShowToastFn | null>(null);

const DEFAULT_DURATION = 3000;

const ICONS: Record<ToastLevel, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

interface ToastViewProps {
  item: ToastItem;
  onDismiss: (id: string) => void;
}

function ToastView({ item, onDismiss }: ToastViewProps) {
  const [leaving, setLeaving] = useState(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const Icon = ICONS[item.level];

  const beginDismiss = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    setTimeout(() => onDismiss(item.id), 220);
  }, [leaving, item.id, onDismiss]);

  useEffect(() => {
    dismissTimerRef.current = setTimeout(beginDismiss, item.duration);
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [item.duration, beginDismiss]);

  return (
    <div
      className={`phantom-toast phantom-toast-${item.level} ${leaving ? "leaving" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span className="phantom-toast-icon" aria-hidden="true">
        <Icon size={18} strokeWidth={1.75} />
      </span>
      <span className="phantom-toast-message">{item.message}</span>
      <button
        type="button"
        className="phantom-toast-close"
        aria-label="Закрыть"
        onClick={beginDismiss}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counterRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const show: ShowToastFn = useCallback(
    (message, level = "info", duration = DEFAULT_DURATION) => {
      counterRef.current += 1;
      const id = `t${Date.now()}-${counterRef.current}`;
      setToasts(prev => [
        ...prev.slice(-3), // max 4 stacked
        { id, message, level, duration, createdAt: Date.now() },
      ]);
    },
    [],
  );

  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="phantom-toast-stack" aria-live="polite">
        {toasts.map(t => (
          <ToastView key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function usePhantomToast(): ShowToastFn {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("usePhantomToast must be used inside <ToastProvider>");
  }
  return ctx;
}
