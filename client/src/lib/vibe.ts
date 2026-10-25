/* Phantom Vibe — реальный акцент-цвет, применяется к <html> через
   data-vibe атрибут. Меняет --pm-grad и связанные тени. */

export type Vibe = "noir" | "dream" | "retro" | "disco" | "wave";

const VIBES: ReadonlyArray<Vibe> = ["noir", "dream", "retro", "disco", "wave"];

function isVibe(v: string | null): v is Vibe {
  return !!v && (VIBES as ReadonlyArray<string>).includes(v);
}

/** Достаёт сохранённый vibe текущего аккаунта, либо последний из любого. */
export function getStoredVibe(account?: string): Vibe {
  if (typeof localStorage === "undefined") return "noir";
  try {
    if (account) {
      const v = localStorage.getItem(`phantom_${account}_vibe`);
      if (isVibe(v)) return v;
    }
    // fallback — берём первый найденный phantom_<num>_vibe
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith("phantom_") && key.endsWith("_vibe")) {
        const v = localStorage.getItem(key);
        if (isVibe(v)) return v;
      }
    }
    const generic = localStorage.getItem("phantom_vibe");
    if (isVibe(generic)) return generic;
  } catch { /* ignore */ }
  return "noir";
}

/** Прокидывает data-vibe на <html>, чтобы CSS-переменные применились. */
export function applyVibe(v: Vibe | string): void {
  if (typeof document === "undefined") return;
  const safe: Vibe = isVibe(v as string) ? (v as Vibe) : "noir";
  document.documentElement.setAttribute("data-vibe", safe);
}
