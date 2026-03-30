/**
 * @module 로거
 * @description 시스템 전체에서 사용하는 표준 로깅 모듈. ISO 타임스탬프와 레벨을 포함한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Modules  │ ──→ │ Logger   │ ──→ │ Console  │
 * │          │     │ (Shared) │     │ (stdout) │
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone shared
 * @dependencies none
 */
export const logger = {
  info: (msg, ...args) => {
    console.log(`[${new Date().toISOString()}] INFO: ${msg}`, ...args);
  },
  warn: (msg, ...args) => {
    console.warn(`[${new Date().toISOString()}] WARN: ${msg}`, ...args);
  },
  error: (msg, ...args) => {
    console.error(`[${new Date().toISOString()}] ERROR: ${msg}`, ...args);
  },
  debug: (msg, ...args) => {
    if (process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true') {
      console.debug(`[${new Date().toISOString()}] DEBUG: ${msg}`, ...args);
    }
  }
};
