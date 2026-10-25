// Phantom Messenger Service Worker
// Crypto operations run in this isolated scope, inaccessible to page-level extensions.
// Private keys never leave the SW context.

// SW_VERSION must match EXPECTED_SW_VERSION in cryptoClient.ts. Bump on any
// semantic change to this file so stale cached workers fail healthcheck and
// the main-thread refuses to run until a fresh SW is installed.
var SW_VERSION = 6;

// S9: чистые функции KDF конверта v2 (глобал PhantomEnvelopeV2).
importScripts('/envelope-v2.js');

// ─── Lifecycle ───
self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });

// ─── Crypto: isolated key storage ───
// Ключи устройства по номерам аккаунтов: number → { privateKey: CryptoKey
// (non-extractable, ECDH P-256), publicKey: base64 raw }. Ключ свой у каждого
// номера: иначе вход под другим номером зарегистрировал бы тот же publicKey,
// и relay связал бы номера между собой.
var _keyCache = Object.create(null);

// ─── Crypto: helpers ───
function _toB64(buf) {
  var b = new Uint8Array(buf);
  var s = '';
  for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function _fromB64(b64) {
  var s = atob(b64);
  var buf = new ArrayBuffer(s.length);
  var v = new Uint8Array(buf);
  for (var i = 0; i < s.length; i++) v[i] = s.charCodeAt(i);
  return buf;
}

// ─── Crypto: P-256 curve validation ───
// WebCrypto's importKey accepts off-curve points in some legacy browser
// backends. A bogus peer public key can then leak the private key through
// ECDH (invalid-curve attack). We check the curve equation y^2 = x^3 - 3x + b
// over F_p before ever handing the peer key to subtle.importKey.
var _P256_P  = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
var _P256_B  = BigInt('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b');
var _THREE   = BigInt(3);
function _bytesToBigInt(bytes) {
  var hex = '0x';
  for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return BigInt(hex);
}
function _assertValidP256Point(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error('ecdh_invalid_point_format');
  }
  var x = _bytesToBigInt(raw.subarray(1, 33));
  var y = _bytesToBigInt(raw.subarray(33, 65));
  if (x <= 0n || x >= _P256_P || y <= 0n || y >= _P256_P) {
    throw new Error('ecdh_point_out_of_field');
  }
  var lhs = (y * y) % _P256_P;
  var rhs = (x * x * x - _THREE * x + _P256_B) % _P256_P;
  if (rhs < 0n) rhs += _P256_P;
  if (lhs !== rhs) throw new Error('ecdh_off_curve');
}

// ─── Crypto: ECDH P-256 key generation ───
async function _createKeys() {
  var kp = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']
  );
  var raw = await crypto.subtle.exportKey('raw', kp.publicKey);
  return { publicKey: _toB64(raw), privateKey: kp.privateKey };
}

// ─── Crypto: персистентный ключ устройства (S2) ───
// Сессионная ECDH-пара создаётся один раз и хранится в IndexedDB этого SW.
// Приватный ключ — non-extractable CryptoKey: IndexedDB сохраняет его
// структурным клонированием, но экспортировать байты нельзя ни отсюда, ни со
// страницы. Запись своя у каждого номера: `device-ecdh-p256:<number>`.
// Стирается при logout (ключ текущего номера) / panic (все ключи origin).
// Если IndexedDB недоступна (приватный режим и т.п.) — ключ живёт только в RAM.
var _IDB_NAME = 'phantom-keystore';
var _IDB_STORE = 'keys';
var _IDB_KEY_PREFIX = 'device-ecdh-p256';

function _validNumber(number) {
  return typeof number === 'string' && /^[0-9A-Za-z+_-]{1,64}$/.test(number);
}
function _idbKeyFor(number) { return _IDB_KEY_PREFIX + ':' + number; }

function _idbOpen() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(_IDB_NAME, 1);
    req.onupgradeneeded = function() {
      var db = req.result;
      if (!db.objectStoreNames.contains(_IDB_STORE)) db.createObjectStore(_IDB_STORE);
    };
    req.onsuccess = function() { resolve(req.result); };
    req.onerror = function() { reject(req.error || new Error('idb_open_failed')); };
  });
}

