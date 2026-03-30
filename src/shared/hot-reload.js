/**
 * @module 핫 리로더
 * @description 프로세스 재시작 없이 런타임에 모듈을 동적으로 다시 로드한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ File     │ ──→ │ Hot      │ ──→ │ Updated  │
 * │ Watcher  │     │ Reloader │     │ Exports  │
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone shared
 * @dependencies logger.js, fs, url
 */
import { logger } from "./logger.js";
import { watch } from 'fs';
import { pathToFileURL } from 'url';

export class HotReloader {
  constructor() {
    this._modules = new Map();   // name → { path, exports, watcher }
    this._listeners = new Map(); // name → Set<callback>
  }

  /**
   * 모듈 등록 + 최초 로드 + 파일 감시 시작
   * @param {string} name - 모듈 식별자 (예: 'condition-evaluator')
   * @param {string} absPath - 절대 경로
   */
  async register(name, absPath) {
    try {
      const exports = await this._load(absPath);
      const entry = { path: absPath, exports, watcher: null };

      // fs.watch로 변경 감지 (debounce 500ms)
      let debounce = null;
      entry.watcher = watch(absPath, () => {
        if (debounce) return;
        debounce = setTimeout(async () => {
          debounce = null;
          try {
            entry.exports = await this._load(absPath);
            logger.info(`[HotReload] Reloaded: ${name}`);
            // 리스너 알림
            const cbs = this._listeners.get(name);
            if (cbs) for (const cb of cbs) cb(entry.exports);
          } catch (err) {
            logger.error(`[HotReload] Failed to reload ${name}:`, err.message);
          }
        }, 500);
      });

      this._modules.set(name, entry);
      logger.info(`[HotReload] Registered: ${name} → ${absPath}`);
      return exports;
    } catch (err) {
      logger.error(`[HotReload] Registration failed for ${name}:`, err.message);
      throw err;
    }
  }

  /** 현재 로드된 모듈의 exports 반환 */
  get(name) {
    const entry = this._modules.get(name);
    if (!entry) throw new Error(`[HotReload] Module not registered: ${name}`);
    return entry.exports;
  }

  /** 모듈 변경 시 콜백 등록 */
  onChange(name, callback) {
    if (!this._listeners.has(name)) this._listeners.set(name, new Set());
    this._listeners.get(name).add(callback);
  }

  async _load(absPath) {
    try {
      const url = pathToFileURL(absPath).href + `?t=${Date.now()}`;
      return import(url);
    } catch (err) {
      logger.error(`[HotReload] Load failed: ${absPath}`, err.message);
      throw err;
    }
  }

  stop() {
    for (const [name, entry] of this._modules) {
      if (entry.watcher) entry.watcher.close();
    }
    this._modules.clear();
    this._listeners.clear();
    logger.info('[HotReload] Stopped');
  }
}

/** 싱글턴 */
export const hotReloader = new HotReloader();
