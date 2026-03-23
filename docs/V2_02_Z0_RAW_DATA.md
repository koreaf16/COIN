# V2_02. Zone 0 (Raw Data) - 데이터 수집 및 메모리 버퍼

Z0 영역의 주 목적은 비동기적으로 쏟아지는 방대한 외부 데이터를 지연(Latency) 없이 시스템 내부에 수용하는 것입니다. DB I/O로 인한 락(Lock)이나 병목을 최소화합니다.

## 1. 실시간 호가 및 틱 수집 (고빈도)
*   **컴포넌트**: `FuturesWsConnector`, `RingBuffer`
*   **작동 방식**:
    *   바이낸스 Futures WebSocket에 연결하여 `aggTrade`(틱 체결), `kline`(1m, 5m, 1h 캔들), `depth`(호가창) 데이터를 수신합니다.
    *   **메모리 버퍼링**: 수신된 데이터는 DB가 아닌 `RingBuffer`(Circular Buffer 방식의 인메모리 스토어)에 즉시 덮어씌워집니다. 이는 Z3(Rule Engine)가 1초마다, Z3(Smart Exit)가 100ms마다 조회할 때 DB 쿼리 없이 **상수 시간(O(1))** 내에 데이터를 제공하기 위함입니다.
    *   정기적 DB 적재: `FuturesRawWriter`가 RingBuffer의 스냅샷을 백그라운드에서 주기적으로 DB에 일괄 Insert 합니다.

## 2. 파생 및 메타 지표 수집 (중빈도)
*   **컴포넌트**: `FuturesRestCollector`
*   **작동 방식**: 웹소켓으로 들어오지 않는 미결제약정(Open Interest), 펀딩비(Funding Rate), 롱/숏 비율 등을 REST API로 수집합니다. 

## 3. 외부 인텔리전스 수집 (저빈도)
*   **컴포넌트**: `NewsCollector`, `MacroCollector`, `FearGreedCollector`, `StablecoinCollector`, `OnchainCollector`(현재 API 제한으로 보류)
*   **작동 방식**: 
    *   CryptoPanic 등의 API를 통해 암호화폐 관련 영문 뉴스 수집.
    *   연준(Fed) 금리 발표, 경제 캘린더 등 매크로 지표 파싱.
    *   공포탐욕 지수 및 테더(USDT) 등 스테이블코인 유입량 모니터링.
    *   이 데이터들은 수집 후 Z2(LLM)가 브리핑을 작성할 때 핵심 컨텍스트(Context)로 주입됩니다.
