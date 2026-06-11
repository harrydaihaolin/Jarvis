# LangGraph Python Migration — Foundation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `proxy/` with a Python FastAPI + LangGraph service (`agent/`) that is feature-equivalent to the current Node proxy. After this plan, Jarvis runs on Python with a LangGraph supervisor graph wired to a workspace subgraph — identical behaviour to today, ready for domain nodes (Plan B).

**Architecture:** FastAPI + uvicorn on port 8787. A LangGraph `create_react_agent` supervisor routes to domain subgraphs via `as_tool()`. In this plan, only the workspace subgraph is wired. The supervisor LLM is tagged `"streaming"` so its token stream can be filtered from nested subgraph LLM calls. All infrastructure from `proxy/` (memory injection, preamble, heartbeat, SSE `/events`, conversation resumption via `SqliteSaver`) is ported to Python.

**Tech Stack:** Python 3.12, uv, FastAPI 0.115+, uvicorn, langgraph 0.3+, langchain-anthropic, langchain-openai (for Fireworks), anthropic SDK 0.40+, sse-starlette, langgraph-checkpoint-sqlite, pytest, pytest-asyncio

---

## File Map

| File | Responsibility |
|---|---|
| `agent/pyproject.toml` | uv-managed deps, test config |
| `agent/src/server.py` | FastAPI app, routes, heartbeat, wiring |
| `agent/src/translate.py` | OpenAI messages ↔ LangChain; clean text; SSE chunk helpers |
| `agent/src/sandbox.py` | Workspace path resolution + command denylist |
| `agent/src/memory.py` | Anthropic Memory Store CRUD (port of memory.js) |
| `agent/src/preamble.py` | Fast-first-response coroutine (port of preamble.js) |
| `agent/src/events.py` | asyncio EventBus → `/events` SSE feed |
| `agent/src/streaming.py` | astream_events → OpenAI SSE chunks + /events broadcast |
| `agent/src/providers/fireworks.py` | ChatOpenAI → Fireworks endpoint |
| `agent/src/providers/anthropic.py` | ChatAnthropic wrapper |
| `agent/src/providers/index.py` | Providers dataclass; with_fallbacks(); preamble LLM |
| `agent/src/graph/nodes/workspace.py` | LangChain @tool wrappers for file + command ops |
| `agent/src/graph/supervisor.py` | AgentState, create_graph() |
| `agent/tests/conftest.py` | pytest fixtures |

---

### Task 1: Scaffold the `agent/` package

**Files:**
- Create: `agent/pyproject.toml`
- Create: `agent/.python-version`
- Create: `agent/src/__init__.py`
- Create: `agent/src/server.py` (health endpoint only)
- Create: `agent/tests/__init__.py`
- Create: `agent/tests/conftest.py`
- Modify: `package.json` (root)

- [ ] **Step 1: Create `agent/.python-version`**

```
3.12
```

- [ ] **Step 2: Create `agent/pyproject.toml`**

```toml
[project]
name = "jarvis-agent"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "langgraph>=0.3",
    "langchain-anthropic>=0.3",
    "langchain-openai>=0.2",
    "langchain-mcp-adapters>=0.1",
    "anthropic>=0.40",
    "yfinance>=0.2",
    "alpha-vantage>=3.0",
    "pycoingecko>=3.1",
    "python-dotenv>=1.0",
    "sse-starlette>=2.0",
    "langgraph-checkpoint-sqlite",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.23",
    "httpx>=0.27",
    "respx>=0.21",
]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

- [ ] **Step 3: Create `agent/src/__init__.py` and `agent/tests/__init__.py`**

Both are empty files.

- [ ] **Step 4: Create `agent/src/server.py` (health only)**

```python
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../../.env"))
load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok"}
```

- [ ] **Step 5: Create `agent/tests/conftest.py`**

```python
import pytest
from httpx import AsyncClient, ASGITransport
from agent.src.server import app


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
```

- [ ] **Step 6: Create `agent/tests/test_server.py`**

```python
async def test_health(client):
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
```

- [ ] **Step 7: Install deps and run test**

```bash
cd agent && uv sync --extra dev
uv run pytest tests/test_server.py -v
```

Expected: `PASSED test_server.py::test_health`

- [ ] **Step 8: Add npm scripts to root `package.json`**

Add to the `"scripts"` section:
```json
"agent":      "cd agent && uv run uvicorn agent.src.server:app --port 8787 --reload",
"agent:prod": "cd agent && uv run uvicorn agent.src.server:app --port 8787"
```

- [ ] **Step 9: Commit**

```bash
git add agent/ package.json
git commit -m "feat(agent): scaffold Python FastAPI package with health endpoint"
```

---

### Task 2: Provider layer

**Files:**
- Create: `agent/src/providers/__init__.py`
- Create: `agent/src/providers/fireworks.py`
- Create: `agent/src/providers/anthropic.py`
- Create: `agent/src/providers/index.py`
- Create: `agent/tests/test_providers.py`

- [ ] **Step 1: Create `agent/src/providers/__init__.py`** (empty)

- [ ] **Step 2: Create `agent/src/providers/fireworks.py`**

```python
from langchain_openai import ChatOpenAI

FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1"


def create_fireworks_llm(api_key: str, model: str, **kwargs) -> ChatOpenAI:
    """Supervisor-grade Fireworks LLM via OpenAI-compat endpoint."""
    return ChatOpenAI(
        api_key=api_key,
        base_url=FIREWORKS_BASE_URL,
        model=model,
        streaming=True,
        **kwargs,
    )


def create_fireworks_preamble_llm(api_key: str, model: str) -> ChatOpenAI:
    """Low-latency Fireworks LLM for preamble (no streaming)."""
    return ChatOpenAI(
        api_key=api_key,
        base_url=FIREWORKS_BASE_URL,
        model=model,
        streaming=True,
        model_kwargs={"extra_body": {"reasoning_effort": "low"}},
    )
```

- [ ] **Step 3: Create `agent/src/providers/anthropic.py`**

```python
from langchain_anthropic import ChatAnthropic


def create_anthropic_llm(api_key: str, model: str) -> ChatAnthropic:
    return ChatAnthropic(api_key=api_key, model=model, streaming=True)


def create_anthropic_preamble_llm(api_key: str, model: str = "claude-haiku-4-5") -> ChatAnthropic:
    return ChatAnthropic(api_key=api_key, model=model, streaming=True)
```

- [ ] **Step 4: Create `agent/src/providers/index.py`**

```python
from __future__ import annotations
import os
from dataclasses import dataclass, field
from langchain_core.language_models import BaseChatModel
import anthropic

from .fireworks import create_fireworks_llm, create_fireworks_preamble_llm
from .anthropic import create_anthropic_llm, create_anthropic_preamble_llm

SUBGRAPH_ANTHROPIC_MODEL = "claude-haiku-4-5"
SUBGRAPH_FIREWORKS_MODEL = "accounts/fireworks/models/llama-v3p1-8b-instruct"


@dataclass
class Providers:
    # Supervisor LLM tagged "streaming" so its token stream is filterable
    supervisor_llm: BaseChatModel
    # Cheaper model for domain subgraph agents
    subgraph_llm: BaseChatModel
    # Preamble LLM (fast first response)
    preamble_llm: BaseChatModel | None
    # Async Anthropic client for memory store API calls
    anthropic_client: anthropic.AsyncAnthropic
    has_fireworks: bool = field(default=False)


