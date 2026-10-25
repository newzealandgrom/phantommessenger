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
