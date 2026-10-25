#!/usr/bin/env node
// Мультиаккаунт web: чистая логика src/lib/accounts.ts (список/активный, лимит 3, дедуп,
// выбор следующего активного, тайник токенов для перезагрузки).
// Запуск: node scripts/test-accounts.mjs или npm run test:accounts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, "..");

async function importTs(rel) {
  const src = readFileSync(resolve(clientDir, rel), "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: rel,
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(out).toString("base64"));
}

const A = await importTs("src/lib/accounts.ts");

let failed = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const N1 = "1110000601", N2 = "1110000602", N3 = "1110000603", N4 = "1110000604";

// ── добавление ──
let s = A.emptyAccounts();
check("пустое состояние: нет номеров и активного", same(s, { numbers: [], active: "" }));
let r = A.addAccount(s, N1);
check("добавление: номер в списке и активный", r.result === "ok" && same(r.state, { numbers: [N1], active: N1 }));
s = r.state;
r = A.addAccount(s, N2);
check("второй аккаунт становится активным, порядок сохранён", r.result === "ok" && same(r.state, { numbers: [N1, N2], active: N2 }));
s = r.state;
r = A.addAccount(s, N1);
check("дубль отклонён, состояние не меняется", r.result === "duplicate" && r.state === s);
r = A.addAccount(s, "abc");
check("некорректный номер отклонён", r.result !== "ok" && r.state === s);
r = A.addAccount(s, N3);
check("третий аккаунт добавлен", r.result === "ok" && r.state.numbers.length === 3);
s = r.state;
check("canAddAccount: на 3 — нельзя", A.canAddAccount(s) === false);
check("canAddAccount: на 2 — можно", A.canAddAccount({ numbers: [N1, N2], active: N1 }) === true);
r = A.addAccount(s, N4);
check("лимит 3: четвёртый отклонён", r.result === "limit" && r.state === s);
check("MAX_ACCOUNTS = 3", A.MAX_ACCOUNTS === 3);

// ── переключение ──
let t = A.switchAccount(s, N1);
check("переключение на добавленный номер", t.active === N1 && same(t.numbers, s.numbers));
check("переключение на неизвестный — без изменений", A.switchAccount(s, N4) === s);
check("переключение на активный — без изменений", A.switchAccount(t, N1) === t);

// ── удаление ──
t = A.removeAccount({ numbers: [N1, N2, N3], active: N2 }, N2);
check("удаление активного из середины: следующий справа", same(t, { numbers: [N1, N3], active: N3 }));
t = A.removeAccount({ numbers: [N1, N2, N3], active: N3 }, N3);
check("удаление активного последнего: сосед слева", same(t, { numbers: [N1, N2], active: N2 }));
t = A.removeAccount({ numbers: [N1, N2, N3], active: N1 }, N1);
check("удаление активного первого: следующий справа", same(t, { numbers: [N2, N3], active: N2 }));
t = A.removeAccount({ numbers: [N1, N2, N3], active: N1 }, N3);
check("удаление неактивного: активный не меняется", same(t, { numbers: [N1, N2], active: N1 }));
t = A.removeAccount({ numbers: [N1], active: N1 }, N1);
check("удаление единственного: пусто", same(t, { numbers: [], active: "" }));
s = { numbers: [N1], active: N1 };
check("удаление неизвестного — без изменений", A.removeAccount(s, N2) === s);
check("nextActiveAfterRemoval: середина", A.nextActiveAfterRemoval([N1, N2, N3], N2) === N3);
check("nextActiveAfterRemoval: последний", A.nextActiveAfterRemoval([N1, N2, N3], N3) === N2);
check("nextActiveAfterRemoval: единственный", A.nextActiveAfterRemoval([N1], N1) === "");
check("после удаления можно добавить снова (лимит освободился)",
  A.addAccount(A.removeAccount({ numbers: [N1, N2, N3], active: N1 }, N2), N4).result === "ok");

