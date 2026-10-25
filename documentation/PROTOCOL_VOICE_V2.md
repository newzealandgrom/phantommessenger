# Голосовые v2 («как в Telegram»): единый Opus/WebM, точная длительность и «волна» в meta1

**Статус:** 2026-10-24, пакет D0 плана `.claude/plans/2026-10-24-voice-telegram-opus.md`. Эталон: `documentation/voice_v2_vector.json` (генератор `voice_v2_vector_gen.py`), фикстуры `documentation/fixtures/voice_*.webm`.
**Область:** содержимое поля `data` голосового и два новых/уточнённых поля meta1 `k:"voice"`. Конверт v2, внешний кадр relay, P2P-транспорт, лимиты relay — **не меняются**. Relay правок не требует.
**Нормативные слова:** MUST / SHOULD / MAY.

## 0. Решения коротко

| # | Вопрос | Решение | Почему |
|---|---|---|---|
| 1 | Контейнер | **WebM (Matroska) + Opus**, mime `audio/webm`. Приём: **только** WebM/Opus (MUST); иные форматы (MP4/AAC, Ogg и т.д.) не поддерживаются — пузырь «не удалось воспроизвести» (решение владельца 24.10: «только новый тип») | Его уже пишет MediaRecorder Chrome/Firefox и уже читает `Core/VoiceCodec.swift:58-240` (iOS+mac); Android читает Matroska/Opus с API 21; HEAD-клиенты играют `audio/webm` без правок (mac `ContentRules.swift:17` `playableVoiceMimes` содержит `audio/webm`, но **не** `audio/ogg`; iOS `VoiceContainer.sniff` для Ogg даёт `.unknown` → AVAudioPlayer откажет). WebM не требует OpusTags (строка vendor = утечка версии энкодера), Ogg требует. Альтернатива Ogg (как Telegram): новый демуксер на 3 платформах и «не воспроизводится» на HEAD iOS/mac — отклонено |
| 2 | Кодек | Opus, 48 кГц, моно, VBR, целевой битрейт **24 кбит/с**, пакет 20 мс (web/MediaRecorder даёт 60 мс = 3×20 — допустимо) | 24 кбит/с SILK/CELT WB ≈ прозрачная речь; в 140 КиБ ≈ 43 с (п. 2.4). Альтернативы: 16 кбит/с ≈ 62 с (хуже на шумном фоне), 32 кбит/с ≈ 33 с |
| 3 | Волна | поле `wave`: base64 **ровно 63 байт** = 100 значений × 5 бит, упаковка LSB-first (как Telegram); RMS по 100 равным корзинам, нормировка к максимуму | Формат Telegram, 84 символа в JSON, одинаково рисуется на 4 платформах |
| 4 | Длительность | `durMs` MUST быть точной: `round(frames / 48000 · 1000)` по PCM, поданному в энкодер (web — по декоду записи) | Таймеры UI давали ±200 мс (Android показывал iOS +0,18 с) |
| 5 | Воспроизведение | iOS/mac — `WebMOpusDemuxer` + `OpusPacketDecoder` → PCM → `AVAudioPlayer(data: wav)` (уже есть); Android — `MediaExtractor` + `MediaCodec` → PCM в памяти → `AudioTrack` (новое); web — `<audio>` из Blob (встроенный декодер браузера), `wave`/`durMs` только из payload | Своим декодером там, где это даёт контроль (нативные клиенты); в браузере иного декодера, кроме встроенного, нет (WASM-libopus — новая зависимость, не вводим) |
| 6 | Совместимость | Поля только добавляются; все три парсера meta1 игнорируют неизвестные поля (`client/src/lib/meta1.ts:206-212`, `Meta1.kt:315-320`, `Meta1.swift:144-152`) → старые клиенты показывают голосовое без волны и играют его. Capability не нужна | — |
| 7 | Только Opus, но запись и прослушивание — везде | Только Opus/WebM, AAC нигде нет (решение владельца 24.10: «только новый тип», «запись доступна должна быть везде», «как и прослушивание»). Где нет системного Opus-энкодера/декодера — встроенный программный: Android API 26–28 или устройство без `audio/opus` — Concentus (порт libopus на чистой Java); web без `MediaRecorder` `audio/webm;codecs=opus` (Safari ≤ 18.3) — встроенный Opus-энкодер (WebCodecs `AudioEncoder`, если `isConfigSupported`, иначе вендоренная сборка libopus) + TS-муксер §2.3; web без нативного воспроизведения WebM/Opus — `decodeAudioData`, иначе встроенный декодер → PCM → проигрывание | — |

