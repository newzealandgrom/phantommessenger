#!/usr/bin/env node
// H2: строгая проверка /operator.json (lib/operatorInfo.ts) и подстановка данных оператора
// в юридические тексты (lib/legalContent.ts). Запуск: node scripts/test-operator.mjs или npm run test:operator.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, "..");

async function bundle(rel) {
  const out = await build({
    entryPoints: [resolve(clientDir, rel)], bundle: true, write: false, format: "esm", platform: "node",
  });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

const O = await bundle("src/lib/operatorInfo.ts");
const L = await bundle("src/lib/legalContent.ts");

let failed = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}

const good = {
  version: 1, name: "Acme Chat", siteUrl: "https://acme.example/", contactEmail: "ops@acme.example",
  termsUrl: "https://acme.example/legal/terms", privacyUrl: "https://acme.example/legal/privacy", securityReport: false,
};
const p = (o) => O.parseOperatorInfo(o);

// ── Схема
const ok = p(good);
check("корректный файл принят", ok !== null && ok.name === "Acme Chat");
check("хвостовой / siteUrl убран", ok?.siteUrl === "https://acme.example");
check("termsUrl/privacyUrl сохранены", ok?.termsUrl === "https://acme.example/legal/terms" && ok?.privacyUrl === "https://acme.example/legal/privacy");
check("без termsUrl/privacyUrl → null", (() => { const r = p({ ...good, termsUrl: undefined, privacyUrl: undefined }); return r && r.termsUrl === null && r.privacyUrl === null; })());
check("securityReport по умолчанию false", p({ ...good, securityReport: undefined })?.securityReport === false);
check("securityReport строкой не принимается как true", p({ ...good, securityReport: "true" })?.securityReport === false);
check("version отсутствует — допустимо", p({ ...good, version: undefined }) !== null);
check("version 2 отклонён", p({ ...good, version: 2 }) === null);

// ── Отклонения
const bad = (label, o) => check(`отклонено: ${label}`, p(o) === null);
bad("не объект (null)", null);
bad("массив", []);
bad("строка", "x");
bad("нет name", { ...good, name: undefined });
bad("name пустой", { ...good, name: "  " });
bad("name > 200", { ...good, name: "a".repeat(201) });
bad("name с разметкой [x](y)", { ...good, name: "[x](https://evil.example)" });
bad("name со звёздочкой", { ...good, name: "**x**" });
bad("name с управляющим символом", { ...good, name: "a\nb" });
bad("name числом", { ...good, name: 5 });
bad("siteUrl http:", { ...good, siteUrl: "http://acme.example" });
bad("siteUrl javascript:", { ...good, siteUrl: "javascript:alert(1)" });
bad("siteUrl data:", { ...good, siteUrl: "data:text/html,x" });
bad("siteUrl с userinfo", { ...good, siteUrl: "https://a@acme.example" });
bad("siteUrl с пробелом", { ...good, siteUrl: "https://acme.example/a b" });
bad("siteUrl со скобкой", { ...good, siteUrl: "https://acme.example/a)b" });
bad("siteUrl > 200", { ...good, siteUrl: "https://acme.example/" + "a".repeat(200) });
bad("siteUrl protocol-relative", { ...good, siteUrl: "//acme.example" });
bad("termsUrl http:", { ...good, termsUrl: "http://acme.example/t" });
bad("privacyUrl javascript:", { ...good, privacyUrl: "javascript:1" });
bad("email без @", { ...good, contactEmail: "acme.example" });
bad("email с пробелом", { ...good, contactEmail: "a b@acme.example" });
bad("email со скобкой", { ...good, contactEmail: "a(b)@acme.example" });
bad("email > 200", { ...good, contactEmail: "a@" + "b".repeat(200) + ".com" });
bad("email без TLD", { ...good, contactEmail: "a@localhost" });
// ── C-1: Unicode по категориям (Cf/Co/Cs/Zl/Zp) в любом текстовом поле
for (const [label, ch] of [["ZWSP U+200B", "\u200b"], ["RLO U+202E", "\u202e"], ["LRI U+2066", "\u2066"], ["WJ U+2060", "\u2060"],
  ["ALM U+061C", "\u061c"], ["BOM U+FEFF", "\ufeff"], ["ZWJ U+200D", "\u200d"], ["private-use U+E000", "\ue000"],
  ["одиночный суррогат", "\ud800"], ["U+2028", "\u2028"], ["C1 U+0085", "\u0085"]]) {
  bad(`name с ${label}`, { ...good, name: `Acme${ch}Chat` });
}
bad("email с ZWSP", { ...good, contactEmail: "ops@acme\u200b.example" });
bad("siteUrl с RLO в хосте", { ...good, siteUrl: "https://acme\u202e.example" });
bad("termsUrl с ZWSP", { ...good, termsUrl: "https://acme.example/\u200bt" });
check("эмодзи (пара суррогатов) и кириллица в имени допустимы", p({ ...good, name: "Фантом 😀" })?.name === "Фантом 😀");