function _idbRequest(mode, fn) {
  return _idbOpen().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(_IDB_STORE, mode);
      var req = fn(tx.objectStore(_IDB_STORE));
      var result;
      req.onsuccess = function() { result = req.result; };
      tx.oncomplete = function() { db.close(); resolve(result); };
      tx.onerror = function() { db.close(); reject(tx.error || new Error('idb_tx_failed')); };
      tx.onabort = function() { db.close(); reject(tx.error || new Error('idb_tx_aborted')); };
    });
  });
}

// Все операции с ключом устройства выполняются строго последовательно:
// иначе `wipe(erase)` и следующий `loadOrCreateKeys` могут переупорядочиться,
// и стёртый ключ «воскреснет» из незавершённой транзакции.
var _keyQueue = Promise.resolve();
function _serialKeyOp(fn) {
  var next = _keyQueue.then(fn, fn);
  _keyQueue = next.then(function() {}, function() {});
  return next;
}

// Запись из IndexedDB принимается только в точно ожидаемой форме: приватный
// ключ non-extractable, ECDH P-256, только deriveBits; публичный — base64 raw
// uncompressed точки (65 байт, 0x04). Иначе запись считается битой и ключ пересоздаётся.
function _isValidStoredPair(rec) {
  if (!rec || typeof rec !== 'object') return false;
  var priv = rec.privateKey;
  if (typeof CryptoKey === 'undefined' || !(priv instanceof CryptoKey)) return false;
  if (priv.type !== 'private' || priv.extractable !== false) return false;
  if (!priv.algorithm || priv.algorithm.name !== 'ECDH' || priv.algorithm.namedCurve !== 'P-256') return false;
  if (!Array.isArray(priv.usages) || priv.usages.length === 0 ||
      !priv.usages.every(function(u) { return u === 'deriveBits'; })) return false;
  if (typeof rec.publicKey !== 'string') return false;
  try {
    var raw = new Uint8Array(_fromB64(rec.publicKey));
    _assertValidP256Point(raw);
  } catch (_e) { return false; }
  return true;
}

// Загрузить пару номера из IndexedDB в RAM (без создания). true — если ключ есть.
async function _restoreSessionKey(number) {
  if (!_validNumber(number)) return false;
  if (_keyCache[number]) return true;
  var rec = null;
  try { rec = await _idbRequest('readonly', function(s) { return s.get(_idbKeyFor(number)); }); }
  catch (_e) { rec = null; }
  if (_isValidStoredPair(rec)) {
    _keyCache[number] = { privateKey: rec.privateKey, publicKey: rec.publicKey };
    return true;
  }
  return false;
}

async function _loadOrCreateSessionKey(number) {
  if (!_validNumber(number)) throw new Error('invalid_number');
  if (await _restoreSessionKey(number)) return _keyCache[number].publicKey;
  // Нет записи или она битая — создаём новую пару и перезаписываем
  var keys = await _createKeys();
  try {
    await _idbRequest('readwrite', function(s) {
      return s.put({ privateKey: keys.privateKey, publicKey: keys.publicKey }, _idbKeyFor(number));
    });
  } catch (_e) { /* без IndexedDB — только RAM */ }
  _keyCache[number] = { privateKey: keys.privateKey, publicKey: keys.publicKey };
  return keys.publicKey;
}

// Стереть ключ номера (logout) или все ключи устройства (panic / номер неизвестен).
async function _eraseSessionKey(number) {
  if (_validNumber(number)) {
    delete _keyCache[number];
    try { await _idbRequest('readwrite', function(s) { return s.delete(_idbKeyFor(number)); }); }
    catch (_e) { /* нечего стирать */ }
    return;
  }
  _keyCache = Object.create(null);
  try {
    // Q14: полный wipe — очищается весь store (все номера и любые старые записи),
    // а не только диапазон префикса
    await _idbRequest('readwrite', function(s) { return s.clear(); });
  } catch (_e) { /* нечего стирать */ }
}

