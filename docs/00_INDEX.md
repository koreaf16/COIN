# COIN 문서 인덱스

현재 저장소는 `5-Zone` 구조를 기준으로 동작한다.
LLM은 `계획(Plan)`을 만들고, 실행 엔진은 그 계획을 기계적으로 집행하며, 결과 기록과 회고는 별도 존에서 처리한다.

모든 문서는 `UTF-8` 기준으로 유지한다.

## 빠른 시작

- [01_ARCHITECTURE.md](./01_ARCHITECTURE.md): 전체 5-Zone 구조와 주요 데이터 흐름
- [04_Z2_INTELLIGENCE.md](./04_Z2_INTELLIGENCE.md): LLM 스케줄러, 스냅샷, 검증, 실행 계획 저장
- [05_Z3_EXECUTION.md](./05_Z3_EXECUTION.md): Rule Engine, Risk Gate, Executor, 모니터링 API
- [06_Z3_SMART_EXIT.md](./06_Z3_SMART_EXIT.md): Smart Exit, 부분 청산, 무효화 검증
- [07_Z4_RESULTS_AND_DB.md](./07_Z4_RESULTS_AND_DB.md): 거래 기록, 성과 추적, 부분 청산 누적 반영
- [08_DB_SCHEMA.md](./08_DB_SCHEMA.md): Oracle 23c 스키마와 핵심 테이블 요약

## 데이터 파이프라인

- [02_Z0_RAW_DATA.md](./02_Z0_RAW_DATA.md): 실시간 원천 데이터 수집과 RingBuffer
- [03_Z1_PROCESSED.md](./03_Z1_PROCESSED.md): 가공 지표, 상태 벡터, 유사 상태 검색

## 스윙매매 기준 문서

- [09_CRYPTO_SWING_TRADING_GUIDE.md](./09_CRYPTO_SWING_TRADING_GUIDE.md): 스윙매매 원칙과 테크닉 정리
- [10_SWING_GUIDE_IMPLEMENTATION_CHECKLIST.md](./10_SWING_GUIDE_IMPLEMENTATION_CHECKLIST.md): 가이드 대비 시스템 반영 현황

## 현재 반영된 핵심 포인트

- `1d -> 4h -> 1h` 구조 필드가 `LLM 스냅샷`, `프롬프트`, `저장 전 검증`, `Rule Engine`에 연결됨
- `손절폭 기반 포지션 사이징`이 Risk Gate에 반영됨
- 진입 성공 시 플랜이 `TRIGGERED`로 소모됨
- `PARTIAL_EXIT`가 DB와 누적 손익 기록에 반영됨
- 운영 API가 `구조 요약(structure)`을 `plans`, `plans/status`, `positions/live`, `dashboard`에 노출함