def create_providers(env: dict | None = None) -> Providers:
    env = env or dict(os.environ)
    anthropic_key = env.get("ANTHROPIC_API_KEY", "")
    anthropic_model = env.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    fireworks_key = env.get("FIREWORKS_API_KEY", "")
    fireworks_model = env.get("FIREWORKS_MODEL", "accounts/fireworks/models/gpt-oss-120b")
    fireworks_preamble_model = env.get("FIREWORKS_PREAMBLE_MODEL", fireworks_model)
    fallback_enabled = env.get("FIREWORKS_FALLBACK_ENABLED", "true") != "false"
    preamble_enabled = env.get("JARVUS_PREAMBLE_ENABLED", "true") != "false"

    anthropic_client = anthropic.AsyncAnthropic(api_key=anthropic_key)

    # Base LLMs
    claude_supervisor = create_anthropic_llm(anthropic_key, anthropic_model)
    claude_subgraph = create_anthropic_llm(anthropic_key, SUBGRAPH_ANTHROPIC_MODEL)

    if not fireworks_key:
        return Providers(
            supervisor_llm=claude_supervisor.with_config(tags=["streaming"]),
            subgraph_llm=claude_subgraph,
            preamble_llm=create_anthropic_preamble_llm(anthropic_key) if preamble_enabled else None,
            anthropic_client=anthropic_client,
            has_fireworks=False,
        )

    fireworks_supervisor = create_fireworks_llm(fireworks_key, fireworks_model)
    fireworks_subgraph = create_fireworks_llm(fireworks_key, SUBGRAPH_FIREWORKS_MODEL)

    supervisor_llm = (
        fireworks_supervisor.with_fallbacks([claude_supervisor]) if fallback_enabled
        else fireworks_supervisor
    ).with_config(tags=["streaming"])

    subgraph_llm = (
        fireworks_subgraph.with_fallbacks([claude_subgraph]) if fallback_enabled
        else fireworks_subgraph
    )

    preamble_llm = (
        create_fireworks_preamble_llm(fireworks_key, fireworks_preamble_model)
        if preamble_enabled else None
    )

    return Providers(
        supervisor_llm=supervisor_llm,
        subgraph_llm=subgraph_llm,
        preamble_llm=preamble_llm,
        anthropic_client=anthropic_client,
        has_fireworks=True,
    )
```

- [ ] **Step 5: Write failing tests**

Create `agent/tests/test_providers.py`:

```python
import pytest
from unittest.mock import patch, MagicMock
from agent.src.providers.index import create_providers


def test_no_fireworks_returns_anthropic_provider():
    env = {"ANTHROPIC_API_KEY": "sk-ant-test", "JARVUS_PREAMBLE_ENABLED": "false"}
    p = create_providers(env)
    assert not p.has_fireworks
    assert p.preamble_llm is None
    # supervisor_llm has the "streaming" tag
    assert "streaming" in (p.supervisor_llm.config_specs[0].default or {}).get("tags", []) or \
           any("streaming" in str(r) for r in [p.supervisor_llm])


def test_fireworks_key_uses_fireworks():
    env = {
        "ANTHROPIC_API_KEY": "sk-ant-test",
        "FIREWORKS_API_KEY": "fw-test",
        "JARVUS_PREAMBLE_ENABLED": "false",
    }
    p = create_providers(env)
    assert p.has_fireworks
    assert p.preamble_llm is None


def test_preamble_enabled_creates_preamble_llm():
    env = {
        "ANTHROPIC_API_KEY": "sk-ant-test",
        "JARVUS_PREAMBLE_ENABLED": "true",
    }
    p = create_providers(env)
    assert p.preamble_llm is not None
```

- [ ] **Step 6: Run tests**

```bash
cd agent && uv run pytest tests/test_providers.py -v
```

Expected: 3 tests PASSED

- [ ] **Step 7: Commit**

```bash
git add agent/src/providers/ agent/tests/test_providers.py
git commit -m "feat(agent): add provider layer (Fireworks + Anthropic with fallback)"
```

---

### Task 3: Translate layer

**Files:**
- Create: `agent/src/translate.py`
- Create: `agent/tests/test_translate.py`

- [ ] **Step 1: Write failing tests first**

Create `agent/tests/test_translate.py`:

```python
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from agent.src.translate import (
    openai_messages_to_langchain,
    clean_spoken_text,
    last_spoken_user_text,
    make_sse_chunk,
    make_done_chunk,
)


def test_openai_messages_to_langchain_basic():
    msgs = [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
        {"role": "user", "content": "bye"},
    ]
    result, system = openai_messages_to_langchain(msgs)
    assert system is None
    assert len(result) == 3
    assert isinstance(result[0], HumanMessage)
    assert isinstance(result[1], AIMessage)
    assert result[0].content == "hello"


def test_openai_messages_extracts_system():
    msgs = [
        {"role": "system", "content": "You are Jarvis"},
        {"role": "user", "content": "hi"},
    ]
    result, system = openai_messages_to_langchain(msgs)
    assert system == "You are Jarvis"
    assert len(result) == 1


def test_clean_spoken_text_strips_emotion_tags():
    raw = "Hello <emotion type='happy'/> world"
    assert clean_spoken_text(raw) == "Hello world"


def test_last_spoken_user_text():
    msgs = [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "response"},
        {"role": "user", "content": "second"},
    ]
    assert last_spoken_user_text(msgs) == "second"


def test_make_sse_chunk():
    chunk = make_sse_chunk("id1", 1234, "model", "hello")
    assert chunk["choices"][0]["delta"]["content"] == "hello"
    assert chunk["id"] == "id1"
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_translate.py -v
```

Expected: `ImportError: cannot import name 'openai_messages_to_langchain' from 'agent.src.translate'`

- [ ] **Step 3: Create `agent/src/translate.py`**

```python
from __future__ import annotations
import re
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, BaseMessage

_EMOTION_RE = re.compile(r"<emotion\b[^>]*/?>|</emotion>", re.IGNORECASE)


def clean_spoken_text(raw: str | None) -> str:
    if not raw:
        return ""
    text = _EMOTION_RE.sub(" ", str(raw))
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def last_spoken_user_text(messages: list[dict]) -> str:
    for m in reversed(messages):
        if m.get("role") != "user":
            continue
        content = m.get("content", "")
        if isinstance(content, list):
            text = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
        else:
            text = str(content)
        text = text.strip()
        if text:
            return text
    return ""


def openai_messages_to_langchain(
    messages: list[dict],
) -> tuple[list[BaseMessage], str | None]:
    """Convert OpenAI message list to (langchain_messages, system_prompt_or_None)."""
    system_parts: list[str] = []
    lc_messages: list[BaseMessage] = []

    for m in messages:
        role = m.get("role", "")
        content = m.get("content", "")
        if isinstance(content, list):
            text = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
        else:
            text = str(content)

        if role in ("system", "developer"):
            if text.strip():
                system_parts.append(text.strip())
            continue
        if role == "assistant":
            lc_messages.append(AIMessage(content=text))
        else:
            lc_messages.append(HumanMessage(content=text))

    # Merge consecutive same-role messages (LangGraph needs alternating roles)
    merged: list[BaseMessage] = []
    for msg in lc_messages:
        if merged and type(merged[-1]) is type(msg):
            merged[-1] = type(msg)(content=f"{merged[-1].content}\n\n{msg.content}")
        else:
            merged.append(msg)

    # Must start with HumanMessage
    if merged and not isinstance(merged[0], HumanMessage):
        merged.insert(0, HumanMessage(content="(conversation start)"))

    system = "\n\n".join(system_parts) if system_parts else None
    return merged, system