// ── тайник ──
const tokens = { [N1]: "tok.one", [N2]: "tok.two", [N3]: "tok.three" };
const raw = A.serializeStash({ numbers: [N1, N2, N3], active: N2 }, tokens);
check("тайник: JSON {active, tokens}", same(JSON.parse(raw), { active: N2, tokens }));
const back = A.parseStash(raw);
check("тайник: круговое преобразование", back && back.active === N2 && same(back.tokens, tokens));
check("тайник: без токенов — пустая строка", A.serializeStash({ numbers: [N1], active: N1 }, {}) === "");
check("тайник: аккаунт без токена не попадает", same(JSON.parse(A.serializeStash({ numbers: [N1, N2], active: N1 }, { [N1]: "x" })).tokens, { [N1]: "x" }));
check("тайник: активный без токена → первый с токеном", JSON.parse(A.serializeStash({ numbers: [N1, N2], active: N2 }, { [N1]: "x" })).active === N1);
check("parseStash: пустая строка → null", A.parseStash("") === null);
check("parseStash: мусор → null", A.parseStash("not json") === null);
check("parseStash: голый токен (не JSON) → null", A.parseStash("eyJhbGciOi.payload.sig") === null);
check("parseStash: чужие типы → null", A.parseStash(JSON.stringify({ active: 1, tokens: [1, 2] })) === null);
check("parseStash: нечисловые номера отбрасываются", A.parseStash(JSON.stringify({ active: "x", tokens: { x: "t" } })) === null);
check("parseStash: пустой токен отбрасывается", A.parseStash(JSON.stringify({ active: N1, tokens: { [N1]: "" } })) === null);
const many = A.parseStash(JSON.stringify({ active: N1, tokens: { [N1]: "a", [N2]: "b", [N3]: "c", [N4]: "d" } }));
check("parseStash: не больше 3 аккаунтов", many && Object.keys(many.tokens).length === 3);
const bad = A.parseStash(JSON.stringify({ active: N4, tokens: { [N1]: "a" } }));
check("parseStash: активный не из карты → первый", bad && bad.active === N1);

// ── список номеров и восстановление ──
check("parseAccountList: корректный JSON", same(A.parseAccountList(JSON.stringify([N2, N1])), [N2, N1]));
check("parseAccountList: мусор и дубли отброшены", same(A.parseAccountList(JSON.stringify([N1, N1, "x", 5, N2])), [N1, N2]));
check("parseAccountList: не JSON → []", same(A.parseAccountList("{"), []));
check("parseAccountList: null → []", same(A.parseAccountList(null), []));
let rs = A.restoreAccounts(back, [N3, N1, N2]);
check("restoreAccounts: порядок из сохранённого списка, активный из тайника", same(rs, { numbers: [N3, N1, N2], active: N2 }));
rs = A.restoreAccounts(back, [N1]);
check("restoreAccounts: недостающие номера тайника добавляются в конец", same(rs, { numbers: [N1, N2, N3], active: N2 }));
rs = A.restoreAccounts(A.parseStash(JSON.stringify({ active: N1, tokens: { [N1]: "a" } })), [N1, N2, N3]);
check("restoreAccounts: номера без токена отбрасываются", same(rs, { numbers: [N1], active: N1 }));
check("restoreAccounts: нет тайника → пусто (закрытие вкладки = выход)", same(A.restoreAccounts(null, [N1, N2]), { numbers: [], active: "" }));

