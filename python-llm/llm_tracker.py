"""
@module LLM Call Tracker
@description LLM 호출 상태를 추적하고 현재 진행 중인 호출의 메타데이터를 관리한다.

┌──────────┐     ┌──────────┐     ┌──────────┐
│ Generate │ ──→ │ Tracker  │ ──→ │ Response │
│ Call     │     │ State    │     │ Stream   │
└──────────┘     └──────────┘     └──────────┘

@dependencies uuid, time, typing
"""
import uuid
import time
from typing import Dict, List, Any, Optional

# 활성 호출 트래커
_active_calls: Dict[str, Any] = {}

def start_call(provider: str, task_type: str, prompt: str) -> str:
    """새로운 LLM 호출을 트래커에 등록한다."""
    call_id = str(uuid.uuid4())[:8]
    _active_calls[call_id] = {
        "id": call_id,
        "provider": provider,
        "task_type": task_type,
        "prompt": prompt,
        "output": "",
        "started_at": time.time(),
        "status": "running",
    }
    return call_id

def update_output(call_id: str, chunk: str) -> None:
    """진행 중인 호출의 출력을 실시간으로 업데이트한다."""
    if call_id in _active_calls:
        _active_calls[call_id]["output"] += chunk

def record_error(call_id: Optional[str], detail: str) -> None:
    """호출 중 발생한 에러를 기록한다."""
    if call_id:
        update_output(call_id, f"[ERROR] {detail}")

def finish_call(call_id: str) -> None:
    """호출 완료 처리를 수행하고 오래된 로그를 정리한다."""
    if call_id in _active_calls:
        _active_calls[call_id]["status"] = "done"
        _active_calls[call_id]["finished_at"] = time.time()

    # 30초 이상 지난 완료된 호출 정리
    now = time.time()
    to_delete = [
        key
        for key, value in list(_active_calls.items())
        if value["status"] == "done" and now - value.get("finished_at", now) > 30
    ]
    for key in to_delete:
        del _active_calls[key]

def get_active_calls() -> List[Dict[str, Any]]:
    """현재 활성화된 모든 호출 정보를 반환한다."""
    now = time.time()
    result = []
    for call in list(_active_calls.values()):
        result.append({**call, "elapsed_ms": int((now - call["started_at"]) * 1000)})
    return sorted(result, key=lambda item: item["started_at"], reverse=True)
