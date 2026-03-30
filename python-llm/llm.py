"""Ollama-only LLM wrapper for COIN."""

import asyncio
import json
import logging
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

from config import LOCAL_LLM_MODEL, LOCAL_LLM_TIMEOUT_SEC, LOCAL_LLM_URL
from llm_tracker import start_call, update_output, record_error, finish_call, get_active_calls, _active_calls

logger = logging.getLogger(__name__)


def _record_empty_output(call_id: str, provider: str, task_type: str) -> None:
    record_error(call_id, f"empty response from {provider} for {task_type}")


def _probe_ollama_endpoint() -> bool:
    if not LOCAL_LLM_URL:
        return False
    try:
        with httpx.Client(timeout=0.75, follow_redirects=False) as client:
            resp = client.post(
                LOCAL_LLM_URL,
                json={
                    "model": "probe",
                    "messages": [{"role": "user", "content": "ping"}],
                    "max_tokens": 1,
                    "stream": False,
                },
            )
            return resp is not None
    except Exception:
        return False


_OLLAMA_AVAILABLE = _probe_ollama_endpoint()


async def generate(
    prompt: str,
    system: str = "Analyze market data and output JSON.",
    max_tokens: int = 1000,
    task_type: str = "local",
    route_override: Optional[str] = None,
) -> Tuple[Optional[str], int, int]:
    """Generate a response using Ollama only."""
    del route_override
    provider = "ollama"
    call_id = start_call(provider, task_type, prompt)
    logger.info(f"[LLM-Track] START {call_id} provider={provider} task={task_type} chars={len(prompt)}")

    try:
        if not _OLLAMA_AVAILABLE:
            logger.warning("[LLM] Ollama endpoint unavailable; skipping network call")
            _record_empty_output(call_id, provider, task_type)
            return None, 0, 0
        if task_type == "sentiment":
            text, ms, tokens = await _generate_ollama_json(prompt, system, max_tokens, call_id)
        else:
            text, ms, tokens = await _generate_ollama_stream(prompt, system, max_tokens, task_type, call_id)
        return text, ms, tokens
    finally:
        output_len = len(_active_calls.get(call_id, {}).get("output", ""))
        logger.info(f"[LLM-Track] DONE {call_id} output_len={output_len}")
        finish_call(call_id)


async def _generate_ollama_json(
    prompt: str,
    system: str,
    max_tokens: int,
    call_id: str,
) -> Tuple[Optional[str], int, int]:
    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=LOCAL_LLM_TIMEOUT_SEC) as client:
            resp = await client.post(
                LOCAL_LLM_URL,
                json={
                    "model": LOCAL_LLM_MODEL,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": prompt},
                    ],
                    "max_tokens": max_tokens,
                    "stream": False,
                    "response_format": {"type": "json_object"},
                },
            )
            if resp.status_code >= 400:
                resp = await client.post(
                    LOCAL_LLM_URL,
                    json={
                        "model": LOCAL_LLM_MODEL,
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": prompt},
                        ],
                        "max_tokens": max_tokens,
                        "stream": False,
                    },
                )
            resp.raise_for_status()
            data = resp.json()

        text = ""
        choices = data.get("choices") or []
        if choices:
            message = choices[0].get("message") or {}
            text = (message.get("content") or "").strip()
            if not text:
                text = (
                    message.get("reasoning_content", "")
                    or message.get("thinking", "")
                    or message.get("reasoning", "")
                    or ""
                ).strip()
        if text:
            update_output(call_id, text)
        ms = int((time.monotonic() - start) * 1000)
        if not text:
            _record_empty_output(call_id, "ollama", "sentiment")
        return text, ms, len(text) // 4
    except Exception as e:
        logger.warning(f"[LLM-Ollama] JSON mode failed for sentiment: {e}")
        return await _generate_ollama_stream(prompt, system, max_tokens, "sentiment", call_id)


async def _generate_ollama_stream(
    prompt: str,
    system: str,
    max_tokens: int,
    task_type: str,
    call_id: str,
) -> Tuple[Optional[str], int, int]:
    start = time.monotonic()
    collected: List[str] = []
    thinking: List[str] = []

    try:
        async with httpx.AsyncClient(timeout=LOCAL_LLM_TIMEOUT_SEC) as client:
            async with client.stream(
                "POST",
                LOCAL_LLM_URL,
                json={
                    "model": LOCAL_LLM_MODEL,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": prompt},
                    ],
                    "max_tokens": max_tokens,
                    "stream": True,
                },
            ) as resp:
                resp.raise_for_status()
                async for raw_line in resp.aiter_lines():
                    line = (raw_line or "").strip()
                    if not line:
                        continue
                    if line.startswith("data: "):
                        payload = line[6:].strip()
                        if payload == "[DONE]":
                            break
                    else:
                        payload = line
                    try:
                        chunk = json.loads(payload)
                    except json.JSONDecodeError:
                        logger.warning(f"[LLM-Ollama] JSON decode failed for line: {line[:200]}")
                        continue

                    choices = chunk.get("choices") or []
                    if choices:
                        delta = choices[0].get("delta") or choices[0].get("message") or {}
                        content = delta.get("content", "")
                        if content:
                            collected.append(content)
                            update_output(call_id, content)
                        reasoning = (
                            delta.get("reasoning_content", "")
                            or delta.get("thinking", "")
                            or delta.get("reasoning", "")
                            or ""
                        )
                        if reasoning:
                            thinking.append(reasoning)
                        continue

                    message = chunk.get("message") or {}
                    content = message.get("content", "")
                    if content:
                        collected.append(content)
                        update_output(call_id, content)
                    reasoning = (
                        message.get("reasoning_content", "")
                        or message.get("thinking", "")
                        or message.get("reasoning", "")
                        or ""
                    )
                    if reasoning:
                        thinking.append(reasoning)

        text = "".join(collected).strip()
        if not text and thinking:
            text = "".join(thinking).strip()
            if text:
                update_output(call_id, text)
        ms = int((time.monotonic() - start) * 1000)
        if not text:
            _record_empty_output(call_id, "ollama", task_type)
        return text, ms, len(text) // 4
    except Exception as e:
        logger.error(f"[LLM-Ollama] Error: {e}")
        _record_empty_output(call_id, "ollama", task_type)
        return None, 0, 0
