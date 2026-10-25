import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { ArrowRight, ChevronLeft, Crown, Shield } from "lucide-react";
import { formatNumber, normalizeNumber } from "../lib/phone";
import { useT } from "../lib/i18n";
import { isCustomOperator } from "../lib/operatorInfo";
import { useOperator } from "../lib/useOperator";

type Screen = "login" | "otp" | "messenger";
type AuthMode = "welcome" | "numpad";

const OTP_LENGTH = 6;

export interface AuthScreenProps {
  screen: Screen;
  inputNumber: string;
  setInputNumber: (v: string) => void;
  pendingNumber: string;
  otp: string[];
  otpSeconds: number;
  authBusy: boolean;
  authError: string;
  requestCode: (num: string) => void;
  verifyCode: () => void;
  handleOtpInput: (index: number, value: string) => void;
  handleOtpKeyDown: (index: number, key: string) => void;
  handleOtpPaste: (e: React.ClipboardEvent) => void;
  otpRefs: MutableRefObject<Array<HTMLInputElement | null>>;
  navigate: (screen: Screen) => void;
  setAuthError: (v: string) => void;
  setOtp: (v: string[]) => void;
  /** Режим «Добавить аккаунт» (мультиаккаунт): сразу ввод номера, кнопка «Отмена» возвращает прежний аккаунт. */
  addingAccount?: boolean;
  onCancelAdd?: () => void;
}

function formatPhantomDisplay(digits: string): string {
  const parts: string[] = [];
  if (digits.length <= 3) return digits;
  parts.push(digits.slice(0, 3));
  if (digits.length <= 5) { parts.push(digits.slice(3)); return parts.join("-"); }
  parts.push(digits.slice(3, 5));
  if (digits.length <= 8) { parts.push(digits.slice(5)); return parts.join("-"); }
  parts.push(digits.slice(5, 8));
  parts.push(digits.slice(8, 10));
  return parts.join("-");
}

const PLACEHOLDER = "111-00-000-00";