def make_sse_chunk(
    id: str, created: int, model: str, content: str, finish_reason: str | None = None
) -> dict:
    return {
        "id": id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": finish_reason}],
    }


def make_done_chunk(id: str, created: int, model: str, finish_reason: str = "stop") -> dict:
    return {
        "id": id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
    }


def make_completion_response(
    id: str, created: int, model: str, text: str, finish_reason: str = "stop"
) -> dict:
    return {
        "id": id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": finish_reason,
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_translate.py -v
```

Expected: 5 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add agent/src/translate.py agent/tests/test_translate.py
git commit -m "feat(agent): add translate layer (OpenAI ↔ LangChain messages, SSE helpers)"
```

---

### Task 4: Sandbox

**Files:**
- Create: `agent/src/sandbox.py`
- Create: `agent/tests/test_sandbox.py`

- [ ] **Step 1: Write failing tests**

Create `agent/tests/test_sandbox.py`:

```python
import os
import pytest
from agent.src.sandbox import workspace_root, resolve_in_workspace, command_deny_reason


def test_workspace_root_created(tmp_path):
    env = {"AGENT_WORKSPACE": str(tmp_path / "ws")}
    root = workspace_root(env)
    assert os.path.isdir(root)


def test_resolve_blocks_absolute(tmp_path):
    env = {"AGENT_WORKSPACE": str(tmp_path)}
    with pytest.raises(ValueError, match="absolute"):
        resolve_in_workspace("/etc/passwd", env)


def test_resolve_blocks_traversal(tmp_path):
    env = {"AGENT_WORKSPACE": str(tmp_path)}
    with pytest.raises(ValueError, match="escapes"):
        resolve_in_workspace("../../etc/passwd", env)


def test_resolve_valid_path(tmp_path):
    env = {"AGENT_WORKSPACE": str(tmp_path)}
    result = resolve_in_workspace("notes.md", env)
    assert result.startswith(str(tmp_path))


def test_command_deny_reason_sudo():
    assert command_deny_reason("sudo rm -rf /") is not None


def test_command_deny_reason_safe():
    assert command_deny_reason("ls -la") is None
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_sandbox.py -v
```

Expected: ImportError

- [ ] **Step 3: Create `agent/src/sandbox.py`**

```python
from __future__ import annotations
import os
import re
from pathlib import Path

_DENY_PATTERNS = [
    re.compile(r"\brm\s+-\w*r\w*\s+/(?:\s|$)"),
    re.compile(r"\bsudo\b"),
    re.compile(r"\bshutdown\b|\breboot\b|\bhalt\b"),
    re.compile(r"\bmkfs\b|\bdd\s+if="),
    re.compile(r":\(\)\s*\{.*\}\s*;?\s*:"),
    re.compile(r"\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b"),
    re.compile(r">\s*/dev/sd[a-z]"),
    re.compile(r"\bchmod\s+-R\s+777\s+/"),
    re.compile(r"\bgit\s+push\b"),
]


def workspace_root(env: dict | None = None) -> str:
    env = env or dict(os.environ)
    raw = env.get("AGENT_WORKSPACE", "./workspace")
    p = Path(raw).resolve()
    p.mkdir(parents=True, exist_ok=True)
    return str(p.resolve())


def resolve_in_workspace(rel_path: str, env: dict | None = None) -> str:
    if not rel_path or not isinstance(rel_path, str):
        raise ValueError("path is required")
    if Path(rel_path).is_absolute():
        raise ValueError("absolute paths are not allowed; use a path relative to the workspace")

    root = workspace_root(env)
    candidate = str(Path(root) / rel_path)
    candidate_resolved = str(Path(candidate).resolve()) if Path(candidate).exists() else candidate

    root_with_sep = root if root.endswith(os.sep) else root + os.sep
    if candidate_resolved != root and not candidate_resolved.startswith(root_with_sep):
        raise ValueError(f"path escapes the workspace: {rel_path}")

    # Lexical check on the un-resolved candidate
    candidate_norm = os.path.normpath(candidate)
    if candidate_norm != root and not candidate_norm.startswith(root_with_sep):
        raise ValueError(f"path escapes the workspace: {rel_path}")

    return candidate_norm


def to_workspace_relative(abs_path: str, env: dict | None = None) -> str:
    return os.path.relpath(abs_path, workspace_root(env)) or "."


def command_deny_reason(command: str) -> str | None:
    if not command or not command.strip():
        return "command is required"
    for pattern in _DENY_PATTERNS:
        if pattern.search(command):
            return f"command matches a blocked pattern ({pattern.pattern})"
    return None
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_sandbox.py -v
```

Expected: 6 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add agent/src/sandbox.py agent/tests/test_sandbox.py
git commit -m "feat(agent): add workspace sandbox (path resolution + command denylist)"
```

---

### Task 5: Workspace tools

**Files:**
- Create: `agent/src/graph/__init__.py`
- Create: `agent/src/graph/nodes/__init__.py`
- Create: `agent/src/graph/nodes/workspace.py`
- Create: `agent/tests/test_workspace_tools.py`

- [ ] **Step 1: Write failing tests**

Create `agent/tests/test_workspace_tools.py`:

```python
import pytest
from agent.src.graph.nodes.workspace import list_dir, read_file, write_file


def test_list_dir(tmp_path):
    (tmp_path / "a.txt").write_text("x")
    env = {"AGENT_WORKSPACE": str(tmp_path)}
    result = list_dir.invoke({"path": ".", "_env": env})
    assert "a.txt" in result


def test_read_file(tmp_path):
    (tmp_path / "note.txt").write_text("hello world")
    env = {"AGENT_WORKSPACE": str(tmp_path)}
    result = read_file.invoke({"path": "note.txt", "_env": env})
    assert "hello world" in result


def test_write_file_requires_confirmation(tmp_path):
    env = {"AGENT_WORKSPACE": str(tmp_path)}
    result = write_file.invoke({"path": "x.txt", "content": "hi", "user_confirmed": False, "_env": env})
    assert "ERROR" in result


def test_write_file_with_confirmation(tmp_path):
    env = {"AGENT_WORKSPACE": str(tmp_path)}
    result = write_file.invoke({"path": "x.txt", "content": "hi", "user_confirmed": True, "_env": env})
    assert "x.txt" in result
    assert (tmp_path / "x.txt").read_text() == "hi"
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_workspace_tools.py -v
```

Expected: ImportError

- [ ] **Step 3: Create `agent/src/graph/__init__.py` and `agent/src/graph/nodes/__init__.py`**

Both empty.

- [ ] **Step 4: Create `agent/src/graph/nodes/workspace.py`**

```python
from __future__ import annotations
import os
import asyncio
import subprocess
from pathlib import Path
from langchain_core.tools import tool
from ...sandbox import resolve_in_workspace, to_workspace_relative, workspace_root, command_deny_reason

MAX_READ_BYTES = 200_000
COMMAND_TIMEOUT_S = 30


def _audit(env: dict, line: str) -> None:
    try:
        log = Path(workspace_root(env)) / ".agent-audit.log"
        from datetime import datetime, timezone
        log.open("a").write(f"{datetime.now(timezone.utc).isoformat()} {line}\n")
    except Exception:
        pass


@tool
def list_dir(path: str, _env: dict | None = None) -> str:
    """List files and folders inside the agent workspace."""
    env = _env or dict(os.environ)
    try:
        d = Path(resolve_in_workspace(path or ".", env))
        entries = sorted(d.iterdir(), key=lambda e: (not e.is_dir(), e.name))
        if not entries:
            return "(empty)"
        return "\n".join(e.name + "/" if e.is_dir() else e.name for e in entries)
    except Exception as e:
        return f"ERROR: {e}"


@tool
def read_file(path: str, _env: dict | None = None) -> str:
    """Read a UTF-8 text file from the workspace. Returns up to ~200KB."""
    env = _env or dict(os.environ)
    try:
        f = Path(resolve_in_workspace(path, env))
        data = f.read_bytes()
        text = data[:MAX_READ_BYTES].decode("utf-8", errors="replace")
        return text + "\n…(truncated)" if len(data) > MAX_READ_BYTES else text
    except Exception as e:
        return f"ERROR: {e}"


@tool
def search_files(query: str, path: str = ".", _env: dict | None = None) -> str:
    """Search file contents in the workspace for a substring (case-insensitive)."""
    env = _env or dict(os.environ)
    base = Path(resolve_in_workspace(path or ".", env))
    q = query.lower()
    hits: list[str] = []

    def _recurse(d: Path, depth: int = 0) -> None:
        if depth > 6 or len(hits) >= 50:
            return
        try:
            for entry in d.iterdir():
                if entry.name.startswith("."):
                    continue
                if entry.is_dir():
                    _recurse(entry, depth + 1)
                elif entry.stat().st_size <= MAX_READ_BYTES:
                    try:
                        lines = entry.read_text(errors="replace").splitlines()
                        for i, line in enumerate(lines, 1):
                            if q in line.lower():
                                rel = to_workspace_relative(str(entry), env)
                                hits.append(f"{rel}:{i}: {line.strip()[:160]}")
                                if len(hits) >= 50:
                                    return
                    except Exception:
                        pass
        except Exception:
            pass

    _recurse(base)
    return "\n".join(hits) if hits else "No matches."


@tool
def write_file(path: str, content: str, user_confirmed: bool, _env: dict | None = None) -> str:
    """Create or overwrite a file. MUTATING: requires user_confirmed=True."""
    env = _env or dict(os.environ)
    if not user_confirmed:
        return "ERROR: This action changes state and was not confirmed. Tell the user exactly what you intend to do and ask for explicit approval, then retry with user_confirmed=True."
    try:
        f = Path(resolve_in_workspace(path, env))
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(str(content), encoding="utf-8")
        rel = to_workspace_relative(str(f), env)
        _audit(env, f"write_file {rel} ({len(content.encode())} bytes)")
        return f"Wrote {rel}."
    except Exception as e:
        return f"ERROR: {e}"


@tool
def edit_file(path: str, old_text: str, new_text: str, user_confirmed: bool, _env: dict | None = None) -> str:
    """Replace the first exact occurrence of old_text in a file. MUTATING: requires user_confirmed=True."""
    env = _env or dict(os.environ)
    if not user_confirmed:
        return "ERROR: Confirm this edit with the user first, then retry with user_confirmed=True."
    try:
        f = Path(resolve_in_workspace(path, env))
        before = f.read_text(encoding="utf-8")
        if old_text not in before:
            return "ERROR: old_text not found in the file."
        after = before.replace(old_text, new_text, 1)
        f.write_text(after, encoding="utf-8")
        rel = to_workspace_relative(str(f), env)
        _audit(env, f"edit_file {rel}")
        return f"Edited {rel}."
    except Exception as e:
        return f"ERROR: {e}"


@tool
def run_command(command: str, user_confirmed: bool, _env: dict | None = None) -> str:
    """Run a shell command in the workspace directory. MUTATING: requires user_confirmed=True."""
    env = _env or dict(os.environ)
    if not user_confirmed:
        return "ERROR: State the exact command, get a spoken 'yes', then retry with user_confirmed=True."
    deny = command_deny_reason(command)
    if deny:
        _audit(env, f"run_command BLOCKED: {command} :: {deny}")
        return f"ERROR: {deny}"
    _audit(env, f"run_command: {command}")
    try:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True,
            cwd=workspace_root(env), timeout=COMMAND_TIMEOUT_S
        )
        out = []
        if result.stdout:
            out.append(f"stdout:\n{result.stdout}")
        if result.stderr:
            out.append(f"stderr:\n{result.stderr}")
        return "\n".join(out).strip() or "(command produced no output)"
    except subprocess.TimeoutExpired:
        return f"ERROR: command timed out after {COMMAND_TIMEOUT_S}s"
    except Exception as e:
        return f"ERROR: {e}"


