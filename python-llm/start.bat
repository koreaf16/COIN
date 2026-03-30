@echo off
echo === COIN LLM Server ===
cd /d %~dp0
py -3 -m pip install -r requirements.txt -q
py -3 -m uvicorn main:app --host 0.0.0.0 --port 2002 --reload
