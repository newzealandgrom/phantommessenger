import { useEffect, useState } from "react";
import { slog } from "../lib/log";

/**
 * QR-код как SVG-картинка (data: URL), без <canvas>.
 *
 * Раньше QR рисовался через `QRCode.toCanvas` по `setTimeout(50)` после клика.
 * В Firefox с включённой защитой canvas (fingerprinting protection, CanvasBlocker,
 * аппаратный canvas) и при повторном открытии панели (canvas монтировался заново,
 * а перерисовка не вызывалась) пользователь видел белый квадрат без картинки.
 * SVG-строку генерирует та же библиотека `qrcode` (`toString`, type "svg") — это
 * чистая математика без canvas, а показ идёт через <img src="data:image/svg+xml">
 * (разрешено CSP `img-src data:`). Генерация привязана к монтированию и к `text`.
 *
 * `qrcode` — CommonJS-пакет: при dynamic import API лежит в `.default`.
 */
export default function QrImage({ text, size = 200, label }: { text: string; size?: number; label?: string }) {
  const [src, setSrc] = useState<string>("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc("");
    setFailed(false);
    if (!text) return;
    import("qrcode").then(mod => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const QRCode: any = (mod as any).default ?? mod;
      if (typeof QRCode?.toString !== "function") throw new Error("qrcode: toString unavailable");
      return QRCode.toString(text, {
        type: "svg",
        margin: 2,
        width: size,
        errorCorrectionLevel: "M",
        color: { dark: "#000000", light: "#ffffff" },
      }) as Promise<string>;
    }).then((svg: string | undefined) => {
      if (cancelled || !svg) return;
      setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    }).catch(err => {
      slog.warn("qr: generation failed", err);
      if (!cancelled) setFailed(true);
    });
    return () => { cancelled = true; };
  }, [text, size]);

  if (failed) {
    return (
      <div
        role="img"
        aria-label={label || "QR"}
        style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", color: "#0a0a0a", fontSize: 12, textAlign: "center", padding: 12, boxSizing: "border-box" }}
      >
        {"QR недоступен"}
      </div>
    );
  }
  return (
    <img
      src={src || undefined}
      width={size}
      height={size}
      alt={label || "QR"}
      draggable={false}
      style={{ display: "block", width: size, height: size, imageRendering: "pixelated", background: "#fff" }}
    />
  );
}