// ─── Crypto: ECDH shared secret ───
async function _ecdhSecret(privKey, peerPubB64) {
  var raw = new Uint8Array(_fromB64(peerPubB64));
  _assertValidP256Point(raw);
  var pub = await crypto.subtle.importKey(
    'raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  return crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, privKey, 256);
}

// ─── Crypto: KDF — SHA-256(shared || "direct:{from}:{to}") → AES-256 key ───
async function _deriveAes(shared, from, to) {
  var ctx = new TextEncoder().encode('direct:' + from + ':' + to);
  var buf = new ArrayBuffer(shared.byteLength + ctx.length);
  var v = new Uint8Array(buf);
  v.set(new Uint8Array(shared), 0);
  v.set(ctx, shared.byteLength);
  var hash = await crypto.subtle.digest('SHA-256', buf);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// ─── Crypto: IV (hybrid timestamp + random, mirrors crypto.ts) ───
function _buildIv() {
  var iv = new Uint8Array(12);
  var tsMs = Date.now();
  iv[0] = (tsMs / 0x10000000000) & 0xff;
  iv[1] = (tsMs / 0x100000000) & 0xff;
  iv[2] = (tsMs >>> 24) & 0xff;
  iv[3] = (tsMs >>> 16) & 0xff;
  iv[4] = (tsMs >>> 8) & 0xff;
  iv[5] = tsMs & 0xff;
  crypto.getRandomValues(iv.subarray(6));
  return iv;
}

// ─── Crypto: encrypt v1 (per-message ephemeral ECDH for forward secrecy) ───
async function _encryptV1(text, from, to, targetPubKey) {
  var eph = await _createKeys();
  var shared = await _ecdhSecret(eph.privateKey, targetPubKey);
  var aes = await _deriveAes(shared, from, to);
  var iv = _buildIv();
  var ad = new TextEncoder().encode('msg:' + from + ':' + to);
  var pt = new TextEncoder().encode(text);
  var ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv, additionalData: ad, tagLength: 128 }, aes, pt
  );
  var nonce = _toB64(iv.buffer);
  return { version: 1, senderPublicKey: eph.publicKey, nonce: nonce, iv: nonce, cipher: _toB64(ct) };
}

// ─── Crypto: конверт v2 (S9 + P1–P3) ───
// ss1 = ECDH(eph_A, id_B), ss2 = ECDH(id_A, id_B) → HKDF (envelope-v2.js) → AES-256-GCM.
// Сообщение привязано к identity-ключу отправителя: подменённый senderIdentityKey
// даёт другой ss2 и другой info → GCM-тег не сходится.
function _rawPub(b64) {
  var raw = new Uint8Array(_fromB64(b64));
  _assertValidP256Point(raw);
  return raw;
}

// Запечатать при уже готовых eph-паре и nonce. Отдельная функция, чтобы тест
// (scripts/test-envelope-v2.mjs) мог подставить фиксированные eph/nonce; через
// message-handler недоступна — там eph и nonce всегда свежие.
async function _sealV2(text, from, to, targetPubKey, own, eph, iv) {
  var peerRaw = _rawPub(targetPubKey);
  var ownRaw = _rawPub(own.publicKey);
  var ephRaw = _rawPub(eph.publicKey);
  var ss1 = new Uint8Array(await _ecdhSecret(eph.privateKey, targetPubKey));
  var ss2 = new Uint8Array(await _ecdhSecret(own.privateKey, targetPubKey));
  var aes;
  try {
    aes = await PhantomEnvelopeV2.deriveV2Key(ss1, ss2, from, to, ownRaw, peerRaw, ephRaw);
  } finally {
    ss1.fill(0);
    ss2.fill(0);
  }
  var ad = PhantomEnvelopeV2.buildAd(from, to);
  var pt = new TextEncoder().encode(text);
  var ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv, additionalData: ad, tagLength: 128 }, aes, pt
  );
  // P3: nonce и iv — одно значение, ставит сам отправитель
  var nonce = _toB64(iv);
  return {
    version: 2,
    senderPublicKey: eph.publicKey,
    senderIdentityKey: own.publicKey,
    nonce: nonce,
    iv: nonce,
    cipher: _toB64(ct),
  };
}

async function _encryptV2(text, from, to, targetPubKey, own) {
  // Ключ собеседника проверяем до генерации eph — без лишней работы на мусоре
  _rawPub(targetPubKey);
  var eph = await _createKeys();
  var iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  return _sealV2(text, from, to, targetPubKey, own, eph, iv);
}

function _nonceBytes(blob) {
  var iv = _fromB64(blob.nonce || blob.iv);
  if (iv.byteLength !== 12) throw new Error('bad_nonce');
  return iv;
}