## 1. Поле meta1 `k:"voice"` (расширение S10.1)

Plaintext = `0x00` ‖ компактный JSON (без изменений, `PROTOCOL_S10_SPEC.md`). Для `k:"voice"`:

```
{ "k": "voice",
  "id":    string,              // = внешний messageId (Q4), без изменений
  "mime":  "audio/webm",   // ≤ 127, type/subtype, без параметров (";codecs" запрещён MIME_RE)
  "durMs": int,                 // 0 … 3 600 000 (Q19); v2: ТОЧНАЯ длительность звука
  "data":  base64 std,          // файл целиком; ≤ 140 КиБ до base64 (MAX_ATTACHMENT_BYTES)
  "wave":  base64 std,          // v2, опционально: ровно 63 байта (84 символа с "=")
  "replyTo", "fwd", "sd", "pad" // без изменений
}
```

Пример (сокращённый `data`):
```json
{"k":"voice","id":"m-10","mime":"audio/webm","durMs":5012,"wave":"H4j4fJ+f//8/P4cP…","data":"GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwH/////////FUmpZpkq17GDD0JATYCGQ2hyb21lV0GGQ2hyb21lFlSua0OuAQAAAAAAAD0…"}
```

### 1.1 Правила отправителя (MUST)
- `mime` = `audio/webm` (единственный допустимый у отправителя). Без `;codecs=…`.
- `durMs` = `round(N / 48000 · 1000)`, где N — число PCM-кадров (48 кГц) реально поданных в энкодер (без pre-skip и без хвостового дополнения до целого пакета).
- `wave` — по алгоритму §3 из того же PCM. Если PCM недоступен (теоретически), поле не посылать; «выдуманную» волну посылать MUST NOT.
- Легаси-получатель (без `meta1`): внешний `voice_message` c `duration` (секунды) и `mimeType:"audio/webm"` — тот же файл; `wave` некуда положить, не посылается. Отдельный AAC-энкодер для легаси не держим.
- Размер `data` до base64 ≤ `MAX_ATTACHMENT_BYTES` = 143 360; запись останавливается заранее (§2.4).

### 1.2 Правила получателя (MUST)
- Неизвестные поля — игнор (как было). Обязательные: `mime`, `durMs` (Q19) — без изменений.
- `wave`: если тип не строка, base64 невалиден или длина декодированных байт ≠ 63 → поле **игнорируется**, сообщение показывается без волны (НЕ «[Некорректное сообщение]», НЕ дроп). Старшие 4 бита последнего байта (биты 500…503) игнорируются (отправитель пишет нули).
- Формат файла определяется **по сигнатуре байт**, не по `mime` (как `VoiceContainer.sniff`, `Core/VoiceCodec.swift:27-36`): `1A 45 DF A3` → WebM/Opus; всё остальное — состояние «не удалось воспроизвести» в пузыре (не тост-ошибка протокола).
- `durMs` — для подписи и шкалы до начала воспроизведения. После декода, если фактическая длительность отличается > 1 000 мс, шкала/подпись SHOULD перейти на фактическую (защита от лжи отправителя), но `durMs` остаётся в модели сообщения.
- Воспроизведение файла, не прошедшего пределы §5, запрещено (ошибка в пузыре).

## 2. Формат файла: WebM/Opus «voice-v2»

