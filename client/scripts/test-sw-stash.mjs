#!/usr/bin/env node
// Тайник токенов в RAM Service Worker (public/sw.js): карта nonce → {payload, at}, кап 8, TTL 30 с,
// take/drop только по своему nonce. Блок между маркерами извлекается из sw.js и исполняется в vm
// (без браузера), время подменяется. Запуск: node scripts/test-sw-stash.mjs или npm run test:sw-stash.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../public/sw.js"), "utf8");
const a = src.indexOf("// ─── Тайник токенов");
const b = src.indexOf("// ─── Origin enforcement");
if (a < 0 || b < 0 || b < a) { console.log("FAIL  не найден блок тайника в sw.js"); process.exit(1); }
const block = src.slice(a, b);

let now = 1_000_000;
const timers = [];
const ctx = vm.createContext({
  Date: { now: () => now },
  Object,
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  clearTimeout: () => {},
});
vm.runInContext(block + "\nthis.api = { put: _stashPut, take: _stashTake, drop: _stashDrop, clear: _stashClear, size: () => Object.keys(_stash).length, has: n => n in _stash };", ctx);
const S = ctx.api;

let failed = 0;
function check(label, ok) { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; }
const n = i => String(i).padStart(2, "0").repeat(8); // 16 символов

S.put(n(1), "p1");
check("put/take: отдаёт payload", S.take(n(1)) === "p1");
check("take одноразовый", S.take(n(1)) === null);
S.put(n(1), "p1"); S.put(n(2), "p2");
check("две вкладки не перетирают друг друга", S.take(n(2)) === "p2" && S.take(n(1)) === "p1");
S.put(n(1), "p1");
check("take чужим nonce → null, запись жива", S.take(n(9)) === null && S.has(n(1)));
S.drop(n(9));
check("drop чужим nonce ничего не стирает", S.has(n(1)));
S.drop(undefined); S.drop(null); S.drop("");
check("drop без nonce ничего не стирает", S.has(n(1)));
S.drop(n(1));
check("drop своим nonce стирает", !S.has(n(1)) && S.take(n(1)) === null);
now += 31_000;
S.put(n(3), "p3"); now += 29_000;
check("TTL: до 30 с отдаётся", S.take(n(3)) === "p3");
S.put(n(3), "p3"); now += 30_001;
check("TTL: после 30 с → null и запись удалена", S.take(n(3)) === null && !S.has(n(3)));
S.clear();
for (let i = 1; i <= 8; i++) { S.put(n(i), "p" + i); now += 10; }
check("кап: 8 записей помещаются", S.size() === 8);
S.put(n(9), "p9");
check("кап: девятая вытесняет самую старую", S.size() === 8 && !S.has(n(1)) && S.has(n(2)) && S.has(n(9)));
S.put(n(10), "p10");
check("кап: десятая вытесняет следующую", S.size() === 8 && !S.has(n(2)) && S.has(n(3)));
S.put(n(5), "p5-new");
check("повторная запись nonce не раздувает карту и обновляет payload", S.size() === 8 && S.take(n(5)) === "p5-new");
S.clear();
check("clear (wipe/erase) очищает всё", S.size() === 0);
for (let i = 1; i <= 3; i++) S.put(n(i), "p" + i);
now += 31_000; S.put(n(4), "p4");
check("просроченные записи вычищаются при put", S.size() === 1 && S.has(n(4)));
check("прототипные ключи не читаются", S.take("__proto__") === null && S.take("constructor") === null);

// Таймер — на истечение самой старой записи (запись не живёт в RAM до 2×TTL)
S.clear(); timers.length = 0;
S.put(n(1), "p1"); now += 500; S.put(n(2), "p2");
const t1 = timers[timers.length - 1];
check("таймер ставится на истечение самой старой записи", !!t1 && t1.ms === 29_500);
now += t1.ms; t1.fn();
check("через TTL самая старая запись удалена, свежая — нет", !S.has(n(1)) && S.has(n(2)));
const t2 = timers[timers.length - 1];
check("следующий таймер — на истечение оставшейся", t2 !== t1 && t2.ms === 500);
now += t2.ms; t2.fn();
check("вторая запись удалена ровно по TTL", S.size() === 0);

console.log(failed === 0 ? "\nALL PASS" : `\nFAILED: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
