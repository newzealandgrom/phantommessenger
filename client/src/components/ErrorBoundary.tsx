import { Component, type ReactNode } from "react";
import { slog } from "../lib/log";

/**
 * WEB-05: граница ошибок рендера. Без неё любое исключение в дереве React
 * (например, нарушение Rules of Hooks в CallOverlay) размонтирует всё
 * приложение в белый экран.
 *
 * - `variant="screen"` — корень приложения (полноэкранный fallback);
 * - `variant="panel"`  — отдельная панель (чат) внутри раскладки;
 * - `variant="overlay"` — поверх всего (звонок), с кнопкой «Закрыть».
 *
 * `resetKey` — при смене значения ошибка сбрасывается и дети рендерятся
 * заново (например, звонок завершился → оверлей снова пустой).
 *
 * В лог пишем только имя области и тип ошибки — без props/state, чтобы
 * случайно не утащить текст сообщений (X-08).
 */
type Props = {
  children: ReactNode;
  scope: string;
  variant?: "screen" | "panel" | "overlay";
  resetKey?: unknown;
  onDismiss?: () => void;
};

type State = { failed: boolean };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    const name
 = error instanceof Error ? error.name : typeof error;
    slog.error(`[ErrorBoundary] ${this.props.scope}: render failed (${name})`);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  private dismiss = () => {
    this.setState({ failed: false });
    this.props.onDismiss?.();
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const variant = this.props.variant ?? "panel";
    const wrapClass =
      variant === "overlay" ? "tg-call-overlay pm-empty-chat" : "pm-empty-chat";
    return (
      <div
        className={wrapClass}
        role="alert"
        style={variant === "screen" ? { minHeight: "100vh" } : undefined}
      >
        <div className="pm-empty-chat-inner">
          <h2 className="pm-empty-chat-title">{"Что-то пошло не так"}</h2>
          <p className="pm-empty-chat-body">
            {"Интерфейс столкнулся с ошибкой. Перезагрузите страницу, чтобы продолжить."}
          </p>
          <div style={{ display: "flex", gap: "var(--spacing-2)", justifyContent: "center", marginTop: "var(--spacing-4)" }}>
            <button type="button" className="pm-btn pm-btn-primary" onClick={() => location.reload()}>
              {"Перезагрузить"}
            </button>
            {this.props.onDismiss && (
              <button type="button" className="pm-btn pm-btn-ghost" onClick={this.dismiss}>
                {"Закрыть"}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