### 2.1 Opus
- 48 000 Гц, 1 канал (получатели MUST также принимать 2 канала с даунмиксом), VBR, целевой битрейт отправителя SHOULD 24 000 бит/с (MUST ≤ 32 000).
- Длительность пакета MUST ∈ {10, 20, 40, 60} мс (TOC code 0…3, многокадровые допустимы); отправители с собственным энкодером SHOULD 20 мс (960 кадров); MediaRecorder Chrome даёт 60 мс (3×20, TOC `0xFB`/`0x7B`, фикстура `scratchpad/ios-dev/fixtures/chrome_opus_5s.webm`: 83 пакета, 5 кластеров, 13 479 байт).
- Pre-skip: значение энкодера (libopus — 312 кадров = 6,5 мс; Chrome пишет 0). Получатель MUST пропустить pre-skip кадров в начале: источник — `CodecDelay` (нс → кадры), иначе `pre_skip` из `OpusHead`.
- Хвост: последний неполный пакет дополняется тишиной; `DiscardPadding` MAY (наши муксеры не пишут); лишние ≤ 60 мс тишины допустимы, точную длину несёт `durMs`.

### 2.2 Структура WebM (минимум, который MUST читать все получатели)
```
EBML { DocType "webm" }
Segment (size известен ИЛИ unknown — Chrome пишет unknown)
  Info  { TimecodeScale 1000000 [, Duration] [, MuxingApp, WritingApp] }     ← Duration у Chrome нет
  Tracks { TrackEntry { TrackNumber, TrackUID, TrackType 2, CodecID "A_OPUS",
           CodecPrivate = OpusHead(19 B) [, CodecDelay] [, SeekPreRoll],
           Audio { SamplingFrequency 48000, Channels 1|2 [, BitDepth] } } }
  Cluster* (size известен ИЛИ unknown) { Timecode(ms), (SimpleBlock | BlockGroup{Block [,DiscardPadding]})* }
```
- Один Opus-трек; первый трек с `CodecID == "A_OPUS"` используется, прочие игнорируются; видеотреки → отказ.
- Элементы `SeekHead`, `Cues`, `Tags`, `Void`, `Chapters` — пропускаются. Lacing в блоках: отправители MUST NOT (наши муксеры, Chrome и Firefox его не пишут); получатели MAY отклонять файл с lacing («не удалось воспроизвести» — так делает web), iOS/macOS/Android разбирают (`WebMOpusDemuxer.blockFrames`).
- `OpusHead` (RFC 7845 §5.1, LE): `"OpusHead"`, version 1, channels, pre_skip u16, input_sample_rate u32 (информативно), output_gain i16 (MUST 0 у отправителя; получатель MAY игнорировать), mapping_family 0.

### 2.3 Канонический муксер отправителя (iOS/mac `Core`, Android) — SHOULD байт-в-байт
Нужен для детерминированных тестов (`voice_v2_ref.webm`) и минимума метаданных:
- Все размеры — минимальные vint, кроме `Segment` — 8-байтовый vint с известным размером.
- `EBML`: EBMLVersion 1, EBMLReadVersion 1, EBMLMaxIDLength 4, EBMLMaxSizeLength 8, DocType `webm`, DocTypeVersion 4, DocTypeReadVersion 2.
- `Info`: TimecodeScale 1 000 000; Duration float64 = длительность всех пакетов, мс; MuxingApp = WritingApp = `"phantom"` (константа; имя/версия приложения, устройство, `DateUTC`, `Title` — MUST NOT).
- `TrackEntry`: TrackNumber 1, TrackUID 1 (не случайный — ничего не идентифицирует), TrackType 2, FlagLacing 0, CodecID `A_OPUS`, CodecDelay = pre_skip·1 000 000 000/48 000 нс, SeekPreRoll 80 000 000, CodecPrivate OpusHead(channels 1, pre_skip энкодера, input_sample_rate 48 000, gain 0, family 0), Audio{SamplingFrequency float32 48000.0, Channels 1}.
- Кластеры: новый кластер, когда `ts_packet − ts_cluster ≥ 5 000` мс; `Timecode` кластера = ts первого пакета; `SimpleBlock`: track vint `0x81`, относительный timecode i16 (мс), flags `0x80` (keyframe), без lacing. ts пакета i = `floor(кадров_до_него / 48)` мс.
- Порядок элементов фиксирован: `EBML`, `Segment{Info, Tracks, Cluster…}`; в `EBML`: EBMLVersion, EBMLReadVersion, EBMLMaxIDLength, EBMLMaxSizeLength, DocType, DocTypeVersion, DocTypeReadVersion; в `Info`: TimecodeScale, Duration, MuxingApp, WritingApp; в `TrackEntry`: TrackNumber, TrackUID, TrackType, FlagLacing, CodecID, CodecDelay, SeekPreRoll, CodecPrivate, Audio. Целые — минимальной длины big-endian (0 → один байт `00`). `Duration` = (Σ кадров пакетов по TOC)/48 мс, float64 BE.
- Никаких `SeekHead`/`Cues`/`Void`/`Tags`.