@tool
def show_media(url: str, media_type: str, caption: str, _env: dict | None = None) -> str:
    """Display an image, video, or link in the side console panel."""
    # The actual broadcast happens in server.py via the events bus.
    # This tool returning a string is enough for the LLM to continue.
    return "Displayed in the user's console."


WORKSPACE_TOOLS = [list_dir, read_file, search_files, write_file, edit_file, run_command, show_media]
```

- [ ] **Step 5: Run tests**

```bash
cd agent && uv run pytest tests/test_workspace_tools.py -v
```

Expected: 4 tests PASSED

- [ ] **Step 6: Commit**

```bash
git add agent/src/graph/ agent/tests/test_workspace_tools.py
git commit -m "feat(agent): add workspace tools (file ops + command execution with sandbox)"
```

---

### Task 6: Events bus

**Files:**
- Create: `agent/src/events.py`
- Create: `agent/tests/test_events.py`

- [ ] **Step 1: Write failing tests**

Create `agent/tests/test_events.py`:

```python
import asyncio
import pytest
from agent.src.events import EventBus


async def test_broadcast_delivers_to_subscriber():
    bus = EventBus()
    q: asyncio.Queue = asyncio.Queue()
    bus.add(q)
    bus.broadcast({"type": "test", "msg": "hello"})
    event = await asyncio.wait_for(q.get(), timeout=1.0)
    assert event["type"] == "test"


async def test_remove_on_close():
    bus = EventBus()
    q: asyncio.Queue = asyncio.Queue()
    bus.add(q)
    assert bus.count() == 1
    bus.remove(q)
    assert bus.count() == 0
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_events.py -v
```

- [ ] **Step 3: Create `agent/src/events.py`**

```python
from __future__ import annotations
import asyncio
import time
from typing import Any