async function _decryptV2(blob, from, to, own) {
  if (typeof blob.senderPublicKey !== 'string' || typeof blob.senderIdentityKey !== 'string') {
    throw new Error('env2_missing_key');
  }
  // P2: обе точки отправителя валидируются ДО любого ECDH
  var ephRaw = _rawPub(blob.senderPublicKey);
  var idARaw = _rawPub(blob.senderIdentityKey);
  var ownRaw = _rawPub(own.publicKey);
  var iv = _nonceBytes(blob);
  var ct = _fromB64(blob.cipher);
  var ss1 = new Uint8Array(await _ecdhSecret(own.privateKey, blob.senderPublicKey));
  var ss2 = new Uint8Array(await _ecdhSecret(own.privateKey, blob.senderIdentityKey));
  var aes;
  try {
    aes = await PhantomEnvelopeV2.deriveV2Key(ss1, ss2, from, to, idARaw, ownRaw, ephRaw);
  } finally {
    ss1.fill(0);
    ss2.fill(0);
  }
  var ad = PhantomEnvelopeV2.buildAd(from, to);
  var pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv, additionalData: ad, tagLength: 128 }, aes, ct
  );
  return new TextDecoder().decode(pt);
}

// ─── Crypto: decrypt v1 (S9.7 — без изменений) ───
async function _decryptV1(blob, from, to, privKey) {
  var shared = await _ecdhSecret(privKey, blob.senderPublicKey);
  var aes = await _deriveAes(shared, from, to);
  var iv = _fromB64(blob.nonce || blob.iv);
  var ct = _fromB64(blob.cipher);
  var ad = new TextEncoder().encode('msg:' + from + ':' + to);
  var pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv, additionalData: ad, tagLength: 128 }, aes, ct
  );
  return new TextDecoder().decode(pt);
}

// P3: 2 → v2; 1/отсутствует → v1; число ≥ 3 → unsupported_version (без попытки v1).
function _blobVersion(blob) {
  var v = blob && blob.version;
  if (v === 2) return 2;
  if (typeof v === 'number' && v >= 3) return 3;
  return 1;
}

// own = { privateKey, publicKey } — persistent ключ номера-владельца.
async function _decrypt(blob, from, to, own) {
  if (!blob || typeof blob !== 'object') throw new Error('bad_blob');
  var ver = _blobVersion(blob);
  if (ver === 3) throw new Error('unsupported_version');
  if (ver === 2) return _decryptV2(blob, from, to, own);
  return _decryptV1(blob, from, to, own.privateKey);
}

// Отпечаток ключа и safety number считаются на странице (`lib/safety.ts`):
// это функции только от публичных ключей, секретов в них нет.

// ─── Тайник токенов для перезагрузки вкладки (только RAM) ───
// Страница на `pagehide` отдаёт сюда токены аккаунтов, а в sessionStorage оставляет лишь
// одноразовый nonce; после перезагрузки забирает токены по nonce. Ни IndexedDB, ни Cache:
// закрытие вкладки/браузера или остановка SW стирают тайник. Карта nonce → {payload, at}:
// не больше 8 записей (самые старые вытесняются), TTL 30 с, чтение одноразовое; take/drop —
// только по своему nonce (вкладки не перетирают друг друга).
var _STASH_TTL_MS = 30000;
var _STASH_MAX = 8;
var _stash = Object.create(null); // nonce -> { payload, at }
var _stashTimer = null;
function _stashPrune(now) {
  var keys = Object.keys(_stash);
  for (var i = 0; i < keys.length; i++) {
    if (now - _stash[keys[i]].at >= _STASH_TTL_MS) delete _stash[keys[i]];
  }
}
// Таймер — на истечение самой старой записи: запись живёт в RAM не дольше TTL
// (раньше таймер ставился на TTL после первой записи и мог держать вторую до ~2×TTL).
function _stashSchedule(now) {
  if (_stashTimer) { clearTimeout(_stashTimer); _stashTimer = null; }
  var oldest = Infinity;
  var keys = Object.keys(_stash);
  for (var i = 0; i < keys.length; i++) if (_stash[keys[i]].at < oldest) oldest = _stash[keys[i]].at;
  if (oldest !== Infinity) _stashTimer = setTimeout(_stashSweep, Math.max(0, oldest + _STASH_TTL_MS - now));
}
function _stashSweep() {
  _stashTimer = null;
  var now = Date.now();
  _stashPrune(now);
  _stashSchedule(now);
}
function _stashClear() {
  _stash = Object.create(null);
  if (_stashTimer) { clearTimeout(_stashTimer); _stashTimer = null; }
}
function _stashPut(nonce, payload) {
  var now = Date.now();
  _stashPrune(now);
  delete _stash[nonce]; // повторная запись того же nonce — как самая новая
  var keys = Object.keys(_stash); // порядок вставки: самые старые первыми
  for (var i = 0; keys.length - i >= _STASH_MAX; i++) delete _stash[keys[i]];
  _stash[nonce] = { payload: payload, at: now };
  _stashSchedule(now);
}
function _stashTake(nonce) {
  var cur = _stash[nonce];
  if (!cur) return null;
  delete _stash[nonce];
  if (Date.now() - cur.at >= _STASH_TTL_MS) return null;
  return cur.payload;
}
function _stashDrop(nonce) {
  if (typeof nonce === 'string') delete _stash[nonce];
}

