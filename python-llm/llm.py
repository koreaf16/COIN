"""
LLM 하이브리드 클라이언트 — 로컬(Ollama) + CLI(Claude Opus / Gemini Pro)

라우팅:
  local  → Ollama Qwen3.5-27B (빈번 호출: 센티먼트, 검증)
  cloud  → Claude CLI (Opus 4.6) → Gemini CLI (3.1 Pro) → 로컬 폴백
"""
import asyncio
import json
import subprocess
import time
import shutil
import httpx
from config import OLLAMA_URL, LLM_MODEL, LLM_ROUTING

# CLI 경로 자동 감지
_claude_cli = shutil.which("claude")
_gemini_cli = shutil.which("gemini")


async def generate(prompt: str, system: str = "You are a crypto trading analyst.",
                   max_tokens: int = 1000, task_type: str = "local"):
    """LLM 호출 (자동 라우팅). Returns: (text, ms, tokens)"""
    route = LLM_ROUTING.get(task_type, task_type)

    if route == "local":
        return await _generate_local(prompt, system, max_tokens)
    elif route == "cloud":
        if _claude_cli:
            return await _generate_cli("claude", prompt, system)
        elif _gemini_cli:
            return await _generate_cli("gemini", prompt, system)
        else:
            print("[LLM] No CLI available, falling back to local")
            return await _generate_local(prompt, system, max_tokens)
    else:
        return await _generate_local(prompt, system, max_tokens)


async def _generate_cli(cli_name: str, prompt: str, system: str):
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
            # Gemini 3.1 Pro Preview — 역할 지시 없이 질문만 (역할 지시하면 acknowledge만 함)
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

        # Gemini 출력 정리
        if cli_name == "gemini" and text.startswith("Loaded cached"):
            text = text.split("\n", 1)[-1].strip()

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


async def _generate_local(prompt: str, system: str, max_tokens: int):
    """Ollama (OpenAI-compatible API)"""
    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(OLLAMA_URL, json={
                "model": LLM_MODEL,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.1,
                "max_tokens": max_tokens,
            })
            resp.raise_for_status()
            data = resp.json()
            text = data["choices"][0]["message"]["content"]
            tokens = data.get("usage", {}).get("total_tokens", 0)
            ms = int((time.monotonic() - start) * 1000)
            return text, ms, tokens
    except Exception as e:
        ms = int((time.monotonic() - start) * 1000)
        print(f"[LLM-Local] Error: {e}")
        return None, ms, 0


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