export default function AuthScreen(props: AuthScreenProps) {
  const {
    screen, inputNumber, setInputNumber, pendingNumber, otp, otpSeconds,
    authBusy, authError, requestCode, verifyCode, handleOtpInput,
    handleOtpKeyDown, handleOtpPaste, otpRefs, navigate, setAuthError, setOtp,
    addingAccount = false, onCancelAdd,
  } = props;
  const { t } = useT();
  const { op: operator } = useOperator();

  const [mode, setMode] = useState<AuthMode>(() => (inputNumber || addingAccount ? "numpad" : "welcome"));
  const [showLegal, setShowLegal] = useState(false);
  const otpFilled = otp.every(item => item.length === 1);
  const digits = (inputNumber || "").replace(/\D/g, "").slice(0, 10);
  const display = digits ? formatPhantomDisplay(digits) : PLACEHOLDER;
  const canSubmitNumber = !!normalizeNumber(inputNumber) && digits.length === 10;
  const numberInputRef = useRef<HTMLInputElement | null>(null);

  // Автофокус скрытого инпута при входе в режим numpad — для клавиатуры и paste.
  useEffect(() => {
    if (screen === "login" && mode === "numpad") {
      const el = numberInputRef.current;
      if (el) {
        el.focus();
        try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* ignore */ }
      }
    }
  }, [mode, screen]);

  const otpFocusOnce = useState(false);
  useEffect(() => {
    if (screen === "otp" && !otpFocusOnce[0]) {
      const ref = otpRefs.current?.[0];
      if (ref) ref.focus();
      otpFocusOnce[1](true);
    }
    if (screen !== "otp" && otpFocusOnce[0]) otpFocusOnce[1](false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  const pushDigit = (d: string) => {
    setAuthError("");
    if (digits.length >= 10) return;
    setInputNumber(formatPhantomDisplay(digits + d));
  };

  const popDigit = () => {
    setAuthError("");
    setInputNumber(formatPhantomDisplay(digits.slice(0, -1)));
  };

  // Полная замена номера — для paste / прямого ввода с клавиатуры.
  const setDigits = (raw: string) => {
    const onlyDigits = (raw || "").replace(/\D/g, "").slice(0, 10);
    setAuthError("");
    setInputNumber(formatPhantomDisplay(onlyDigits));
  };

  const onSubmitNumber = () => {
    if (!canSubmitNumber || authBusy) return;
    requestCode(inputNumber);
  };

  const onPasteNumber: React.ClipboardEventHandler = (e) => {
    e.preventDefault();
    const txt = e.clipboardData?.getData("text") || "";
    if (!txt) return;
    setDigits(txt);
    if (txt.replace(/\D/g, "").length >= 10) {
      // лёгкий автосабмит после успешной вставки полного номера
      setTimeout(() => {
        if (!authBusy) requestCode(formatPhantomDisplay(txt.replace(/\D/g, "").slice(0, 10)));
      }, 50);
    }
  };

  const onKeyDownNumber: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === "Enter") { e.preventDefault(); onSubmitNumber(); return; }
    if (e.key === "Backspace") { e.preventDefault(); popDigit(); return; }
    if (e.key === "Delete") { e.preventDefault(); popDigit(); return; }
    if (e.key === "Escape") { e.preventDefault(); if (addingAccount && onCancelAdd) { if (!authBusy) onCancelAdd(); } else setMode("welcome"); return; }
    if (e.key.length === 1 && /\d/.test(e.key)) { e.preventDefault(); pushDigit(e.key); return; }
    // разрешаем системные комбинации (Cmd/Ctrl+V/A/C) — paste обрабатывается onPaste
    if (e.metaKey || e.ctrlKey) return;
    if (["ArrowLeft", "ArrowRight", "Tab", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
  };

  // Helper: numpad
  const Numpad = ({ onPress, onBackspace, height = 48 }: {
    onPress: (d: string) => void; onBackspace: () => void; height?: number;
  }) => (
    <div className="pm-numpad">
      {[1,2,3,4,5,6,7,8,9].map(n => (
        <button
          key={n}
          type="button"
          className="pm-numpad-key"
          style={{ height }}
          onClick={() => onPress(String(n))}
          aria-label={`Цифра ${n}`}
        >
          {n}
        </button>
      ))}
      <span className="pm-numpad-key empty" aria-hidden="true" />
      <button
        type="button"
        className="pm-numpad-key"
        style={{ height }}
        onClick={() => onPress("0")}
        aria-label="Цифра 0"
      >
        0
      </button>
      <button
        type="button"
        className="pm-numpad-key"
        style={{ height }}
        onClick={onBackspace}
        aria-label="Стереть"
      >
        ⌫
      </button>
    </div>
  );

  return (
    <div className="app-root">
      <main className="auth-shell">
        <section className="auth-card" aria-label="Phantom вход">
          <div className="pm-auth-flow">

            {/* === Welcome === */}
            {screen === "login" && mode === "welcome" && (
              <div className="pm-welcome">
                <div className="pm-welcome-head">
                  <div className="pm-welcome-logo">{"👻"}</div>
                  <h1 className="pm-welcome-title">{t("welcome.title")}</h1>
                  <div className="pm-welcome-tag">{t("welcome.tag")}</div>
                </div>

                <div className="pm-welcome-card">
                  <div className="pm-welcome-card-head">
                    <div className="pm-welcome-card-icon">
                      <Crown size={22} strokeWidth={2} color="#fff" />
                    </div>
                    <div>
                      <h3 className="pm-welcome-card-title">{t("welcome.cardTitle")}</h3>
                      <div className="pm-welcome-card-sub">{t("welcome.cardSub")}</div>
                    </div>
                  </div>
                  <div className="pm-welcome-card-body">
                    {t("welcome.cardBody.before")}<a href="https://phantomnumbers.org" target="_blank" rel="noopener noreferrer" style={{ color: "#67e8f9", textDecoration: "underline", fontWeight: 600 }}>phantomnumbers.org</a>{t("welcome.cardBody.after")}
                  </div>
                  <button
                    type="button"
                    className="pm-welcome-card-cta spring-press"
                    onClick={() => setMode("numpad")}
                  >
                    {t("welcome.cta")}
                    <ArrowRight size={16} strokeWidth={2.4} />
                  </button>
                </div>

                <div className="pm-welcome-info">
                  <div className="pm-welcome-info-ic">
                    <Shield size={16} color="#34d399" strokeWidth={2.2} />
                  </div>
                  <div className="pm-welcome-info-text">
                    {t("welcome.shieldNote")}
                  </div>
                </div>

                <div className="pm-welcome-foot">
                  v1.0.0 · <span
                    className="link"
                    role="button"
                    tabIndex={0}
                    onClick={() => setShowLegal(true)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setShowLegal(true); } }}
                  >{t("welcome.legal")}</span>
                </div>
              </div>
            )}

            {/* === Phantom Number numpad === */}
            {screen === "login" && mode === "numpad" && (
              <>
                <div className="pm-auth-step-head">
                  <button
                    type="button"
                    className="pm-icon-btn pm-icon-btn-md"
                    disabled={addingAccount && authBusy}
                    onClick={() => { if (addingAccount && onCancelAdd) { if (!authBusy) onCancelAdd(); } else setMode("welcome"); }}
                    aria-label={t("common.back")}
                  >
                    <ChevronLeft size={16} strokeWidth={2} />
                  </button>
                  <div className="pm-auth-step-meta">
                    <div className="pm-auth-step-num">{addingAccount ? t("accounts.adding") : t("auth.step1")}</div>
                    <div className="pm-auth-step-title">{t("auth.numTitle")}</div>
                  </div>
                  {addingAccount && onCancelAdd && (
                    <button type="button" className="pm-btn pm-btn-ghost pm-auth-cancel-add" data-testid="add-account-cancel" style={{ marginLeft: "auto", padding: "6px 14px", fontSize: 12 }} disabled={authBusy} onClick={() => { if (!authBusy) onCancelAdd(); }}>
                      {t("common.cancel")}
                    </button>
                  )}
                </div>

                <div className="pm-auth-head">
                  <h2 className="pm-auth-head-title">{t("auth.headEnter")}</h2>
                  <p className="pm-auth-head-sub">{t("auth.headEnterSub")}</p>
                </div>

                <div
                  className={`pm-auth-display ${!digits ? "placeholder" : ""}`}
                  role="textbox"
                  tabIndex={0}
                  aria-label="Phantom Number"
                  onClick={() => numberInputRef.current?.focus()}
                  onPaste={onPasteNumber}
                  style={{ cursor: "text" }}
                >
                  {display}
                </div>

                {/* Скрытый input для клавиатурного ввода и paste (Cmd/Ctrl+V) */}
                <input
                  ref={numberInputRef}
                  type="tel"
                  inputMode="numeric"
                  autoComplete="off"
                  value={digits}
                  onChange={(e) => setDigits(e.target.value)}
                  onKeyDown={onKeyDownNumber}
                  onPaste={onPasteNumber}
                  aria-hidden="true"
                  tabIndex={-1}
                  style={{
                    position: "absolute",
                    width: 1,
                    height: 1,
                    opacity: 0,
                    pointerEvents: "none",
                    border: 0,
                    padding: 0,
                    margin: 0,
                  }}
                />

                {authError && <div className="pm-auth-error">{authError}</div>}

                <Numpad onPress={pushDigit} onBackspace={popDigit} />

                <button
                  type="button"
                  className="pm-auth-cta spring-press"
                  disabled={authBusy || !canSubmitNumber}
                  onClick={onSubmitNumber}
                >
                  {authBusy ? t("auth.cta.sending") : t("auth.cta.send")}
                </button>
              </>
            )}

            {/* === OTP === */}
            {screen === "otp" && (
              <>
                <div className="pm-auth-step-head">
                  <button
                    type="button"
                    className="pm-icon-btn pm-icon-btn-md"
                    disabled={authBusy}
                    onClick={() => { setAuthError(""); setOtp(Array(OTP_LENGTH).fill("")); navigate("login"); setMode("numpad"); }}
                    aria-label={t("common.back")}
                  >
                    <ChevronLeft size={16} strokeWidth={2} />
                  </button>
                  <div className="pm-auth-step-meta">
                    <div className="pm-auth-step-num">{addingAccount ? t("accounts.adding") : t("auth.step2")}</div>
                    <div className="pm-auth-step-title">{t("auth.codeTitle")}</div>
                  </div>
                  {addingAccount && onCancelAdd && (
                    <button type="button" className="pm-btn pm-btn-ghost pm-auth-cancel-add" data-testid="add-account-cancel" style={{ marginLeft: "auto", padding: "6px 14px", fontSize: 12 }} disabled={authBusy} onClick={() => { if (!authBusy) onCancelAdd(); }}>
                      {t("common.cancel")}
                    </button>
                  )}
                </div>

                <div className="pm-auth-head">
                  <h2 className="pm-auth-head-title">{t("otp.title")}</h2>
                  <p className="pm-auth-head-sub">{t("otp.sub")}</p>
                </div>

                <div className="pm-otp-num-display">{formatNumber(pendingNumber)}</div>

                <div
                  className="pm-otp-cells"
                  onPaste={handleOtpPaste}
                  role="group"
                  aria-label={t("auth.codeTitle")}
                >
                  {otp.map((digit, index) => (
                    <input
                      key={index}
                      ref={node => { otpRefs.current[index] = node; }}
                      value={digit}
                      inputMode="numeric"
                      maxLength={1}
                      autoComplete={index === 0 ? "one-time-code" : "off"}
                      aria-label={`${index + 1} / ${OTP_LENGTH}`}
                      className={`pm-otp-cell ${digit ? "filled" : "empty"}`}
                      onChange={e => handleOtpInput(index, e.target.value)}
                      onKeyDown={e => handleOtpKeyDown(index, e.key)}
                    />
                  ))}
                </div>

                <div className="pm-otp-resend">
                  {otpSeconds > 0 ? (
                    <>{t("otp.notReceived")}<span className="pm-otp-resend-link" style={{ color: "#67e8f9" }}>{t("otp.resendIn")}{String(otpSeconds).padStart(2, "0")}</span></>
                  ) : (
                    <>{t("otp.notReceived")}<button type="button" className="pm-otp-resend-link" onClick={() => requestCode(pendingNumber)} disabled={authBusy}>
                      {t("otp.resendNow")}
                    </button></>
                  )}
                </div>

                {authError && <div className="pm-auth-error">{authError}</div>}

                <button
                  type="button"
                  className="pm-auth-cta spring-press"
                  disabled={authBusy || !otpFilled}
                  onClick={() => verifyCode()}
                >
                  {authBusy ? t("auth.cta.verifying") : t("auth.cta.verify")}
                </button>
              </>
            )}

          </div>
        </section>

        {showLegal && (
          <div className="pm-legal-overlay" onClick={() => setShowLegal(false)}>
            <div className="pm-legal-modal" onClick={(e) => e.stopPropagation()}>
              <div className="pm-legal-head">
                <div>
                  <div className="pm-legal-eyebrow">{t("legal.eyebrow")}</div>
                  <h2 className="pm-legal-title">{t("legal.title")}</h2>
                </div>
                <button
                  type="button"
                  className="pm-icon-btn pm-icon-btn-md"
                  onClick={() => setShowLegal(false)}
                  aria-label={t("common.close")}
                >×</button>
              </div>

              <div className="pm-legal-body">
                <h3 className="pm-legal-h3">{t("legal.short")}</h3>
                <ul className="pm-legal-ul">
                  <li>{t("legal.short.1")}</li>
                  <li>{t("legal.short.2")}</li>
                  <li>{t("legal.short.3")}</li>
                  <li>{t("legal.short.4")}</li>
                </ul>

                <h3 className="pm-legal-h3">{t("legal.h1")}</h3>
                <p>{t("legal.p1")}</p>

                <h3 className="pm-legal-h3">{t("legal.h2")}</h3>
                <p>{t("legal.p2.1")}<a href="https://phantomnumbers.org" target="_blank" rel="noopener noreferrer">phantomnumbers.org</a>{t("legal.p2.2")}</p>

                <h3 className="pm-legal-h3">{t("legal.h3")}</h3>
                <p><strong>{t("legal.p3a")}</strong>{t("legal.p3a.body")}</p>
                <p><strong>{t("legal.p3b")}</strong>{t("legal.p3b.body")}</p>

                <h3 className="pm-legal-h3">{t("legal.h4")}</h3>
                <ul className="pm-legal-ul">
                  <li>{t("legal.p4.1")}</li>
                  <li>{t("legal.p4.2")}</li>
                  <li>{t("legal.p4.3")}</li>
                  <li>{t("legal.p4.4")}</li>
                </ul>

                <h3 className="pm-legal-h3">{t("legal.h5")}</h3>
                <p>{t("legal.p5")}</p>

                <h3 className="pm-legal-h3">{t("legal.h6")}</h3>
                <ul className="pm-legal-ul">
                  <li>{t("legal.p6.1")}</li>
                  <li>{t("legal.p6.2")}</li>
                  <li>{t("legal.p6.3")}</li>
                </ul>

                <h3 className="pm-legal-h3">{t("legal.h7")}</h3>
                <p>{t("legal.p7")}</p>

                <h3 className="pm-legal-h3">{t("legal.h8")}</h3>
                <p>{t("legal.p8")}</p>

                <h3 className="pm-legal-h3">{t("legal.h9")}</h3>
                <p>{t("legal.p9", { email: "{email}" }).split("{email}").map((part, i, arr) => (<span key={i}>{part}{i < arr.length - 1 && <a href={`mailto:${operator.contactEmail}`}>{operator.contactEmail}</a>}</span>))}</p>
                {isCustomOperator(operator) && <p>{t("legal.operator", { name: operator.name })}</p>}

                <p className="pm-legal-meta">{t("legal.meta")}</p>
                <p>{t("legal.full")} <a href={operator.termsUrl ?? "/terms"} target="_blank" rel="noopener noreferrer">{t("legal.fullTerms")}</a> · <a href={operator.privacyUrl ?? "/privacy"} target="_blank" rel="noopener noreferrer">{t("legal.fullPrivacy")}</a></p>
              </div>

              <div className="pm-legal-foot">
                <button
                  type="button"
                  className="pm-btn pm-btn-primary"
                  onClick={() => setShowLegal(false)}
                >{t("common.gotIt")}</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