// ── совместимость с выложенной 6a: голый JWT в phantom_token + phantom_number ──
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLV8";
const lg = A.parseLegacyStash(jwt, N1);
check("legacy: JWT + номер → {active, tokens}", lg && lg.active === N1 && same(lg.tokens, { [N1]: jwt }));
check("legacy: без номера → null", A.parseLegacyStash(jwt, "") === null && A.parseLegacyStash(jwt, null) === null);
check("legacy: некорректный номер → null", A.parseLegacyStash(jwt, "12345") === null);
check("legacy: не JWT → null", A.parseLegacyStash("not a jwt", N1) === null && A.parseLegacyStash("a.b", N1) === null);
check("legacy: JSON нового формата не принимается как JWT", A.parseLegacyStash(JSON.stringify({ active: N1, tokens: { [N1]: "x" } }), N1) === null);
check("legacy: пустой токен → null", A.parseLegacyStash("", N1) === null && A.parseLegacyStash(null, N1) === null);
check("legacy → restoreAccounts даёт один активный аккаунт", same(A.restoreAccounts(lg, [N1]), { numbers: [N1], active: N1 }));

// ── nonce тайника ──
const nb = A.nonceFromBytes(Uint8Array.from({ length: 24 }, (_, i) => 250 - i * 3));
check("nonce: base64url без = + /", /^[A-Za-z0-9_-]+$/.test(nb) && nb.length === 32, nb);
check("nonce: валиден для isStashNonce", A.isStashNonce(nb));
check("nonce: 16–64 символа", A.isStashNonce("a".repeat(16)) && A.isStashNonce("a".repeat(64)) && !A.isStashNonce("a".repeat(15)) && !A.isStashNonce("a".repeat(65)));
check("nonce: недопустимые символы и типы отброшены", !A.isStashNonce("a".repeat(15) + "=") && !A.isStashNonce("a".repeat(15) + "/") && !A.isStashNonce(123) && !A.isStashNonce(null) && !A.isStashNonce(""));
check("nonce: разные байты — разные значения", A.nonceFromBytes(new Uint8Array(24).fill(1)) !== A.nonceFromBytes(new Uint8Array(24).fill(2)));

// ── тип навигации (внедряется снаружи) ──
check("nav: reload → true", A.isReloadNavType({ type: "reload" }) === true);
check("nav: navigate → false", A.isReloadNavType({ type: "navigate" }) === false);
check("nav: back_forward → false", A.isReloadNavType({ type: "back_forward" }) === false);
check("nav: prerender → false", A.isReloadNavType({ type: "prerender" }) === false);
check("nav: нет записи, legacy 1 (reload) → true", A.isReloadNavType(undefined, 1) === true && A.isReloadNavType(null, 1) === true);
check("nav: нет записи, legacy 0/2 → false", A.isReloadNavType(undefined, 0) === false && A.isReloadNavType(undefined, 2) === false);
check("nav: нет данных → false", A.isReloadNavType(undefined) === false);
check("nav: запись с типом не строкой не маскирует legacy", A.isReloadNavType({ type: 1 }, 1) === true);

// ── срок токена: TTL (exp − iat) и монотонное время с получения, не часы устройства ──
const b64u = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const mkJwt = (iat, exp) => `${b64u({ alg: "HS256" })}.${b64u({ sub: "x", iat, exp })}.c2ln`;
check("jwtTtlSeconds: exp − iat", A.jwtTtlSeconds(mkJwt(1000, 8200)) === 7200);
check("jwtTtlSeconds: мусор/нет полей → null", A.jwtTtlSeconds("abc") === null && A.jwtTtlSeconds("a.b.c") === null && A.jwtTtlSeconds(`${b64u({})}.${b64u({ sub: "x" })}.c2ln`) === null && A.jwtTtlSeconds(mkJwt(10, 5)) === null);
check("isTtlElapsed: до TTL — годен", A.isTtlElapsed(7200, 3600 * 1000) === false);
check("isTtlElapsed: после TTL — истёк", A.isTtlElapsed(7200, 7300 * 1000) === true);
check("isTtlElapsed: запас 5 с на границе", A.isTtlElapsed(7200, 7195 * 1000) === true && A.isTtlElapsed(7200, 7190 * 1000) === false);
check("isTtlElapsed: срок неизвестен — не истёк (часы устройства не используются)", A.isTtlElapsed(null, 1e12) === false);

console.log(failed === 0 ? "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" : `\nПРОВАЛЕНО: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