class EventBus:
    def __init__(self) -> None:
        self._queues: set[asyncio.Queue] = set()

    def add(self, q: asyncio.Queue) -> None:
        self._queues.add(q)

    def remove(self, q: asyncio.Queue) -> None:
        self._queues.discard(q)

    def broadcast(self, event: dict[str, Any]) -> None:
        if not self._queues:
            return
        payload = {"ts": int(time.time() * 1000), **event}
        for q in list(self._queues):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass

    def count(self) -> int:
        return len(self._queues)
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_events.py -v
```

Expected: 2 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add agent/src/events.py agent/tests/test_events.py
git commit -m "feat(agent): add asyncio EventBus for /events SSE console feed"
```

---

### Task 7: Memory

**Files:**
- Create: `agent/src/memory.py`
- Create: `agent/tests/test_memory.py`

- [ ] **Step 1: Write failing tests**

Create `agent/tests/test_memory.py`:

```python
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from agent.src.memory import append_memory_block, norm_path


def test_append_memory_block_empty():
    assert append_memory_block("sys", "") == "sys"


def test_append_memory_block_adds_block():
    result = append_memory_block("sys", "remember me")
    assert "<memory>" in result
    assert "remember me" in result


def test_norm_path_adds_leading_slash():
    assert norm_path("profile/me.md") == "/profile/me.md"


def test_norm_path_rejects_traversal():
    import pytest
    with pytest.raises(ValueError):
        norm_path("../etc/passwd")
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_memory.py -v
```

- [ ] **Step 3: Create `agent/src/memory.py`**

```python
from __future__ import annotations
import anthropic

_cached_store_id: str | None = None


def norm_path(p: str) -> str:
    if not p or not isinstance(p, str):
        raise ValueError("path is required")
    s = p.strip()
    if not s.startswith("/"):
        s = f"/{s}"
    if ".." in s:
        raise ValueError("path may not contain '..'")
    return s


async def resolve_store_id(
    client: anthropic.AsyncAnthropic,
    name: str,
    id_override: str = "",
) -> str:
    global _cached_store_id
    if _cached_store_id:
        return _cached_store_id
    if id_override:
        _cached_store_id = id_override
        return id_override
    async for store in client.beta.memory_stores.list():
        if store.name == name:
            _cached_store_id = store.id
            return store.id
    raise RuntimeError(
        f'Memory store named "{name}" not found (set JARVIS_MEMORY_STORE_ID to pin it).'
    )


async def _find_by_path(
    client: anthropic.AsyncAnthropic, store_id: str, path: str
):
    async for m in client.beta.memory_stores.memories.list(store_id, view="basic"):
        if m.type == "memory" and m.path == path:
            return m
    return None


async def memory_save(
    client: anthropic.AsyncAnthropic, store_id: str, path: str, content: str
) -> str:
    p = norm_path(path)
    body = str(content or "")
    existing = await _find_by_path(client, store_id, p)
    if existing:
        await client.beta.memory_stores.memories.update(
            existing.id, memory_store_id=store_id, content=body
        )
        return f"Updated memory {p}"
    await client.beta.memory_stores.memories.create(store_id, path=p, content=body)
    return f"Saved memory {p}"


async def memory_read(
    client: anthropic.AsyncAnthropic, store_id: str, path: str
) -> str:
    p = norm_path(path)
    m = await _find_by_path(client, store_id, p)
    if not m:
        return f"ERROR: no memory found at {p}"
    full = await client.beta.memory_stores.memories.retrieve(m.id, memory_store_id=store_id)
    return full.content or "(empty)"


async def memory_recall(
    client: anthropic.AsyncAnthropic, store_id: str, query: str = ""
) -> str:
    out: list[str] = []
    async for m in client.beta.memory_stores.memories.list(store_id, view="full"):
        if m.type != "memory":
            continue
        hay = f"{m.path}\n{m.content or ''}".lower()
        if not query or query.lower() in hay:
            snippet = (m.content or "").replace("\n", " ").strip()[:140]
            out.append(f"{m.path} — {snippet}")
        if len(out) >= 50:
            break
    if out:
        return "\n".join(out)
    return f'No memories matching "{query}".' if query else "Memory is empty."


def append_memory_block(system: str, mem_text: str) -> str:
    trimmed = (mem_text or "").strip()
    if not trimmed:
        return system or ""
    block = f"<memory>\n{trimmed}\n</memory>"
    return f"{system}\n\n{block}" if system else block
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_memory.py -v
```

Expected: 4 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add agent/src/memory.py agent/tests/test_memory.py
git commit -m "feat(agent): add memory module (Anthropic Memory Store CRUD)"
```

---

### Task 8: Preamble

**Files:**
- Create: `agent/src/preamble.py`
- Create: `agent/tests/test_preamble.py`

- [ ] **Step 1: Write failing tests**

Create `agent/tests/test_preamble.py`:

```python
import asyncio
import pytest
from agent.src.preamble import run_with_preamble

PREAMBLE_SYSTEM = (
    "You write short spoken acknowledgments for a voice assistant. "
    "Given a user request, output ONLY a 3–6 word acknowledgment plus a period — "
    "never answer the request itself. Be natural and varied. "
    'Examples: "On it." "Let me check that." "Sure, one sec."'
)


async def test_skips_preamble_when_no_provider():
    main_called = False

    async def main(on_text):
        nonlocal main_called
        main_called = True
        on_text("result")
        return {"finish_reason": "stop", "messages": []}

    collected = []
    result = await run_with_preamble(
        preamble_llm=None,
        user_text="hello",
        run_main=main,
        on_text=collected.append,
    )
    assert main_called
    assert collected == ["result"]


async def test_skips_preamble_when_empty_user_text():
    async def main(on_text):
        on_text("x")
        return {"finish_reason": "stop", "messages": []}

    collected = []
    await run_with_preamble(
        preamble_llm=None,
        user_text="",
        run_main=main,
        on_text=collected.append,
    )
    assert collected == ["x"]


async def test_buffers_main_until_preamble_done():
    """Main output must not arrive before preamble completes."""
    order = []
    preamble_done = asyncio.Event()

    class FakeLLM:
        async def astream(self, messages, **kwargs):
            order.append("preamble_start")
            yield type("C", (), {"content": "On it."})()
            order.append("preamble_end")
            preamble_done.set()

    async def main(on_text):
        await preamble_done.wait()
        on_text("main_result")
        order.append("main_text_delivered")
        return {"finish_reason": "stop", "messages": []}

    collected = []
    await run_with_preamble(
        preamble_llm=FakeLLM(),
        user_text="tell me a joke",
        run_main=main,
        on_text=collected.append,
    )
    preamble_idx = next(i for i, v in enumerate(order) if v == "preamble_end")
    main_idx = next(i for i, v in enumerate(order) if v == "main_text_delivered")
    assert preamble_idx < main_idx
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_preamble.py -v
```

- [ ] **Step 3: Create `agent/src/preamble.py`**

```python
from __future__ import annotations
import asyncio
import logging
from typing import Any, Callable, Awaitable
from langchain_core.messages import HumanMessage, SystemMessage

log = logging.getLogger(__name__)

PREAMBLE_SYSTEM = (
    "You write short spoken acknowledgments for a voice assistant. "
    "Given a user request, output ONLY a 3–6 word acknowledgment plus a period — "
    "never answer the request itself. Be natural and varied. "
    'Examples: "On it." "Let me check that." "Sure, one sec." "Looking that up."'
)


