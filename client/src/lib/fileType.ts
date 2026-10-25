/**
 * Magic-byte sniffing for user-selected files.
 *
 * The browser's `File.type` is derived from the extension and is trivially
 * forgeable: an attacker who renames `malware.exe` to `cute.png` gets
 * `image/png` back. The server should always be the source of truth, but
 * the client can at least flag a mismatch before uploading — fewer hostile
 * payloads will be dispatched through the relay.
 */

export type SniffResult = {
  /** true when the magic bytes match at least one known image signature. */
  isImage: boolean;
  /** Canonical media type derived from the magic bytes, or "" on unknown. */
  detectedMime: string;
  /** true when `File.type` disagrees with what the magic bytes say. */
  mismatch: boolean;
};

async function readFirstBytes(file: File, n: number): Promise<Uint8Array> {
  const slice = file.slice(0, n);
  const buf = await slice.arrayBuffer();
  return new Uint8Array(buf);
}

export async function sniffFile(file: File): Promise<SniffResult> {
  let bytes: Uint8Array;
  try {
    bytes = await readFirstBytes(file, 16);
  } catch {
    return { isImage: false, detectedMime: "", mismatch: false };
  }
  const declared = (file.type || "").toLowerCase();
  const detectedMime = detectMime(bytes);
  const isImage = detectedMime.startsWith("image/");
  let mismatch = false;
  if (declared && detectedMime && declared !== detectedMime) {
    // jpeg / jpg aliases are equivalent
    const norm = (m: string) => (m === "image/jpg" ? "image/jpeg" : m);
    mismatch = norm(declared) !== norm(detectedMime);
  }
  return { isImage, detectedMime, mismatch };
}

function detectMime(b: Uint8Array): string {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38
    && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return "application/zip";
  return "";
}
