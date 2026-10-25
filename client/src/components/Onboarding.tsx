import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { useT } from "../lib/i18n";

interface OnboardingPage {
  emoji: string;
  isMonoEmoji?: boolean;
  titleKey: string;
  bodyKey: string;
  chipKey: string;
}

const PAGES: OnboardingPage[] = [
  { emoji: "💨",          titleKey: "onb.1.title", bodyKey: "onb.1.body", chipKey: "onb.1.chip" },
  { emoji: "🔑",          titleKey: "onb.2.title", bodyKey: "onb.2.body", chipKey: "onb.2.chip" },
  { emoji: "::111-00::", isMonoEmoji: true, titleKey: "onb.3.title", bodyKey: "onb.3.body", chipKey: "onb.3.chip" },
];

interface OnboardingProps {
  onComplete: () => void;
}

type Stage = "splash" | "intro";

export default function Onboarding({ onComplete }: OnboardingProps) {
  const { t } = useT();
  const [stage, setStage] = useState<Stage>("splash");
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (stage !== "splash") return;
    const tm = setTimeout(() => setStage("intro"), 1600);
    return () => clearTimeout(tm);
  }, [stage]);

  const isLast = page === PAGES.length - 1;

  const handleNext = () => {
    if (isLast) onComplete();
    else setPage(p => Math.min(p + 1, PAGES.length - 1));
  };

  const handleSkip = () => onComplete();

  if (stage === "splash") {
    return (
      <div className="phantom-onboarding" data-pm-redesign="1" role="dialog" aria-label="Phantom Messenger">
        <div className="auth-card">
          <div className="pm-auth-flow">
            <div className="pm-splash">
              <div className="pm-splash-logo-wrap">
                <div className="pm-splash-ring" aria-hidden="true" />
                <div className="pm-splash-ring delay" aria-hidden="true" />
                <div className="pm-splash-logo">{"👻"}</div>
              </div>
              <h1 className="pm-splash-title">{t("splash.title")}</h1>
              <div className="pm-splash-tag">{t("splash.tag")}</div>
              <div className="pm-splash-dots">
                <span className="pm-splash-dot" />
                <span className="pm-splash-dot" />
                <span className="pm-splash-dot" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const cur = PAGES[page];
  return (
    <div className="phantom-onboarding" data-pm-redesign="1" role="dialog" aria-label={t("splash.title")}>
      <div className="auth-card">
        <div className="pm-auth-flow">
          <div className="pm-onboard">
            <div className="pm-onboard-progress" role="tablist">
              {PAGES.map((_, idx) => (
                <button
                  key={idx}
                  type="button"
                  role="tab"
                  aria-selected={idx === page}
                  className={`pm-onboard-progress-bar ${idx <= page ? "active" : ""}`}
                  onClick={() => setPage(idx)}
                />
              ))}
            </div>

            <div className={`pm-onboard-icon ${cur.isMonoEmoji ? "mono" : ""}`}>{cur.emoji}</div>

            <h2 className="pm-onboard-title">{t(cur.titleKey)}</h2>
            <p className="pm-onboard-body">{t(cur.bodyKey)}</p>
            <span className="pm-onboard-chip">{t(cur.chipKey)}</span>

            <div className="pm-onboard-spacer" />

            <div className="pm-onboard-footer">
              <button type="button" className="pm-onboard-skip" onClick={handleSkip}>
                {isLast ? "" : t("onb.skip")}
              </button>
              <button type="button" className="pm-onboard-cta spring-press" onClick={handleNext}>
                <span>{isLast ? t("onb.start") : t("onb.next")}</span>
                <ArrowRight size={16} strokeWidth={2.4} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