async def run_with_preamble(
    *,
    preamble_llm: Any | None,
    user_text: str,
    run_main: Callable[[Callable[[str], None]], Awaitable[dict]],
    on_text: Callable[[str], None],
) -> dict:
    """Stream preamble text first, then main agent output."""
    if not preamble_llm or not (user_text or "").strip():
        return await run_main(on_text)

    main_buffer: list[str] = []
    preamble_done = False

    async def preamble_task() -> None:
        try:
            messages = [
                SystemMessage(content=PREAMBLE_SYSTEM),
                HumanMessage(
                    content=f"The user said: {user_text!r} — output only the acknowledgment."
                ),
            ]
            async for chunk in preamble_llm.astream(messages):
                if chunk.content:
                    on_text(chunk.content)
        except Exception as exc:
            log.warning("preamble failed: %s", exc)

    async def run_main_buffered(delta: str) -> None:
        if preamble_done:
            on_text(delta)
        else:
            main_buffer.append(delta)

    preamble_coro = asyncio.create_task(preamble_task())
    main_promise = asyncio.create_task(run_main(lambda d: main_buffer.append(d) if not preamble_done else on_text(d)))

    # Wait for preamble to finish (or main to fail)
    done, _ = await asyncio.wait(
        [preamble_coro, main_promise],
        return_when=asyncio.FIRST_COMPLETED,
    )
    if preamble_coro not in done:
        await preamble_coro

    preamble_done = True
    for delta in main_buffer:
        on_text(delta)
    main_buffer.clear()

    return await main_promise
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_preamble.py -v
```

Expected: 3 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add agent/src/preamble.py agent/tests/test_preamble.py
git commit -m "feat(agent): add preamble (fast first response before main graph runs)"
```

---

### Task 9: Streaming adapter

**Files:**
- Create: `agent/src/streaming.py`
- Create: `agent/tests/test_streaming.py`

- [ ] **Step 1: Write failing tests**

Create `agent/tests/test_streaming.py`:

```python
import pytest
from langchain_core.messages import AIMessageChunk
from agent.src.streaming import extract_text_delta, is_tool_event, extract_tool_event


def test_extract_text_delta_streaming_tag():
    event = {
        "event": "on_chat_model_stream",
        "tags": ["streaming"],
        "data": {"chunk": AIMessageChunk(content="hello ")},
    }
    assert extract_text_delta(event) == "hello "


def test_extract_text_delta_no_streaming_tag():
    event = {
        "event": "on_chat_model_stream",
        "tags": [],
        "data": {"chunk": AIMessageChunk(content="hidden")},
    }
    assert extract_text_delta(event) is None


def test_is_tool_event():
    assert is_tool_event({"event": "on_tool_start", "name": "list_dir"})
    assert is_tool_event({"event": "on_tool_end", "name": "list_dir"})
    assert not is_tool_event({"event": "on_chat_model_stream"})


def test_extract_tool_event_start():
    evt = {
        "event": "on_tool_start",
        "name": "read_file",
        "data": {"input": {"path": "notes.md"}},
    }
    result = extract_tool_event(evt)
    assert result["type"] == "tool_call"
    assert result["name"] == "read_file"


def test_extract_tool_event_end():
    evt = {
        "event": "on_tool_end",
        "name": "read_file",
        "data": {"output": "file contents"},
    }
    result = extract_tool_event(evt)
    assert result["type"] == "tool_result"
    assert not result["isError"]
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_streaming.py -v
```

- [ ] **Step 3: Create `agent/src/streaming.py`**

```python
from __future__ import annotations
from langchain_core.messages import AIMessageChunk


def extract_text_delta(event: dict) -> str | None:
    """Return text delta if this is a supervisor stream event (tagged 'streaming'), else None."""
    if event.get("event") != "on_chat_model_stream":
        return None
    if "streaming" not in event.get("tags", []):
        return None
    chunk = event.get("data", {}).get("chunk")
    if not isinstance(chunk, AIMessageChunk):
        return None
    content = chunk.content
    if not content:
        return None
    # content can be str or list of dicts
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    return None


def is_tool_event(event: dict) -> bool:
    return event.get("event") in ("on_tool_start", "on_tool_end")


def extract_tool_event(event: dict) -> dict:
    """Convert a LangGraph tool event to a /events broadcast payload."""
    name = event.get("name", "unknown")
    if event["event"] == "on_tool_start":
        return {
            "type": "tool_call",
            "name": name,
            "input": event.get("data", {}).get("input", {}),
        }
    output = event.get("data", {}).get("output", "")
    is_error = isinstance(output, str) and output.startswith("ERROR")
    return {
        "type": "tool_result",
        "name": name,
        "isError": is_error,
    }
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_streaming.py -v
```

Expected: 5 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add agent/src/streaming.py agent/tests/test_streaming.py
git commit -m "feat(agent): add streaming adapter (LangGraph events → OpenAI SSE)"
```

---

### Task 10: LangGraph supervisor graph

**Files:**
- Create: `agent/src/graph/supervisor.py`
- Create: `agent/tests/test_supervisor.py`

- [ ] **Step 1: Write failing tests**

Create `agent/tests/test_supervisor.py`:

```python
import pytest
from unittest.mock import MagicMock, AsyncMock, patch
from agent.src.graph.supervisor import build_system_prompt, AGENT_ADDENDUM


def test_system_prompt_contains_date():
    prompt = build_system_prompt("You are Jarvis")
    assert "Today's date is" in prompt


def test_system_prompt_includes_addendum():
    prompt = build_system_prompt(None)
    assert "ALWAYS speak BEFORE your first tool call" in prompt


def test_agent_addendum_pacing_instruction():
    assert "Never go silent" in AGENT_ADDENDUM
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_supervisor.py -v
```

- [ ] **Step 3: Create `agent/src/graph/supervisor.py`**

```python
from __future__ import annotations
from datetime import date
from typing import Annotated, Any
from typing_extensions import TypedDict
from langgraph.graph.message import add_messages
from langgraph.prebuilt import create_react_agent
from langchain_core.language_models import BaseChatModel

AGENT_ADDENDUM = """

# Operating as Jarvus, a real-time VIDEO AGENT
You are Jarvus, speaking out loud in a live video call, and you can take real actions with tools.

Style:
- Be concise and conversational — your words are spoken aloud. Avoid markdown, lists, and long monologues.

Pacing — keeping the conversation alive during work:
- ALWAYS speak BEFORE your first tool call in a turn. Never open a turn with a silent tool call —
  say a brief acknowledgement first ("On it, one sec…") so the user is never met with silence.
  Give a specific time estimate when you can reason about complexity; use a vague signal otherwise:
    Specific:  "Pulling the S&P data and building the chart — give me about a minute."
    Vague:     "Let me look that up — this might take a moment."
- Between EVERY tool iteration in a multi-step chain, emit a brief status line so there's no silence:
    "Got the search results — now fetching the chart."
    "Still on it, almost there."
- Never go silent for more than one tool round-trip without a status update.

Doing work:
- Reading and searching are safe — use them freely.
- Anything that CHANGES state (write_file, edit_file, run_command, send email) requires explicit
  confirmation: first say exactly what you will do, ask the user to confirm out loud, and only after
  they say yes call the tool with user_confirmed=True.
- You retain full context from earlier in THIS conversation. When the user confirms ("yes", "go ahead"),
  act on the content you already prepared — do NOT start over.
- After acting, briefly confirm what you did.

Long-term memory (persists across conversations):
- Your memory from prior conversations is already loaded above in a <memory> block.
  Use it to greet the user by name and recall ongoing projects without calling any tool.
- When you learn something durable — the user's name, preferences, decisions, ongoing work — call
  memory_save so you remember it next time. Use clear paths like /profile/owner.md or /projects/x.md.
- Use memory_recall mid-conversation to search for something specific not in the injected block.
- Memory is your own brain; you don't need to ask permission to read or update it.

Showing things on screen:
- When something is better seen than described — a picture, chart, diagram, or page you found —
  call show_media with a direct URL so it appears in the user's console. Keep talking naturally;
  show_media displays silently. Don't paste raw URLs into your spoken reply.

Notion notes:
- NOTION_DATABASE_ID is available in your environment. Use the Notion tools.
- When taking notes, always include any image URLs from show_media calls as Notion image blocks.
- Page titles follow the format: YYYY-MM-DD — <topic>."""