// ─── Origin enforcement ───
// Same-origin iframes (via stored-XSS or a hostile <object> embed) can also
// reach this worker via postMessage. We accept messages only from the same
// origin the SW was registered at, and require a response port (except for
// fire-and-forget `wipe`, which never returns data anyway).
function _expectedOrigin() {
  var scope = (self.registration && self.registration.scope) || '';
  return scope.replace(/\/$/, '');
}

// ─── Crypto: message handler (communication via MessageChannel for isolation) ───
self.addEventListener('message', function(event) {
  if (!event.data || !event.data.op) return;

  // Origin gate. Empty origin can appear for same-origin Window senders on
  // some older browsers — fall back to checking the source client's URL.
  var expected = _expectedOrigin();
  if (event.origin && event.origin !== expected) return;
  if (!event.origin && event.source && event.source.url) {
    try {
      var u = new URL(event.source.url);
      if (u.origin !== expected) return;
    } catch (_e) { return; }
  }

  var port = event.ports && event.ports[0];
  var op = event.data.op;

  // Тайник токенов (см. выше): put без ответа, take — через порт, drop — без ответа.
  if (op === 'stash_tokens') {
    var sn = event.data.nonce, sp = event.data.payload;
    if (typeof sn === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(sn) && typeof sp === 'string' && sp.length > 0 && sp.length <= 8192) {
      _stashPut(sn, sp);
    }
    return;
  }
  if (op === 'take_stash') {
    var tn = event.data.nonce;
    var got = (typeof tn === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(tn)) ? _stashTake(tn) : null;
    if (port) port.postMessage({ ok: true, result: got });
    return;
  }
  if (op === 'drop_stash') {
    // Только свой nonce; без nonce ничего не стирается
    var dn = event.data.nonce;
    if (typeof dn === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(dn)) _stashDrop(dn);
    return;
  }

  // wipe + healthcheck may run without a response port.
  // wipe без erase — только выгрузить ключ из RAM (beforeunload): он
  // восстановится из IndexedDB при следующем loadOrCreateKeys/decrypt.
  // wipe с erase: true — logout / panic: стереть ключ устройства навсегда.
  // erase + number — стереть ключ этого номера; erase без number (или all) — все.
  if (op === 'wipe') {
    var erase = event.data.erase === true;
    var wipeNumber = event.data.all === true ? '' : event.data.number;
    // logout/panic (erase) стирают и тайник токенов; обычная выгрузка (beforeunload) — нет
    if (erase) _stashClear();
    // waitUntil: браузер не должен усыпить SW до завершения удаления из IndexedDB
    event.waitUntil(_serialKeyOp(function() {
      if (erase) return _eraseSessionKey(wipeNumber);
      _keyCache = Object.create(null);
    }).then(function() {
      if (port) port.postMessage({ ok: true, result: null });
    }));
    return;
  }

  if (op === 'healthcheck') {
    if (port) port.postMessage({ ok: true, result: { version: SW_VERSION } });
    return;
  }

  // Страница загружена мимо SW (Shift+F5): взять её под управление, не трогая регистрацию —
  // иначе страница сняла бы регистрацию у всей origin и другие вкладки потеряли бы контроллер.
  if (op === 'claim') {
    event.waitUntil(self.clients.claim());
    return;
  }

  // All other ops require a response port.
  if (!port) return;

  (async function() {
    try {
      switch (op) {
        case 'loadOrCreateKeys': {
          var keyNumber = event.data.number;
          var pub = await _serialKeyOp(function() { return _loadOrCreateSessionKey(keyNumber); });
          port.postMessage({ ok: true, result: { publicKey: pub } });
          break;
        }
        case 'encrypt': {
          var blob;
          if (event.data.version === 2) {
            // v2 подписывается persistent-ключом своего номера (по умолчанию — отправителя)
            var encNumber = event.data.keyNumber || event.data.fromNumber;
            if (!_keyCache[encNumber]) await _serialKeyOp(function() { return _restoreSessionKey(encNumber); });
            var encOwn = _keyCache[encNumber];
            if (!encOwn) {
              port.postMessage({ ok: false, error: 'no_session_key' });
              break;
            }
            blob = await _encryptV2(event.data.text, event.data.fromNumber, event.data.toNumber, event.data.targetPublicKey, encOwn);
          } else {
            blob = await _encryptV1(event.data.text, event.data.fromNumber, event.data.toNumber, event.data.targetPublicKey);
          }
          port.postMessage({ ok: true, result: blob });
          break;
        }
        case 'decrypt': {
          // Ключ мог быть выгружен из RAM (beforeunload в другой вкладке,
          // перезапуск SW браузером) — пробуем поднять его из IndexedDB.
          // Ключ берётся по номеру-владельцу (по умолчанию — получатель).
          var ownNumber = event.data.keyNumber || event.data.toNumber;
          if (!_keyCache[ownNumber]) await _serialKeyOp(function() { return _restoreSessionKey(ownNumber); });
          var own = _keyCache[ownNumber];
          if (!own) {
            port.postMessage({ ok: false, error: 'no_session_key' });
            break;
          }
          var text = await _decrypt(event.data.blob, event.data.fromNumber, event.data.toNumber, own);
          port.postMessage({ ok: true, result: text });
          break;
        }

        case 'hasKey': {
          port.postMessage({ ok: true, result: Object.keys(_keyCache).length > 0 });
          break;
        }
        default:
          port.postMessage({ ok: false, error: 'unknown_op' });
      }
    } catch (err) {
      port.postMessage({ ok: false, error: (err && err.message) || 'unknown error' });
    }
  })();
});

