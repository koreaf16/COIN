@echo off
echo === COIN LLM Server (port 2002) ===
cd /d %~dp0\python-llm
pip install -r requirements.txt -q
uvicorn main:app --host 0.0.0.0 --port 2002 --reload