### 2.4 Бюджет длительности (140 КиБ = 143 360 байт)
Накладные: заголовок ≈ 200 Б, SimpleBlock ≈ 6 Б на пакет. При 24 кбит/с и 20 мс: 3 000 + 300 Б/с ≈ 3 300 Б/с → **≈ 43 с**; при 60 мс-пакетах (web) ≈ 3 100 Б/с → ≈ 46 с. (16 кбит/с → ≈ 62 с; 32 → ≈ 33 с.) Отправитель MUST не отправлять файл больше лимита: останавливать запись по фактическим байтам энкодера + накладным с запасом ≥ 2 КиБ, ЛИБО по консервативной оценке (байт/с при целевом битрейте + накладные) с обязательной проверкой фактического размера до отправки и пересборкой на меньшем битрейте (16 000 бит/с) при превышении (iOS/macOS 25.10: оценка ≈ 40 с при 24 кбит/с; худший случай шум 40,3 с = 130 021 Б ≤ 143 360 Б).

## 3. Волна (`wave`)

### 3.1 Вычисление (отправитель)
Вход: PCM моно (при ≥ 2 каналах — среднее каналов), любые частоты (нормировка делает масштаб неважным), N кадров — те же, что ушли в энкодер (web: результат `decodeAudioData` записи).
```
K = 100
for i in 0..K-1:
    a = floor(i * N / K);  b = floor((i+1) * N / K)        // b > a при N ≥ 100; при N < 100 пустые корзины → rms = 0
    rms[i] = sqrt( sum_{n=a}^{b-1} x[n]^2 / (b - a) )     // double; x — сэмпл как число (int16 или float — всё равно)
peak = max(rms)
if peak <= 0: v[i] = 0 для всех i
else:         v[i] = min(31, floor(rms[i] / peak * 31 + 0.5))
```
Без сглаживания, без логарифма, без «пола» — визуальный минимум добавляет только отрисовка.

### 3.2 Упаковка (63 байта, LSB-first, как Telegram)
Значение `v[i]` (0…31) занимает биты `[5i, 5i+5)` битового потока, бит `j` потока = бит `j mod 8` байта `j div 8` (младший бит — первый). Биты 500…503 = 0.
```
pack:   for i: bitpos = 5*i; byte = bitpos>>3; shift = bitpos&7;
        out[byte]   |= (v << shift) & 0xFF;
        if shift > 3: out[byte+1] |= v >> (8 - shift)
unpack: v[i] = ((bytes[byte] | (bytes[byte+1]<<8 если byte+1 < 63 иначе 0)) >> shift) & 31
```
Пример: `v = [31, 0, 1, 2, 3, 0 ×95]` → байты `1F 04 31 00 … 00` (63 байта): 31 → биты 0–4 (`0x1F`); 1 → биты 10–14 (байт 1, сдвиг 2 → `0x04`); 2 → биты 15–19 (байт 1 бит 7 = 0, байт 2 бит 0 = 1); 3 → биты 20–24 (байт 2, сдвиг 4 → `0x30`; итого байт 2 = `0x31`). base64: `HwQxAAAA…AAAA` (84 символа).
JSON: `wave` = base64 std с паддингом (84 символа).

### 3.3 Отрисовка (все платформы, SHOULD)
- Столбиков B = по ширине (28…60); значение столбика j = max по корзинам `[floor(j·100/B), floor((j+1)·100/B))`; высота = 15 % + 85 %·v/31 (минимум видим).
- Прогресс: столбики с индексом `< B·pos/dur` — акцентный цвет; тап/перетаскивание по волне = перемотка (fraction → `seek`).
- Скорость 1× → 1,5× → 2× по кнопке (iOS уже: `RelayVoicePlayer.rates`), с сохранением тона (AVAudioPlayer `enableRate`; Android `PlaybackParams.setSpeed`, pitch 1.0; web `<audio>` `playbackRate` + `preservesPitch`).
- Подпись: при воспроизведении — текущая позиция, иначе — `durMs` (m:ss).
- Сообщение без `wave` (старые клиенты, легаси): статичные столбики по id (как сейчас) или плоская линия; выдавать их за реальные — нельзя (без анимации «настоящей» громкости).

