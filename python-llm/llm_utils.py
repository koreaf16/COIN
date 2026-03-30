"""
@module LLM Utilities
@description LLM 호출을 위한 공통 유틸리티 함수(JSON 파싱, CLI 경로 확인 등)를 제공한다.

@dependencies os, shutil, json, typing
"""
import os
import shutil
import json
import re
from typing import Dict, Any, Optional
from config import TASK_REASONING_EFFORT, LOCAL_LLM_REASONING_EFFORT

def resolve_cli(command: str) -> Optional[str]:
    """시스템에서 실행 가능한 CLI 명령어 경로를 찾는다."""
    if not command:
        return None
    resolved = shutil.which(command)
    if resolved:
        return resolved
    return command if os.path.exists(command) else None

def get_effort(task_type: str) -> str:
    """작업 유형별 최적의 reasoning effort 값을 반환한다."""
    return TASK_REASONING_EFFORT.get(task_type, LOCAL_LLM_REASONING_EFFORT)

def parse_json_response(text: str) -> Dict[str, Any]:
    """LLM 응답 문자열에서 JSON 데이터를 추출하고 파싱한다."""
    if not text:
        return {}
        
    # Qwen3 think stream 제거 — <think>...</think> 블록 제거
    if "<think>" in text:
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
        
    # 코드 블록 제거
    for start_marker in ["```json", "```"]:
        if start_marker in text:
            start = text.index(start_marker) + len(start_marker)
            end_pos = text.find("```", start)
            end = end_pos if end_pos >= 0 else len(text)
            text = text[start:end].strip()
            break
            
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # 중괄호 범위를 찾아서 재시도
        brace_start = text.find("{")
        brace_end = text.rfind("}") + 1
        if brace_start >= 0 and brace_end > brace_start:
            try:
                return json.loads(text[brace_start:brace_end])
            except json.JSONDecodeError:
                pass
    return {}


def extract_selected_id(text: str, parsed: Optional[Dict[str, Any]] = None) -> str:
    """Select-only LLM output에서 selected_id만 안전하게 추출한다."""
    if isinstance(parsed, dict):
        selected_id = parsed.get("selected_id")
        if isinstance(selected_id, str) and selected_id.strip():
            return selected_id.strip()

    if not text:
        return ""

    if "<think>" in text:
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

    match = re.search(r'"selected_id"\s*:\s*"([^"]*)"', text)
    if match:
        return match.group(1).strip()

    match = re.search(r"selected_id\s*:\s*\"?([A-Za-z0-9_:-]*)\"?", text)
    if match:
        return match.group(1).strip()

    return ""
