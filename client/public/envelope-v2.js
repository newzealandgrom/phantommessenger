// Phantom Messenger — конверт v2 (S9, documentation/PROTOCOL_V2_SPEC.md, правки P1/P4).
// Чистые функции вывода ключа: без состояния, без доступа к приватным ключам —
// на вход только уже посчитанные ECDH-секреты и публичные raw65-точки.
// Подключается в Service Worker через importScripts('/envelope-v2.js') и в
// Node-тесте (scripts/test-envelope-v2.mjs) через vm. Синтаксис ESM не используется:
// модуль объявляет глобал PhantomEnvelopeV2.
(function(root) {
  'use strict';

  var _subtle = root.crypto && root.crypto.subtle;
  var _enc = new TextEncoder();

  // Склейка байтовых массивов в один свежий ArrayBuffer (subtle не любит вью на чужие буферы).
  function concatBytes(parts) {
    var total = 0;
    for (var i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < parts.length; j++) { out.set(parts[j], off); off += parts[j].length; }
    return out;
  }

  function _asBytes(v, name) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    throw new Error('env2_bad_' + name);
  }

  function _assertRaw65(v, name) {
    var b = _asBytes(v, name);
    if (b.length !== 65 || b[0] !== 0x04) throw new Error('env2_bad_' + name);
    return b;
  }

  // P1: salt = SHA-256(UTF8("phantom-v2-salt")) — 32 байта, константа.
  var _saltPromise = null;
  function salt() {
    if (!_saltPromise) {
      _saltPromise = _subtle.digest('SHA-256', _enc.encode('phantom-v2-salt'))
        .then(function(h) { return new Uint8Array(h); });
    }
    return _saltPromise;
  }

  // P1: info = UTF8("phantom-env:2:" + from + ":" + to) ‖ raw65(id_A) ‖ raw65(id_B) ‖ raw65(eph_A)
  function buildInfo(from, to, idA65, idB65, eph65) {
    return concatBytes([
      _enc.encode('phantom-env:2:' + String(from) + ':' + String(to)),
      _assertRaw65(idA65, 'idA'),
      _assertRaw65(idB65, 'idB'),
      _assertRaw65(eph65, 'eph'),
    ]);
  }

  // P1: AD = UTF8("phantom-env-ad:2:" + from + ":" + to)
  function buildAd(from, to) {
    return _enc.encode('phantom-env-ad:2:' + String(from) + ':' + String(to));
  }

  // RFC 5869 вручную через HMAC-SHA256 — fallback, если subtle не знает HKDF (P4).
  async function _hmac(keyBytes, data) {
    var k = await _subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await _subtle.sign('HMAC', k, data));
  }
  async function hkdfSha256Manual(ikm, saltBytes, info, length) {
    if (length > 255 * 32) throw new Error('env2_hkdf_length');
    var prk = await _hmac(saltBytes, ikm);
    var out = new Uint8Array(length);
    var prev = new Uint8Array(0);
    var off = 0;
    for (var i = 1; off < length; i++) {
      prev = await _hmac(prk, concatBytes([prev, info, new Uint8Array([i])]));
      out.set(prev.subarray(0, Math.min(prev.length, length - off)), off);
      off += prev.length;
    }
    prk.fill(0);
    prev.fill(0);
    return out;
  }

  // HKDF-SHA256: штатный subtle HKDF, при его отсутствии — ручной extract/expand.
  async function hkdfSha256(ikm, saltBytes, info, length) {
    try {
      var base = await _subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
      var bits = await _subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: info }, base, length * 8
      );
      return new Uint8Array(bits);
    } catch (e) {
      // NotSupportedError / TypeError — движок без HKDF; прочие ошибки пробрасываем
      var n = e && e.name;
      if (n !== 'NotSupportedError' && n !== 'TypeError' && n !== 'SyntaxError') throw e;
      return hkdfSha256Manual(ikm, saltBytes, info, length);
    }
  }

  // S9.3: key = HKDF-SHA256(ss1 ‖ ss2, salt, info, 32). Возвращает сырые 32 байта
  // (нужно тест-векторам (в)); в рабочем пути используйте deriveV2Key.
  async function deriveV2KeyBytes(ss1, ss2, from, to, idA65, idB65, eph65) {
    var s1 = _asBytes(ss1, 'ss1');
    var s2 = _asBytes(ss2, 'ss2');
    if (s1.length !== 32 || s2.length !== 32) throw new Error('env2_bad_ss');
    var ikm = concatBytes([s1, s2]);
    var info = buildInfo(from, to, idA65, idB65, eph65);
    try {
      return await hkdfSha256(ikm, await salt(), info, 32);
    } finally {
      ikm.fill(0);
    }
  }

  // То же, но сразу non-extractable AES-256-GCM CryptoKey; сырые байты затираются.
  async function deriveV2Key(ss1, ss2, from, to, idA65, idB65, eph65) {
    var raw = await deriveV2KeyBytes(ss1, ss2, from, to, idA65, idB65, eph65);
    try {
      return await _subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    } finally {
      raw.fill(0);
    }
  }

  root.PhantomEnvelopeV2 = Object.freeze({
    VERSION: 2,
    salt: salt,
    buildInfo: buildInfo,
    buildAd: buildAd,
    hkdfSha256: hkdfSha256,
    hkdfSha256Manual: hkdfSha256Manual,
    deriveV2KeyBytes: deriveV2KeyBytes,
    deriveV2Key: deriveV2Key,
  });
})(typeof self !== 'undefined' ? self : globalThis);
