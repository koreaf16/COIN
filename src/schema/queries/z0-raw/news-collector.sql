-- name: insertNews
INSERT INTO z0_news_raw (ts, source, title, content, tickers, url)
VALUES (:ts, :source, :title, :content, :tickers, :url)
