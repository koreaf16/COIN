"""
LLM 하이브리드 클라이언트 — Qwen + DeepSeek API + CLI(Claude Opus / Gemini Pro)

라우팅:
  qwen     → Qwen 3.5 27B via Ollama (센티먼트, 검증)
  deepseek → DeepSeek API (unified_plan 전용)
  cloud    → Claude CLI (Opus 4.6) → Gemini CLI (3.1 Pro) → Qwen 폴백
"""
import asyncio
import json
import subprocess
import time
import shutil
import uuid
import httpx
from config import (
    DEEPSEEK_URL, DEEPSEEK_MODEL, DEEPSEEK_API_KEY,
    QWEN_URL, QWEN_MODEL,
    LLM_ROUTING,
)

# CLI 경로 자동 감지
_claude_cli = shutil.which("claude")
_gemini_cli = shutil.which("gemini")

# ── 활성 호출 트래커 ──
_active_calls: dict = {}

# 특정 task_type 강제 라우팅
_FORCE_ROUTES = {
    "unified_plan": "deepseek",
    "unified_plan_cloud": "cloud",
}


def _start_call(provider: str, task_type: str, prompt: str) -> str:
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


def _update_output(call_id: str, chunk: str):
    if call_id in _active_calls:
        _active_calls[call_id]["output"] += chunk


def _finish_call(call_id: str):
    if call_id in _active_calls:
        _active_calls[call_id]["status"] = "done"
        _active_calls[call_id]["finished_at"] = time.time()
    # 30초 이상 된 완료 호출 정리
    now = time.time()
    to_del = [k for k, v in list(_active_calls.items())
              if v["status"] == "done" and now - v.get("finished_at", now) > 30]
    for k in to_del:
        del _active_calls[k]


def get_active_calls() -> list:
    now = time.time()
    result = []
    for call in list(_active_calls.values()):
        result.append({**call, "elapsed_ms": int((now - call["started_at"]) * 1000)})
    return sorted(result, key=lambda x: x["started_at"], reverse=True)


async def generate(prompt: str, system: str = "You are a crypto trading analyst.",
                   max_tokens: int = 1000, task_type: str = "qwen"):
    """LLM 호출 (자동 라우팅). Returns: (text, ms, tokens)"""
    route = _FORCE_ROUTES.get(task_type) or LLM_ROUTING.get(task_type, task_type)

    if route == "qwen":
        provider = "qwen"
    elif route == "deepseek":
        provider = "deepseek"
    elif route == "cloud":
        if _claude_cli:
            provider = "claude"
        elif _gemini_cli:
            provider = "gemini"
        else:
            provider = "qwen"  # cloud 불가 시 Qwen 폴백
    else:
        provider = "qwen"

    call_id = _start_call(provider, task_type, prompt)
    print(f"[LLM-Track] START {call_id} provider={provider} task={task_type} prompt_len={len(prompt)}")
    try:
        if provider == "qwen":
            return await _generate_qwen(prompt, system, max_tokens, call_id)
        elif provider == "deepseek":
            return await _generate_deepseek(prompt, system, max_tokens, call_id)
        elif provider == "claude":
            return await _generate_cli("claude", prompt, system, call_id)
        elif provider == "gemini":
            return await _generate_cli("gemini", prompt, system, call_id)
        else:
            return await _generate_qwen(prompt, system, max_tokens, call_id)
    finally:
        print(f"[LLM-Track] DONE  {call_id} output_len={len(_active_calls.get(call_id, {}).get('output', ''))}")
        _finish_call(call_id)