### 3.4 Валидация (получатель) — см. §1.2
63 байта ровно; значения по построению 0…31; иное → поле игнорируется. Волна никогда не влияет на декод/воспроизведение.

## 4. Платформы: запись и воспроизведение

| Платформа | Запись (Opus) | Фолбэк | Воспроизведение |
|---|---|---|---|
| iOS, macOS (`Core/`) | PCM-куски CAF 48 кГц (пауза/продолжение как сейчас) → `AVAudioConverter` → `kAudioFormatOpus` (48 кГц, моно, `mFramesPerPacket` 960, `bitRate` 24 000, стратегия Variable; образец — `Mesh/Voice/MeshOpusRecorder.swift:61-100`) → канонический WebM (§2.3). Pre-skip — из `AVAudioConverter.primeInfo.leadingFrames` (**проверить** значение для Opus; если 0/недоступно — 312 и сверка длительности в тесте) | Нет (AAC-энкодер `VoiceNoteEncoder`/`Mp4EditList` удаляется) | Демукс WebM + Opus → WAV в памяти → `AVAudioPlayer` (rate, seek). Другие форматы — «не удалось воспроизвести» |
| Android (minSdk 26) | API ≥ 29 и `MediaCodecList.findEncoderForFormat(audio/opus) != null`: `AudioRecord` 48 кГц моно PCM16 → `MediaCodec audio/opus` (24 000 бит/с; `csd-0` = OpusHead энкодера — pre_skip брать из него, байты 10–11 LE, не хардкодить; образец — `data/mesh/voice/MeshOpusRecorder.kt:90-125, 214-236`) → канонический WebM. Пауза = `AudioRecord.stop()` без закрытия энкодера (поток пакетов непрерывен, склейки сегментов нет); прослушивание на паузе — PCM через `AudioTrack` | API 26–28 / нет энкодера: программный энкодер Concentus (тот же WebM-муксер); AAC-путь `MediaRecorder` + `VoiceSegmentMerger` удаляется | Новый плеер: `MediaExtractor` (файл в приватном каталоге) → первый аудиотрек с mime `audio/opus` → `MediaCodec` → PCM16 целиком в памяти → `AudioTrack` (STREAM, `PlaybackParams` speed) с точной позицией/перемоткой; Opus-декодер MediaCodec есть с API 21; если не создаётся — декодер Concentus |
| Web | MediaRecorder `audio/webm;codecs=opus`, `audioBitsPerSecond` 24 000 (как сейчас, `VoiceRecorderBar.tsx:27-28`), 48 кГц по умолчанию; после stop — `AudioContext.decodeAudioData(blob)` → `durMs` (точная) и `wave`. Пауза/продолжение — `MediaRecorder.pause/resume` | Без `audio/webm;codecs=opus` в MediaRecorder (Safari ≤ 18.3): PCM из `AudioWorklet`/`ScriptProcessor` → WebCodecs `AudioEncoder` Opus (если поддержан) или встроенный libopus → TS-муксер §2.3. Встроенный кодек загружается лениво, только когда нужен | `<audio>` из Blob (как сейчас), `playbackRate` 1/1,5/2, `currentTime` для перемотки (seek в webm без Cues — **проверить** в Chrome/Firefox; при проблемах — `decodeAudioData` → `AudioBufferSourceNode` с offset, без сохранения тона). Длительность/волна — только из payload. Safari: `canPlayType("audio/webm; codecs=opus")` — **проверить**; при "" — тот же `decodeAudioData`-путь, если Safari декодирует WebM/Opus, иначе «не удалось воспроизвести» |

Mesh PTT (`Mesh/Voice/*`, `data/mesh/voice/*`) не трогается: ни файлы, ни формат.

