/**
 * @module 환경 변수 확인
 * @description 주요 API 키 설정 상태를 확인한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Config   │ ──→ │ Env      │ ──→ │ Logger   │
 * │          │     │ Checker  │     │ Output   │
 * └──────────┘     └──────────┘     └──────────┘
 *
 * @zone scripts/check
 * @dependencies config.js, logger.js
 */
import { logger } from "../../src/shared/logger.js";
import { config } from '../../src/shared/config.js';

logger.info(`Coinglass API Key present: ${!!config.coinglass?.apiKey}`);
logger.info(`CryptoQuant API Key present: ${!!config.cryptoquant?.apiKey}`);
