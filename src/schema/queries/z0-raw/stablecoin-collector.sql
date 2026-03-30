-- name: insertStablecoinSupply
INSERT INTO z0_stablecoin_supply (
  ts, 
  usdt_mcap, 
  usdc_mcap, 
  total_mcap, 
  usdt_change_24h, 
  usdc_change_24h
) VALUES (
  SYSTIMESTAMP, 
  :usdt, 
  :usdc, 
  :total, 
  :usdtChg, 
  :usdcChg
)