## 5. Безопасность разбора недоверенных медиа (MUST на всех платформах)
- Вход: `data` ≤ `MAX_FRAME_BYTES` (262 144) после base64 (уже проверяется парсерами meta1); декодер не читает ничего вне буфера.
- EBML: глубина вложенности ≤ 6; размер элемента проверяется против конца буфера; unknown-size только у `Segment`/`Cluster`; неизвестные ID пропускаются по размеру; при невозможности прочитать vint — отказ, не падение.
- Opus: ≤ 30 000 пакетов; длина пакета ≤ 3·1275; предпроход по TOC (`OpusPacketDecoder.samples(inPacket:)`), суммарно ≤ 300 000 мс (`maxDecodeMs`), иначе `tooLong` **до** декода; каналы 1…2 (даунмикс); частота декода фиксирована 48 кГц; PCM-буфер ≤ 300 с × 48 000 × 2 Б = 28,8 МБ (моно int16). Android: тот же предел по кадрам, `KEY_DURATION` трека не доверять (у Chrome его нет).
- `durMs` ≤ 3 600 000 (Q19), `wave` ровно 63 байта; значения волны не используются ни для чего, кроме рисования.
- Никаких новых открытых метаданных: `mime`, `durMs`, `wave` только внутри E2E; внешний кадр `{type,toNumber,messageId,encryptedBlob}` без изменений. Муксер не пишет имя/версию приложения, дату, случайные UID (§2.3). Файл от MediaRecorder содержит `MuxingApp "Chrome"`/Firefox — внутри E2E, допустимо.
- Логи: ни байт аудио, ни волна, ни длительность не логируются (`slog`/`PhantomLog`/R8 — как сейчас).
- Временные файлы записи — только в защищённых каталогах (iOS `SecureTemp`, Android `filesDir()`), удаляются при отправке/отмене/wipe (как сейчас); Android: имена `phantom_voice_*` чистятся при старте, сохранённые «Избранного» — `saved_voice_<id>.webm` (расширение меняется с `.m4a`).

## 6. Совместимость

### 6.1 Что увидят выпущенные/HEAD клиенты, получив голосовое v2 (`audio/webm` + `wave`)
| Получатель | Разбор | Воспроизведение |
|---|---|---|
| Web прод (23.10) | `parseMeta1` игнорирует `wave` (`meta1.ts:206-212`) | `<audio>` Blob `audio/webm`: Chrome/Firefox — играет; Safari — **проверить** |
| iOS HEAD (не выпущен) | `Meta1.swift:144-152` игнорирует | `VoicePlayback.playableData` → WebM-демукс → играет |
| iOS выпущенный (до 23.10) | игнорирует | relay-голосовых плеера не было вовсе — поведение не ухудшается |
| Android HEAD | `Meta1.kt:315-320` игнорирует; файл `voice_<id>.webm` (`ChatViewModel.kt:1815`) | `MediaPlayer` играет Matroska/Opus (API 21+) |
| macOS HEAD | `ContentController.swift:85-92` | `isPlayableVoice("audio/webm")` = true → `VoicePlayback` → играет |
Легаси (`voice_message`, `mimeType:"audio/webm"`): Android/web — играют; старый iOS — плеера не было. Ни один клиент не показывает «[Некорректное сообщение]».

### 6.2 Что новые клиенты обязаны принимать (MUST)
- Только `audio/webm` / WebM-Opus. Сообщение с другим `mime`/форматом показывается пузырём «не удалось воспроизвести» (без invalid); легаси `voice_message` с `duration` в секундах (Q2) — без изменений.
- `mime` не из списка, но сигнатура известна → играть по сигнатуре; сигнатура неизвестна → пузырь с «не удалось воспроизвести», не ошибка протокола.

### 6.3 Версионирование
Отдельного номера версии нет: «v2» = наличие `wave` + канонический кодек. Любое будущее несовместимое изменение (другой контейнер по умолчанию, другое число корзин) — только новым полем/значением с сохранением чтения v2.

## 7. Эталон и тесты