async def _generate_cli(cli_name: str, prompt: str, system: str, call_id: str = None):
    """Claude CLI (Opus 4.6) 또는 Gemini CLI (3.1 Pro) — stdin pipe 방식"""
    start = time.monotonic()
    try:
        full_prompt = f"{system}\n\n{prompt}"

        import tempfile, os

        if cli_name == "claude":
            cmd = [_claude_cli, "--print", "--model", "claude-opus-4-6", "--effort", "max", "--output-format", "text"]
            cwd = None
            use_stdin = True
        else:
            # Gemini 3.1 Pro Preview
            cmd = [_gemini_cli, "-p", prompt, "-m", "gemini-3.1-pro-preview"]
            cwd = os.path.join(tempfile.gettempdir(), "_gemini_isolated")
            os.makedirs(cwd, exist_ok=True)
            use_stdin = False

        def _run_cli():
            return subprocess.run(
                cmd,
                input=full_prompt.encode("utf-8") if use_stdin else None,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=cwd,
                timeout=180,
            )

        proc = await asyncio.to_thread(_run_cli)

        text = proc.stdout.decode("utf-8", errors="replace").strip()
        ms = int((time.monotonic() - start) * 1000)

        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", errors="replace").strip()
            out = text[:200] if text else ""
            print(f"[LLM-CLI] {cli_name} error (rc={proc.returncode}): stderr={err[:200]} stdout={out}")
            return None, ms, 0

        if cli_name == "gemini" and text.startswith("Loaded cached"):
            text = text.split("\n", 1)[-1].strip()

        # 완료 후 output 업데이트
        if call_id:
            _update_output(call_id, text)

        print(f"[LLM-CLI] {cli_name} responded in {ms}ms ({len(text)} chars)")
        return text, ms, len(text) // 4

    except subprocess.TimeoutExpired:
        ms = int((time.monotonic() - start) * 1000)
        print(f"[LLM-CLI] {cli_name} timeout after {ms}ms")
        return None, ms, 0
    except Exception as e:
        ms = int((time.monotonic() - start) * 1000)
        print(f"[LLM-CLI] {cli_name} error: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return None, ms, 0


async def _generate_api(url: str, model: str, api_key: str,
                        prompt: str, system: str, max_tokens: int,
                        call_id: str = None, timeout_read: float = 120.0):
    """OpenAI-compatible API — SSE 스트리밍 (DeepSeek, Qwen/Ollama 공용)"""
    start = time.monotonic()
    collected = []
    reasoning_collected = []
    tokens = 0
    cache_info = {}
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=timeout_read)) as client:
            async with client.stream("POST", url, headers=headers, json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.1,
                "max_tokens": max_tokens,
                "stream": True,
            }) as resp:
                resp.raise_for_status()
                async for raw_line in resp.aiter_lines():
                    if not raw_line:
                        continue
                    line = raw_line[6:] if raw_line.startswith("data: ") else raw_line
                    if line.strip() == "[DONE]":
                        break
                    try:
                        chunk = json.loads(line)
                        choices = chunk.get("choices") or []
                        if choices:
                            delta = choices[0].get("delta", {})
                            content = delta.get("content") or ""
                            reasoning = delta.get("reasoning_content") or ""
                            if content:
                                collected.append(content)
                                if call_id:
                                    _update_output(call_id, content)
                            if reasoning:
                                reasoning_collected.append(reasoning)
                        usage = chunk.get("usage")
                        if usage:
                            tokens = usage.get("total_tokens", 0)
                            # DeepSeek 프리픽스 캐시 통계
                            hit = usage.get("prompt_cache_hit_tokens", 0)
                            miss = usage.get("prompt_cache_miss_tokens", 0)
                            if hit or miss:
                                cache_info = {"hit": hit, "miss": miss}
                    except (json.JSONDecodeError, IndexError, KeyError):
                        pass

        text = "".join(collected)
        # DeepSeek: content가 비었으면 reasoning_content 사용
        if not text and reasoning_collected:
            text = "".join(reasoning_collected)
            if call_id:
                _update_output(call_id, text)
        ms = int((time.monotonic() - start) * 1000)
        if cache_info:
            hit, miss = cache_info["hit"], cache_info["miss"]
            total = hit + miss
            pct = (hit / total * 100) if total else 0
            print(f"[LLM-Cache] {model}: {hit}/{total} tokens cached ({pct:.0f}%) - saved ~{hit * 0.5 / 1_000_000:.4f}$")
            if call_id and call_id in _active_calls:
                _active_calls[call_id]["cache"] = cache_info
        if call_id and not text:
            _update_output(call_id, "(스트리밍 응답 없음)")
        return text, ms, tokens
    except Exception as e:
        ms = int((time.monotonic() - start) * 1000)
        print(f"[LLM-API] {model} Error: {e}")
        if call_id:
            _update_output(call_id, f"[ERROR] {type(e).__name__}: {e}")
        return None, ms, 0


async def _generate_deepseek(prompt: str, system: str, max_tokens: int, call_id: str = None):
    """DeepSeek API (unified_plan 전용) — 시스템 프롬프트가 캐시 프리픽스 역할"""
    return await _generate_api(DEEPSEEK_URL, DEEPSEEK_MODEL, DEEPSEEK_API_KEY,
                               prompt, system, max_tokens, call_id, timeout_read=120.0)


async def _generate_qwen(prompt: str, system: str, max_tokens: int, call_id: str = None):
    """Qwen 3.5 27B via Ollama (센티먼트, 검증 등)"""
    return await _generate_api(QWEN_URL, QWEN_MODEL, "",
                               prompt, system, max_tokens, call_id, timeout_read=300.0)


def parse_json_response(text: str) -> dict:
    """LLM 응답에서 JSON 추출"""
    if not text:
        return {}
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
        brace_start = text.find("{")
        brace_end = text.rfind("}") + 1
        if brace_start >= 0 and brace_end > brace_start:
            try:
                return json.loads(text[brace_start:brace_end])
            except json.JSONDecodeError:
                pass
    return {}
