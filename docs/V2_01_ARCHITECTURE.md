# V2_01. 5-Zone 아키텍처 개요

기존 L0~L3 파이프라인 구조를 대체하는 새로운 **5-Zone 아키텍처**는 느린 LLM의 판단 속도(초~분 단위)와 가상화폐 시장의 초고주파 변동성(밀리초 단위) 간의 간극을 해결하기 위해 고안되었습니다. 

시스템의 핵심 철학은 **"LLM은 지도를 그리고(Plan), 시스템은 기계적으로 방아쇠를 당기며(Execution), 청산은 다중 안전망(Smart Exit)으로 즉각 방어한다"** 입니다.

---

## 🏗️ 전체 아키텍처 다이어그램

```text
[ 외부 환경 ]
Binance (WS/REST), News API, Macro Data (Fed, etc.), Onchain

      ⬇
      
[ Zone 0 : Raw Data ] (수집 및 버퍼링)
- WS Connector (틱, 호가창) -> In-Memory RingBuffer 저장
- REST Collectors (펀딩비, OI 등) -> Oracle DB 적재

      ⬇
      
[ Zone 1 : Processed Data ] (정량화 및 임베딩)
- State Vector Builder: 시장 상태를 9차원 숫자로 변환 (15분 주기)
- Forward Return 역산 및 통계 엣지 도출

      ⬇
      
[ Zone 2 : Intelligence ] (느린 뇌: 전략 수립)
- LLM Scheduler (매 1분/10분)
- 브리핑 및 시나리오 분석 -> DB에 'Execution Plan (실행 계획)' JSON 저장

      ⬇
      
[ Zone 3 : Execution ] (빠른 손: 진입 및 청산)
- Rule Engine (1초 주기): RingBuffer 데이터와 Plan의 진입 조건 매칭
- Executor: 조건 충족 시 바이낸스 즉시 진입 및 리스크 점검 (Risk Gate)
- Smart Exit (100ms 주기): 7경로 멀티패스 실시간 청산(동적 ATR, 모멘텀 반전 등)

      ⬇
      
[ Zone 4 : Results ] (기록 및 최적화)
- PnL 기록, 거래 내역 추적, 과거 벡터 데이터 레이블링 업데이트
```

---

## 🎯 Zone별 핵심 역할

1. **Z0 (수집층)**: 데이터 병목을 제거합니다. 웹소켓으로 들어오는 무거운 틱 데이터는 디스크(DB)에 바로 쓰지 않고 초고속 메모리 `RingBuffer`에만 유지하여 Z3의 접근 지연을 0에 가깝게 만듭니다.
2. **Z1 (가공층)**: 코사인 유사도 검색을 위한 오라클 Vector DB용 데이터를 만듭니다. 숫자와 텍스트를 철저히 분리하여, 지표는 9차원 Float64 배열로 가공합니다.
3. **Z2 (지능층)**: 시장의 방향성을 예측합니다. 실시간 차트를 보는 대신, 큰 흐름을 읽고 "어떤 조건이 오면 사라"는 '함정(Trap)'을 설계합니다.
4. **Z3 (실행층)**: 감정이 배제된 기계적 영역입니다. 1초 단위로 조건을 감시하고, 0.1초 단위로 손실을 방어합니다.
5. **Z4 (결과층)**: 시스템의 성과를 기록하고 향후 LLM 프롬프트 및 벡터 검색의 피드백 루프로 활용됩니다.
