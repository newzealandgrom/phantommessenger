/**
 * Логгер приложения (X-08 / S10.8).
 *
 * Production: полный no-op для всех уровней. Дополнительно `vite.config.ts` при
 * сборке вырезает любые `console.*` и `debugger` (`esbuild.drop`), поэтому в
 * prod-бандле консольного вывода нет вовсе.
 * Dev: вывод в консоль через стрелки-обёртки (ссылки на `console.*` не
 * сохраняются, их тоже вырежет drop при сборке).
 *
 * Правило: прямые `console.*` в `src/` запрещены (eslint `no-console`), только `slog`.
 * В `slog` не передавать номера, SDP, ICE-кандидаты, IP, тексты сообщений, PIN.
 */

type LogFn = (...args: unknown[]) => void;
type LoggerLike = { log: LogFn; warn: LogFn; error: LogFn; debug: LogFn; info: LogFn };

const noop: LogFn = () => {};

/* eslint-disable no-console */
const devLogger: LoggerLike = {
  log: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
  debug: (...a) => console.debug(...a),
  info: (...a) => console.info(...a),
};
/* eslint-enable no-console */

const prodLogger: LoggerLike = { log: noop, warn: noop, error: noop, debug: noop, info: noop };

export const slog: LoggerLike = import.meta.env.PROD ? prodLogger : devLogger;