// ── C-2: размер тела до полной загрузки
const mk = (chunks, headers = {}) => {
  let i = 0, pulled = 0;
  const stream = new ReadableStream({
    pull(c) { if (i < chunks.length) { pulled++; c.enqueue(chunks[i++]); } else c.close(); },
  });
  return { resp: new Response(stream, { headers }), pulled: () => pulled };
};
const enc = new TextEncoder();
const okBody = enc.encode(JSON.stringify(good));
{
  const { resp } = mk([okBody]);
  check("тело в пределах — прочитано", (await O.readBodyLimited(resp, 4096)) === JSON.stringify(good));
}
{
  const { resp, pulled } = mk(Array.from({ length: 200 }, () => new Uint8Array(1024)));
  const r = await O.readBodyLimited(resp, 4096);
  check("100+ КБ без Content-Length: отказ", r === null);
  check("…с обрывом чтения (прочитано < 10 кусков из 200)", pulled() < 10);
}
{
  const { resp, pulled } = mk([new Uint8Array(1024)], { "content-length": "102400" });
  check("Content-Length 100 КБ: отказ без чтения тела", (await O.readBodyLimited(resp, 4096)) === null && pulled() === 0);
}
{
  const { resp } = mk([okBody], { "content-length": "abc" });
  check("Content-Length не число: отказ", (await O.readBodyLimited(resp, 4096)) === null);
}
{
  const { resp } = mk([new Uint8Array([0xff, 0xfe])]);
  check("невалидный UTF-8: отказ", (await O.readBodyLimited(resp, 4096)) === null);
}
check("кириллица считается в байтах (> 4096 Б при < 4096 символов)", O.parseOperatorBody(JSON.stringify({ ...good, pad: "я".repeat(2100) })) === null);
check("тело > 4 КиБ отклонено", O.parseOperatorBody(JSON.stringify({ ...good, pad: "x".repeat(5000) })) === null);
check("тело не JSON отклонено", O.parseOperatorBody("<!doctype html>") === null);
check("тело JSON принято", O.parseOperatorBody(JSON.stringify(good)) !== null);

// ── Подстановка в тексты
const def = O.DEFAULT_OPERATOR;
const allText = (d) => [d.lead, ...d.sections.flatMap((s) => [...(s.p ?? []), ...(s.ul ?? [])])].join("\n");
const defTerms = L.getLegalDoc("terms", "ru", def);
check("дефолт: контакт проекта", allText(defTerms).includes("[admin@phantommessenger.org](mailto:admin@phantommessenger.org)"));
check("дефолт: нет пометки об операторе", !allText(defTerms).includes("независимым оператором"));
check("дефолт: есть сводка аудита", allText(defTerms).includes("/SECURITY_AUDIT.md"));
check("дефолт: нет остатков {{", !/\{\{/.test(allText(defTerms)) && !/\{\{/.test(allText(L.getLegalDoc("privacy", "en", def))));
for (const kind of ["terms", "privacy"]) {
  for (const loc of ["ru", "en"]) {
    const d = L.getLegalDoc(kind, loc, ok);
    const t = allText(d);
    check(`${kind}/${loc}: контакт оператора`, t.includes("[ops@acme.example](mailto:ops@acme.example)") || kind === "privacy" && t.includes("ops@acme.example"));
    check(`${kind}/${loc}: наш e-mail исчез`, !t.includes("admin@phantommessenger.org"));
    check(`${kind}/${loc}: нет ссылки на аудит`, !t.includes("SECURITY_AUDIT"));
    check(`${kind}/${loc}: нет остатков {{`, !/\{\{/.test(t));
    check(`${kind}/${loc}: пустых абзацев нет`, d.sections.every((s) => (s.p ?? []).every((x) => x.trim()) && (s.ul ?? []).every((x) => x.trim())));
  }
}
check("terms/ru: имя и сайт оператора", (() => { const t = allText(L.getLegalDoc("terms", "ru", ok)); return t.includes("Acme Chat") && t.includes("[acme.example](https://acme.example)"); })());
check("terms/en: lead с хостом сайта", L.getLegalDoc("terms", "en", ok).lead.includes("at acme.example "));
check("privacy/ru: примечание об инфраструктуре", allText(L.getLegalDoc("privacy", "ru", ok)).includes("у оператора этого сервера"));
check("securityReport true у чужого → ссылка на аудит остаётся", allText(L.getLegalDoc("terms", "en", { ...ok, securityReport: true })).includes("/SECURITY_AUDIT.md"));
check("подстановка однопроходная ($& и {{ в имени не раскрываются)", (() => {
  const t = L.fillLegalText("{{operator}} / {{email}}", { ...ok, name: "A $& {{email}}" });
  return t === "A $& {{email}} / ops@acme.example";
})());

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
