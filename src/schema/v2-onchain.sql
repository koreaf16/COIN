-- Z0: 온체인 데이터 테이블
CREATE TABLE z0_onchain (
    symbol           VARCHAR2(20)  NOT NULL,
    ts               TIMESTAMP     NOT NULL,
    exchange_inflow  NUMBER,           -- 거래소 유입량
    exchange_outflow NUMBER,           -- 거래소 유출량
    net_flow         NUMBER,           -- 순유출 (outflow - inflow, 양수=유출=매집)
    exchange_reserve NUMBER,           -- 거래소 보유량
    whale_ratio      NUMBER,           -- 고래 비율 (상위 10 입금/전체)
    stablecoin_supply NUMBER,          -- 스테이블코인 총 공급량
    mpi              NUMBER,           -- Miners Position Index
    source           VARCHAR2(20) DEFAULT 'cryptoquant',
    CONSTRAINT pk_z0_onchain PRIMARY KEY (symbol, ts)
);
