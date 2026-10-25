export function normalizeNumber(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 10) {
    return null;
  }
  if (!digits.startsWith("111")) {
    return null;
  }
  return digits;
}

export function formatNumber(value: string): string {
  const normalized = normalizeNumber(value);
  if (!normalized) {
    return value;
  }
  return `${normalized.slice(0, 3)}-${normalized.slice(3, 5)}-${normalized.slice(5, 8)}-${normalized.slice(8, 10)}`;
}

export function formatInput(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 10);
  let result = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i === 3 || i === 5 || i === 8) {
      result += "-";
    }
    result += digits[i];
  }
  return result;
}