Файлы (пакет D0 плана): `documentation/voice_v2_vector.json`, генератор `documentation/voice_v2_vector_gen.py` (только stdlib), фикстуры `documentation/fixtures/voice_chrome_opus_5s.webm` (копия `scratchpad/ios-dev/fixtures/chrome_opus_5s.webm`, sha256 `2eb1c0f2…8038`, 13 479 Б; тест декода — `scratchpad/ios-dev/voice_codec_test.swift`) и `documentation/fixtures/voice_v2_ref.webm` (канонический муксер §2.3 по пакетам, извлечённым генератором из Chrome-фикстуры; pre_skip 0 как в исходнике).

Содержимое `voice_v2_vector.json`:
1. `wave_pack`: списки из 100 значений ↔ hex 63 байт (включая `[31,0,1,2,3,0…]`, все 31, все 0, «пила» 0…31).
2. `wave_compute`: синтетический PCM, описанный формулой (int16, 48 кГц; сегменты `{ms, amp, freqHz}`; сэмпл = `round(amp·32767·sin(2π·f·n/48000))`; тишина; одиночный пик; длина 300 мс (корзины по 144 кадра); 5 012 мс) → ожидаемые 100 значений. Тона по возможности 1000 Гц (период 48 кадров), чтобы RMS корзин был стабилен; сэмпл округляется как `floor(x + 0.5)`, `freqHz = 0` при `amp > 0` — постоянная составляющая; индекс `n` сквозной по всему PCM. Генератор гарантирует запас ≥ 0,05 от границы округления; тест принимает |Δ| ≤ 1 на значение (разница float32/float64), ≥ 95 из 100 точных.
3. `meta1_voice`: plaintext-кейсы (`plaintext_hex` = `00` ‖ компактный JSON; `expect.wave_hex` — hex 63 байт или `null`) (без шифрования — конверт покрыт `meta1_vector.json`): `v2_ok` (webm + `wave` 63 Б → show, wave hex), `v2_wave_62b` и `v2_wave_64b` (→ show, wave отсутствует), `v2_wave_not_string` (→ show, без wave), `legacy_m4a_no_wave` (→ show), `bad_dur` (→ invalid, как Q19).
4. `webm_fixture`: для Chrome-фикстуры — `packets` 83, `channels` 1, `pre_skip` 0, `sha256`, `decoded_ms` ∈ [4 900, 5 100] (фактическое значение — после прогона Core-теста); для `voice_v2_ref.webm` — `sha256`, `packets` 83, `clusters` 1 (83 × 60 мс = 4 980 мс, ts последнего пакета 4 920 < 5 000), структура по §2.3.
5. `encoder_roundtrip` (только требования, без байт): платформенный энкодер из синтетического PCM 3 000 мс → файл ≤ 12 000 Б, демукс своим же читателем, `decoded_ms` ∈ [2 940, 3 060], `durMs` = 3 000, `wave` синтетики совпадает с `wave_compute` при |Δ| ≤ 2.

Тесты по платформам: web `client/scripts/test-voice-v2.mjs` (pack/unpack/compute на `lib/voiceWave.ts`, парсер `meta1.ts`, демукс-проверка не нужна); iOS/mac `scratchpad/ios-dev/voice_codec_test.swift` (+ муксер байт-в-байт против `voice_v2_ref.webm`, энкодер round-trip, волна) и `meta1_test.swift`, mac `mac/tests/content_test.swift`; Android `data/media/{VoiceWaveTest,WebMOpusMuxerTest}` (JVM, без MediaCodec) + `Meta1VectorTest`; MediaCodec/AVAudioConverter — только в симуляторе/эмуляторе/скрипте на macOS.

## 8. Открытые вопросы владельцу
1. Битрейт 24 кбит/с (≈ 43 с) или 16 кбит/с (≈ 62 с)? Константа одна на платформу, формат не меняется.
2. Лимит 140 КиБ остаётся (кадр relay); голосовые длиннее — отдельный этап (`files_v1` по DataChannel, §P2P v2), не в этом плане.

## 9. Длинные голосовые — TBD (транспорт исследуется)

Голосовые длиннее лимита 140 КиБ (≈ 43 с при 24 кбит/с) в этой версии протокола **не определены**. Транспорт (кандидат — `files_v1` по DataChannel, см. `PROTOCOL_P2P_V2.md`) исследуется отдельным этапом; формат файла (§2) и поле `wave` (§3) от него не зависят. До решения отправитель MUST останавливать запись по §2.4.
