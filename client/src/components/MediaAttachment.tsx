import { useEffect, useMemo, useState } from "react";

/**
 * Встроенное воспроизведение аудио/видео-вложений.
 *
 * `fileData` у вложения — data: URL. CSP relay разрешает `media-src 'self' blob:`,
 * data: для <audio>/<video> запрещён, поэтому байты переливаются в Blob и
 * отдаются через object URL (как в VoicePlayer); URL отзывается при размонтировании.
 * P2P v2 (files_v1): `src` — уже готовый blob: URL (`ChatMessage.fileUrl`); им владеет App
 * (отзывает при удалении сообщения/logout), здесь он только показывается.
 * Расшифрованные байты остаются только в RAM вкладки.
 */
export function dataUrlToBlob(dataUrl: string, fallbackMime: string): Blob | null {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) return null;
  const header = dataUrl.slice(5, comma);
  const isB64 = /;base64$/i.test(header);
  const mime = header.replace(/;base64$/i, "") || fallbackMime;
  try {
    const raw = dataUrl.slice(comma + 1);
    if (isB64) {
      const bin = atob(raw);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(raw)], { type: mime });
  } catch {
    return null;
  }
}

export default function MediaAttachment({ dataUrl, src, mimeType, fileName }: { dataUrl?: string; src?: string; mimeType: string; fileName?: string }) {
  const [url, setUrl] = useState<string>("");
  const isVideo = mimeType.startsWith("video/");
  const blob = useMemo(() => (src || !dataUrl ? null : dataUrlToBlob(dataUrl, mimeType)), [src, dataUrl, mimeType]);

  useEffect(() => {
    if (src) { setUrl(src); return; }
    if (!blob) { setUrl(""); return; }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => { URL.revokeObjectURL(u); };
  }, [blob, src]);

  if (!url) return null;
  return isVideo ? (
    <video
      src={url}
      controls
      playsInline
      preload="metadata"
      className="tg-msg-media-video"
      aria-label={fileName || "video"}
      style={{ maxWidth: "100%", maxHeight: 320, borderRadius: 10, display: "block", background: "#000" }}
    />
  ) : (
    <audio
      src={url}
      controls
      preload="metadata"
      className="tg-msg-media-audio"
      aria-label={fileName || "audio"}
      style={{ width: "100%", minWidth: 220, display: "block" }}
    />
  );
}

/** Эмодзи-иконка по MIME для пузыря файла. */
export function fileKindIcon(mime: string | undefined, name: string | undefined): string {
  const m = (mime || "").toLowerCase();
  const ext = (name || "").toLowerCase().split(".").pop() || "";
  if (m === "application/pdf" || ext === "pdf") return "📕";
  if (m.startsWith("audio/")) return "🎵";
  if (m.startsWith("video/")) return "🎬";
  if (m.startsWith("image/")) return "🖼";
  if (/zip|rar|7z|tar|gzip|x-compressed/.test(m) || ["zip", "rar", "7z", "gz", "tgz"].includes(ext)) return "🗜";
  if (m.startsWith("text/") || /json|xml|csv/.test(m) || ["txt", "md", "json", "csv", "log"].includes(ext)) return "📝";
  if (/msword|officedocument|opendocument|rtf/.test(m) || ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "rtf"].includes(ext)) return "📄";
  return "📎";
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
