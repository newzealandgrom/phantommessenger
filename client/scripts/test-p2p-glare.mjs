#!/usr/bin/env node
// P2P v2 §3.3: glare «вежливый пир» + «протухший» offer (src/lib/p2pGlare.ts → decideIncomingOffer),
// паритет с Core `P2PManager.handleOffer` (mac/tests/p2p_session_test.swift не покрывает Core — здесь эталон правила).
// Запуск: node scripts/test-p2p-glare.mjs или npm run test:p2p-glare.
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

const G = await importTs("src/lib/p2pGlare.ts");
const d = G.decideIncomingOffer;
const STALE = G.P2P_GLARE_STALE_MS;

let failed = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}

const small = "1114846442", big = "1115587112"; // порядок как у владельца: Mac меньше web
const now = 1_000_000;
check("порог — 3 с", STALE === 3000);
check("нет своего offer → accept", d(small, big, null, now).action === "accept");
check("вежливые (больший номер), свой свежий → accept", d(big, small, { createdAt: now - 10, answered: false }, now).action === "accept");
check("вежливые, свой с answer → accept (как раньше)", d(big, small, { createdAt: now - 10, answered: true }, now).action === "accept");
check("невежливые, свой с answer → ignore", d(small, big, { createdAt: now - 60_000, answered: true }, now).action === "ignore");
const fresh = d(small, big, { createdAt: now - 1000, answered: false }, now);
check("невежливые, свой свежий (1 с) → defer на 2 с", fresh.action === "defer" && fresh.retryInMs === 2000);
check("невежливые, свой 3 с без answer → accept (протух)", d(small, big, { createdAt: now - STALE, answered: false }, now).action === "accept");
check("невежливые, свой 25 с без answer → accept", d(small, big, { createdAt: now - 25_000, answered: false }, now).action === "accept");
// Настоящий glare: невежливый откладывает, answer вежливого приходит раньше повтора → повтор = ignore (один канал).
const first = d(small, big, { createdAt: now, answered: false }, now);
check("настоящий glare: сначала defer", first.action === "defer" && first.retryInMs === STALE);
check("настоящий glare: к повтору answer пришёл → ignore", d(small, big, { createdAt: now, answered: true }, now + first.retryInMs).action === "ignore");
// Отброшенный offer: answer так и не пришёл → на повторе accept.
check("отброшенный offer: на повторе (+3 с) → accept", d(small, big, { createdAt: now, answered: false }, now + first.retryInMs).action === "accept");
check("TTL отложенного offer — 10 с", G.P2P_DEFERRED_OFFER_TTL_MS === 10_000);

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log("\nALL PASS");