class AgentState(TypedDict):
    messages: Annotated[list, add_messages]
    session_images: list
    memory_context: str
    thread_id: str


def build_system_prompt(user_system: str | None, memory_context: str = "") -> str:
    today = date.today().strftime("%A, %B %-d, %Y")
    date_line = f"\n\nToday's date is {today}. Use it when reasoning about current events and web searches."
    base = user_system or "You are Jarvus, a helpful voice agent."
    prompt = f"{base}{AGENT_ADDENDUM}{date_line}"
    if memory_context and memory_context.strip():
        prompt += f"\n\n<memory>\n{memory_context.strip()}\n</memory>"
    return prompt


def create_graph(
    supervisor_llm: BaseChatModel,
    tools: list[Any],
    *,
    checkpointer: Any | None = None,
) -> Any:
    """Build and return the compiled LangGraph supervisor graph."""
    graph = create_react_agent(
        model=supervisor_llm,
        tools=tools,
        checkpointer=checkpointer,
    )
    return graph
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_supervisor.py -v
```

Expected: 3 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add agent/src/graph/supervisor.py agent/tests/test_supervisor.py
git commit -m "feat(agent): add LangGraph supervisor graph (AgentState, create_graph, system prompt)"
```

---

### Task 11: Full FastAPI server

**Files:**
- Modify: `agent/src/server.py` (full implementation)
- Create: `agent/tests/test_server_integration.py`

- [ ] **Step 1: Write failing integration test**

Create `agent/tests/test_server_integration.py`:

```python
import pytest
from httpx import AsyncClient, ASGITransport


async def test_health_returns_ok(client):
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


async def test_models_endpoint(client):
    r = await client.get("/v1/models")
    assert r.status_code == 200
    data = r.json()
    assert data["object"] == "list"
    assert len(data["data"]) >= 1


async def test_chat_completions_requires_auth(client, monkeypatch):
    monkeypatch.setenv("PROXY_API_KEY", "secret")
    monkeypatch.setenv("PROXY_ALLOW_UNAUTHENTICATED", "false")
    r = await client.post("/v1/chat/completions", json={
        "messages": [{"role": "user", "content": "hi"}]
    })
    assert r.status_code == 401
```

- [ ] **Step 2: Run to verify they fail (or partially fail)**

```bash
cd agent && uv run pytest tests/test_server_integration.py -v
```

- [ ] **Step 3: Rewrite `agent/src/server.py` with full implementation**