// ─── Push notification handler ───
// The push payload arriving here is controlled by the relay (and therefore by
// a network attacker or a compromised relay). We deliberately IGNORE any
// message-body field in the payload and always render a GENERIC preview, so
// the OS Notification Center / lock-screen history never stores plaintext.
self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) { data = {}; }
  var title = 'Phantom Messenger';
  var body = 'Новое сообщение'; // "Новое сообщение"
  var type = data.type || 'message';
  if (type === 'voice_message') body = 'Голосовое сообщение'; // "Голосовое сообщение"
  else if (type === 'file_message') body = 'Файл'; // "Файл"
  // Мультиаккаунт: уведомление несёт номер получателя (если push его указал); клик откроет чат
  // только под совпадающим активным аккаунтом (сверка на странице)
  var toNumber = (typeof data.toNumber === 'string' && /^\d{10}$/.test(data.toNumber)) ? data.toNumber : '';
  var options = {
    body: body,
    tag: data.fromNumber ? 'phantom-' + toNumber + '-' + data.fromNumber : 'phantom-default',
    renotify: true,
    data: { fromNumber: data.fromNumber || '', toNumber: toNumber, type: type }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// ─── Notification click handler ───
// NOTE: On cold start (no existing window), fromNumber is passed via URL query param
// so the SPA (App.tsx) must check URLSearchParams for 'open_chat' on mount
// and navigate to the corresponding chat.
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var fromNumber = event.notification.data && event.notification.data.fromNumber;
  var toNumber = (event.notification.data && event.notification.data.toNumber) || '';
  // Без номера получателя сверить нечем — окно только фокусируется, чат не открывается
  if (!toNumber) fromNumber = '';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.indexOf(self.location.origin) !== -1) {
          client.focus();
          if (fromNumber) client.postMessage({ type: 'open_chat', fromNumber: fromNumber, toNumber: toNumber });
          return;
        }
      }
      return self.clients.openWindow(fromNumber ? '/?open_chat=' + encodeURIComponent(fromNumber) + '&to=' + encodeURIComponent(toNumber) : '/');
    })
  );
});

// WEB-25: fetch-обработчика нет — SW ничего не кэширует и не должен просыпаться на каждый запрос.
