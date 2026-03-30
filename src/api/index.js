/**
 * @module API Server
 * @description 대시보드 UI를 위한 REST API 및 WebSocket 서버를 관리한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Dashboard│ ──→ │ Fastify  │ ──→ │ Oracle   │
 * │ (Next.js)│ ←── │ Server   │ ←── │ DB       │
 * └──────────┘     └──────────┘     └──────────┘
 *                       ↑
 *                WebSocket (Live)
 *
 * @zone api
 * @dependencies routes-trading.js, routes-market.js, routes-system.js, logger.js, config.js
 */

import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import { logger } from "../shared/logger.js";
import { config } from '../shared/config.js';

// Route Plugins
import tradingRoutes from './routes-trading.js';
import marketRoutes from './routes-market.js';
import systemRoutes from './routes-system.js';

export class ApiServer {
  /**
   * @param {Object} opts Server options
   */
  constructor(opts = {}) {
    this.port = opts.port || 2001;
    this.ringBuffer = opts.ringBuffer;
    this.ruleEngine = opts.ruleEngine;
    this.executor = opts.executor;
    this.macroCollector = opts.macroCollector;

    this.app = Fastify({ logger: false });
    this.wsClients = new Set();
    this._logBuffer = [];
    this._setupLogBuffer();
  }

  /**
   * 최근 로그 200줄을 메모리에 보관하여 API로 제공한다.
   * @private
   */
  _setupLogBuffer() {
    const origLog = logger.info;
    const origErr = logger.error;
    const origWarn = logger.warn;

    const pushLog = (level, args) => {
      try {
        const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
        this._logBuffer.push({ ts: new Date().toISOString(), level, msg });
        if (this._logBuffer.length > 200) {
          this._logBuffer.shift();
        }
      } catch (err) {
        // fail-safe
      }
    };

    logger.info = (...args) => { pushLog('info', args); origLog.apply(logger, args); };
    logger.error = (...args) => { pushLog('error', args); origErr.apply(logger, args); };
    logger.warn = (...args) => { pushLog('warn', args); origWarn.apply(logger, args); };
  }

  /**
   * 서버를 시작하고 라우트를 등록한다.
   */
  async start() {
    try {
      await this.app.register(websocketPlugin);

      // WebSocket Endpoint
      this.app.get('/ws/live', { websocket: true }, (socket) => {
        this.wsClients.add(socket);
        socket.on('close', () => this.wsClients.delete(socket));
        socket.on('error', () => this.wsClients.delete(socket));
      });

      // Register Route Plugins
      const routeOptions = { server: this };
      await this.app.register(tradingRoutes, routeOptions);
      await this.app.register(marketRoutes, routeOptions);
      await this.app.register(systemRoutes, routeOptions);

      await this.app.listen({ port: this.port, host: '0.0.0.0' });
      logger.info(`[API] Server listening on http://0.0.0.0:${this.port}`);
    } catch (err) {
      logger.error(`[API] Failed to start server: ${err.message}`);
      throw err;
    }
  }

  /**
   * 모든 WebSocket 클라이언트에 메시지를 브로드캐스트한다.
   * @param {Object} msg JSON serializable message
   */
  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const client of this.wsClients) {
      try {
        client.send(data);
      } catch (err) {
        this.wsClients.delete(client);
      }
    }
  }

  /**
   * 서버를 중지한다.
   */
  async stop() {
    try {
      await this.app.close();
      logger.info('[API] Server stopped');
    } catch (err) {
      logger.error(`[API] Error during stop: ${err.message}`);
    }
  }
}