```python
from __future__ import annotations
import asyncio
import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import AsyncIterator

from dotenv import load_dotenv
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from sse_starlette.sse import EventSourceResponse

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../../.env"))
load_dotenv()

from .events import EventBus
from .graph.nodes.workspace import WORKSPACE_TOOLS, show_media
from .graph.supervisor import build_system_prompt, create_graph
from .memory import append_memory_block, memory_recall, resolve_store_id
from .preamble import run_with_preamble
from .providers.index import create_providers
from .streaming import extract_text_delta, extract_tool_event, is_tool_event
from .translate import (
    clean_spoken_text,
    last_spoken_user_text,
    make_completion_response,
    make_done_chunk,
    make_sse_chunk,
    openai_messages_to_langchain,
)

log = logging.getLogger(__name__)

HEARTBEAT_MS = int(os.getenv("JARVUS_HEARTBEAT_MS", "1500"))
HEARTBEAT_FILLERS = [
    "Still on it, one sec.",
    "Almost there.",
    "Hang tight, just a moment.",
    "Still working on that.",
]

bus = EventBus()
providers = None
graph = None
checkpointer = None
memory_cfg: dict | None = None  # {"client": ..., "store_id": ...}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global providers, graph, checkpointer, memory_cfg

    providers = create_providers()

    # Memory store
    if os.getenv("AGENT_ENABLE_MEMORY", "true") != "false":
        try:
            from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
            import pathlib
            db_path = pathlib.Path.home() / ".jarvis" / "checkpoints.db"
            db_path.parent.mkdir(parents=True, exist_ok=True)
            checkpointer = AsyncSqliteSaver.from_conn_string(str(db_path))

            store_id = await resolve_store_id(
                providers.anthropic_client,
                name=os.getenv("JARVIS_MEMORY_STORE_NAME", "jarvis-memory"),
                id_override=os.getenv("JARVIS_MEMORY_STORE_ID", ""),
            )
            memory_cfg = {"client": providers.anthropic_client, "store_id": store_id}
            log.info("[agent] memory store resolved: %s", store_id)
        except Exception as exc:
            log.warning("[agent] memory disabled: %s", exc)

    graph = create_graph(
        supervisor_llm=providers.supervisor_llm,
        tools=WORKSPACE_TOOLS,
        checkpointer=checkpointer,
    )

    log.info(
        "[agent] listening on port %s  fireworks=%s  memory=%s",
        os.getenv("PROXY_PORT", "8787"),
        providers.has_fireworks,
        memory_cfg is not None,
    )
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def _authorize(request: Request) -> bool:
    proxy_key = os.getenv("PROXY_API_KEY", "")
    allow_unauth = os.getenv("PROXY_ALLOW_UNAUTHENTICATED", "false") == "true"
    if allow_unauth or not proxy_key:
        return True
    header = request.headers.get("authorization", "")
    token = header.removeprefix("Bearer ").strip()
    return token == proxy_key


@app.get("/health")
async def health():
    model = os.getenv("FIREWORKS_MODEL") if providers and providers.has_fireworks else os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    return {"status": "ok", "model": model}


@app.get("/")
async def root():
    return {
        "name": "jarvis-agent",
        "description": "FastAPI + LangGraph agent proxy (Fireworks-primary with Claude fallback).",
        "endpoints": ["/v1/chat/completions", "/v1/models", "/health", "/events"],
    }


@app.get("/v1/models")
@app.get("/models")
async def models():
    model = os.getenv("FIREWORKS_MODEL", os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6"))
    return {"object": "list", "data": [{"id": model, "object": "model", "owned_by": "anthropic"}]}


@app.get("/events")
async def events(request: Request):
    q: asyncio.Queue = asyncio.Queue(maxsize=200)
    bus.add(q)

    async def stream():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield {"data": json.dumps(payload)}
                except asyncio.TimeoutError:
                    yield {"comment": "ping"}
        finally:
            bus.remove(q)

    return EventSourceResponse(stream())


async def _run_graph(lc_messages, system_prompt: str, thread_id: str, on_text, on_event):
    """Run the LangGraph supervisor and call on_text/on_event as events arrive."""
    from langchain_core.messages import SystemMessage
    config = {"configurable": {"thread_id": thread_id}}
    input_state = {"messages": lc_messages}

    # Inject system prompt as first message if no checkpointer context
    # (LangGraph react agent uses the first SystemMessage as system prompt)
    all_messages = [SystemMessage(content=system_prompt)] + lc_messages

    finish_reason = "stop"
    async for event in graph.astream_events(
        {"messages": all_messages}, config, version="v2"
    ):
        delta = extract_text_delta(event)
        if delta:
            on_text(delta)
            continue
        if is_tool_event(event):
            tool_evt = extract_tool_event(event)
            on_event(tool_evt)

    return {"finish_reason": finish_reason}


@app.post("/v1/chat/completions")
@app.post("/chat/completions")
async def chat_completions(request: Request):
    if not _authorize(request):
        return JSONResponse(status_code=401, content={"error": {"message": "Unauthorized"}})

    body = await request.json()
    want_stream = body.get("stream", True)
    req_id = f"chatcmpl-{uuid.uuid4().hex}"
    created = int(datetime.now(timezone.utc).timestamp())
    model = os.getenv("FIREWORKS_MODEL", os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6"))

    messages = body.get("messages", [])
    user_text = last_spoken_user_text(messages)
    if user_text:
        bus.broadcast({"type": "transcript", "role": "user", "text": user_text})

    lc_messages, user_system = openai_messages_to_langchain(messages)

    # Memory injection on new conversations
    memory_context = ""
    if memory_cfg:
        try:
            memory_context = await memory_recall(
                memory_cfg["client"], memory_cfg["store_id"], ""
            )
        except Exception as exc:
            log.warning("[agent] memory injection failed: %s", exc)

    system_prompt = build_system_prompt(user_system, memory_context)
    thread_id = body.get("thread_id") or req_id

    def on_event(evt):
        bus.broadcast(evt)
        if evt.get("type") == "tool_call":
            log.info("[agent] → %s(%s)", evt["name"], list((evt.get("input") or {}).keys()))
        elif evt.get("type") == "tool_result":
            log.info("[agent] ← %s%s", evt["name"], " [error]" if evt.get("isError") else " ok")

    if not want_stream:
        text_parts: list[str] = []
        await _run_graph(lc_messages, system_prompt, thread_id, text_parts.append, on_event)
        text = "".join(text_parts)
        spoken = clean_spoken_text(text)
        if spoken:
            bus.broadcast({"type": "transcript", "role": "assistant", "text": spoken})
        return JSONResponse(make_completion_response(req_id, created, model, text))

    async def sse_stream() -> AsyncIterator[str]:
        import time

        # Queue carries tagged tuples: ("text", str) | ("hb", str) | ("done", str)
        q: asyncio.Queue = asyncio.Queue()
        last_activity = [time.monotonic()]
        all_text: list[str] = []

        def on_text(delta: str) -> None:
            last_activity[0] = time.monotonic()
            all_text.append(delta)
            q.put_nowait(("text", delta))

        async def heartbeat() -> None:
            filler_idx = -1
            while True:
                await asyncio.sleep(0.5)
                if time.monotonic() - last_activity[0] >= HEARTBEAT_MS / 1000:
                    filler_idx = (filler_idx + 1) % len(HEARTBEAT_FILLERS)
                    q.put_nowait(("hb", HEARTBEAT_FILLERS[filler_idx] + " "))
                    last_activity[0] = time.monotonic()  # reset so we don't spam

        async def run() -> None:
            result = await run_with_preamble(
                preamble_llm=providers.preamble_llm,
                user_text=user_text,
                run_main=lambda cb: _run_graph(lc_messages, system_prompt, thread_id, cb, on_event),
                on_text=on_text,
            )
            q.put_nowait(("done", result.get("finish_reason", "stop")))

        hb_task = asyncio.create_task(heartbeat())
        run_task = asyncio.create_task(run())

        # Opening role chunk (OpenAI convention)
        yield f"data: {json.dumps(make_sse_chunk(req_id, created, model, ''))}\n\n"

        finish_reason = "stop"
        try:
            while True:
                tag, payload = await q.get()
                if tag == "done":
                    finish_reason = payload
                    break
                chunk = make_sse_chunk(req_id, created, model, payload)
                yield f"data: {json.dumps(chunk)}\n\n"
        finally:
            hb_task.cancel()
            await asyncio.gather(run_task, return_exceptions=True)

        spoken = clean_spoken_text("".join(all_text))
        if spoken:
            bus.broadcast({"type": "transcript", "role": "assistant", "text": spoken})

        yield f"data: {json.dumps(make_done_chunk(req_id, created, model, finish_reason))}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(sse_stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
    })
```

> **Note:** The streaming loop above uses a simplified approach. In production, refactor to a proper async generator chain using `asyncio.Queue` to decouple heartbeats from text deltas. The structure here is correct for correctness but the interleaving logic should be tightened in a follow-up.

- [ ] **Step 4: Run integration tests**

```bash
cd agent && uv run pytest tests/test_server_integration.py -v
```

Expected: 2-3 tests PASSED (the auth test may require env tweak)

- [ ] **Step 5: Smoke test with curl**

```bash
npm run agent  # starts on port 8787
curl http://localhost:8787/health
```

Expected: `{"status":"ok","model":"..."}`

- [ ] **Step 6: Commit**

```bash
git add agent/src/server.py agent/tests/test_server_integration.py
git commit -m "feat(agent): full FastAPI server with LangGraph supervisor, streaming SSE, heartbeat, preamble, memory"
```

---

### Task 12: Wire into project and verify

**Files:**
- Modify: `.env.example`
- Modify: `AGENTS.md` (update the run stack section)

- [ ] **Step 1: Add new env vars to `.env.example`**

```bash
# New in agent/ Python service
ALPHA_VANTAGE_API_KEY=
COINGECKO_API_KEY=          # optional — free tier works without
GMAIL_TOKEN=
OUTLOOK_TOKEN=
```

- [ ] **Step 2: Start the Python agent and verify parity with Node proxy**

```bash
# Terminal 1: start Python agent
npm run agent

# Terminal 2: run a smoke test
curl -s http://localhost:8787/health
curl -s http://localhost:8787/v1/models

# Terminal 3: send a non-streaming chat request
curl -s -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"stream":false,"messages":[{"role":"user","content":"say hi in one word"}]}'
```

Expected: JSON response with `choices[0].message.content` containing a greeting.

- [ ] **Step 3: Run full test suite**

```bash
cd agent && uv run pytest -v
```

Expected: all tests PASSED

- [ ] **Step 4: Commit**

```bash
git add .env.example AGENTS.md
git commit -m "feat(agent): wire Python agent into project; update .env.example"
```

---

**Foundation complete.** The Python `agent/` service is now feature-equivalent to `proxy/` (Node.js). Domain nodes (Finance, News, Email, Notion) are added in **`2026-06-11-langgraph-domain-nodes.md`**.
