import brandSpec from "../shared/phantom-brand.json";

type ResolvedTheme = "dark" | "light";
type CssColorToken =
  | "void"
  | "glass"
  | "glassMid"
  | "glassStrong"
  | "glassHover"
  | "glassSubtle"
  | "text1"
  | "text2"
  | "text3"
  | "accent"
  | "accent2"
  | "accentDim"
  | "green"
  | "danger"
  | "border"
  | "overlay"
  | "readColor"
  | "bubbleIn"
  | "bubbleInBorder"
  | "bubbleOutStart"
  | "bubbleOutEnd"
  | "bubbleOutBorder";

const colorVarMap: Record<CssColorToken, string> = {
  void: "--void",
  glass: "--glass",
  glassMid: "--glass-mid",
  glassStrong: "--glass-strong",
  glassHover: "--glass-hover",
  glassSubtle: "--glass-subtle",
  text1: "--text-1",
  text2: "--text-2",
  text3: "--text-3",
  accent: "--accent",
  accent2: "--accent-2",
  accentDim: "--accent-dim",
  green: "--green",
  danger: "--danger",
  border: "--border",
  overlay: "--overlay",
  readColor: "--read-color",
  bubbleIn: "--bubble-in-bg",
  bubbleInBorder: "--bubble-in-border",
  bubbleOutStart: "--bubble-out-start",
  bubbleOutEnd: "--bubble-out-end",
  bubbleOutBorder: "--bubble-out-border",
};

export const BRAND = brandSpec;

export function applyBrandTheme(theme: ResolvedTheme) {
  const root = document.documentElement;
  const palette = BRAND.palette[theme];

  (Object.keys(colorVarMap) as CssColorToken[]).forEach(token => {
    root.style.setProperty(colorVarMap[token], palette[token]);
  });

  root.style.setProperty("--bubble-out-bg", `linear-gradient(135deg, ${palette.bubbleOutStart}, ${palette.bubbleOutEnd})`);
  root.style.setProperty("--bg-0", "var(--void)");
  root.style.setProperty("--bg-1", "var(--glass)");
  root.style.setProperty("--bg-2", "var(--glass-subtle)");
  root.style.setProperty("--bg-3", "var(--glass-hover)");
  root.style.setProperty("--bg-4", theme === "light" ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.08)");
  root.style.setProperty("--sidebar-bg", "var(--glass-mid)");
  root.style.setProperty("--bubble-out-solid", "var(--accent)");

  root.style.setProperty("--font-body", `'${BRAND.typography.bodyFamily}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`);
  root.style.setProperty("--font-display", `'${BRAND.typography.displayFamily}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`);
  root.style.setProperty("--font-mono", `'${BRAND.typography.monoFamily}', 'Fira Code', ui-monospace, monospace`);

  root.style.setProperty("--motion-fast", `${BRAND.motion.fastMs}ms`);
  root.style.setProperty("--motion-base", `${BRAND.motion.baseMs}ms`);
  root.style.setProperty("--motion-slow", `${BRAND.motion.slowMs}ms`);
  root.style.setProperty("--motion-card-enter", `${BRAND.motion.cardEnterMs}ms`);

  root.style.setProperty("--r-xs", `${BRAND.radii.xs}px`);
  root.style.setProperty("--r-sm", `${BRAND.radii.sm}px`);
  root.style.setProperty("--r-md", `${BRAND.radii.md}px`);
  root.style.setProperty("--r-lg", `${BRAND.radii.lg}px`);
  root.style.setProperty("--r-full", `${BRAND.radii.full}px`);
}
