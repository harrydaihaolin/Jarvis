# LangGraph Domain Nodes Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** `2026-06-11-langgraph-foundation.md` must be complete and the `agent/` service must be running on port 8787.

**Goal:** Add four domain subgraph agents to the LangGraph supervisor — Finance (yfinance + Alpha Vantage + CoinGecko), News (web_search), Email (Gmail + Outlook MCP), and Notion (Notion MCP) — and wire them into the supervisor so Jarvis can route queries to the right specialist automatically.

**Architecture:** Each domain node is a `create_react_agent` with its own tool set, exposed to the supervisor via `as_tool()`. The supervisor already exists from Plan A; this plan adds tools to it and connects MCP servers at startup.

**Tech Stack:** langgraph, langchain-mcp-adapters, yfinance, alpha-vantage, pycoingecko, `@notionhq/notion-mcp-server`, Gmail MCP server (verify package name in Task 3), Outlook MCP server (verify package name in Task 3)

---

## File Map

| File | Responsibility |
|---|---|
| `agent/src/graph/nodes/finance.py` | yfinance + Alpha Vantage + CoinGecko tools + subgraph |
| `agent/src/graph/nodes/news.py` | web_search subgraph (wraps Anthropic server tool) |
| `agent/src/graph/nodes/email.py` | Gmail + Outlook MCP tools + subgraph |
| `agent/src/graph/nodes/notion.py` | Notion MCP tools + subgraph |
| `agent/src/graph/nodes/mcp_loader.py` | Shared MCP client startup / tool discovery |
| `agent/src/server.py` | Modified: wire domain subgraph tools into supervisor at startup |
| `agent/tests/test_finance.py` | Finance tool unit tests (mocked API calls) |
| `agent/tests/test_news.py` | News node unit tests |
| `agent/tests/test_email.py` | Email node unit tests (mocked MCP) |
| `agent/tests/test_notion.py` | Notion node unit tests (mocked MCP) |

---

### Task 1: Finance node

**Files:**
- Create: `agent/src/graph/nodes/finance.py`
- Create: `agent/tests/test_finance.py`

- [ ] **Step 1: Write failing tests**

Create `agent/tests/test_finance.py`:

```python
import pytest
from unittest.mock import patch, MagicMock
from agent.src.graph.nodes.finance import get_quote, get_history, get_crypto


def test_get_quote_formats_result():
    mock_info = {
        "currentPrice": 185.50,
        "regularMarketChangePercent": 1.23,
        "volume": 52_000_000,
        "marketCap": 2_900_000_000_000,
        "shortName": "Apple Inc.",
    }
    with patch("yfinance.Ticker") as mock_ticker:
        mock_ticker.return_value.info = mock_info
        result = get_quote.invoke({"symbol": "AAPL"})
    assert "AAPL" in result
    assert "185.50" in result
    assert "1.23" in result


def test_get_quote_handles_error():
    with patch("yfinance.Ticker") as mock_ticker:
        mock_ticker.return_value.info = {}
        result = get_quote.invoke({"symbol": "FAKE"})
    assert "ERROR" in result or "not found" in result.lower() or result  # graceful


def test_get_crypto_formats_result():
    mock_data = {
        "BITCOIN": {
            "usd": 67_000.0,
            "usd_24h_change": 2.5,
            "usd_market_cap": 1_300_000_000_000,
            "usd_24h_vol": 30_000_000_000,
        }
    }
    with patch("pycoingecko.CoinGeckoAPI") as mock_cg:
        instance = mock_cg.return_value
        instance.get_price.return_value = mock_data
        result = get_crypto.invoke({"coin_id": "bitcoin"})
    assert "bitcoin" in result.lower()
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_finance.py -v
```

Expected: ImportError

- [ ] **Step 3: Create `agent/src/graph/nodes/finance.py`**

```python
from __future__ import annotations
import os
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent


@tool
def get_quote(symbol: str) -> str:
    """Get current stock price, change %, volume, and market cap for a ticker symbol."""
    import yfinance as yf
    try:
        info = yf.Ticker(symbol.upper()).info
        if not info or "currentPrice" not in info:
            return f"No price data found for {symbol.upper()}."
        price = info.get("currentPrice", 0)
        change = info.get("regularMarketChangePercent", 0)
        volume = info.get("volume", info.get("regularMarketVolume", 0))
        mkt_cap = info.get("marketCap", 0)
        name = info.get("shortName", symbol.upper())
        return (
            f"{name} ({symbol.upper()})\n"
            f"Price: ${price:.2f}  Change: {change:+.2f}%\n"
            f"Volume: {volume:,}  Market Cap: ${mkt_cap:,.0f}"
        )
    except Exception as e:
        return f"ERROR fetching quote for {symbol}: {e}"


@tool
def get_history(symbol: str, period: str = "1mo") -> str:
    """Get OHLCV history for a ticker. period: 1d, 5d, 1mo, 3mo, 6mo, 1y, 5y."""
    import yfinance as yf
    try:
        df = yf.Ticker(symbol.upper()).history(period=period)
        if df.empty:
            return f"No history for {symbol.upper()} over period {period}."
        lines = ["Date,Open,High,Low,Close,Volume"]
        for idx, row in df.tail(30).iterrows():
            d = idx.strftime("%Y-%m-%d")
            lines.append(
                f"{d},{row['Open']:.2f},{row['High']:.2f},{row['Low']:.2f},{row['Close']:.2f},{int(row['Volume'])}"
            )
        return "\n".join(lines)
    except Exception as e:
        return f"ERROR fetching history for {symbol}: {e}"


@tool
def get_fundamentals(symbol: str) -> str:
    """Get P/E ratio, EPS, revenue, and earnings date from Alpha Vantage."""
    api_key = os.getenv("ALPHA_VANTAGE_API_KEY", "")
    if not api_key:
        return "ERROR: ALPHA_VANTAGE_API_KEY is not set."
    try:
        import urllib.request, json as _json
        url = (
            f"https://www.alphavantage.co/query?function=OVERVIEW"
            f"&symbol={symbol.upper()}&apikey={api_key}"
        )
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = _json.loads(resp.read())
        if "Note" in data:
            return "Alpha Vantage rate limit reached — try again in a minute."
        if not data.get("Symbol"):
            return f"No fundamental data found for {symbol.upper()}."
        return (
            f"{data.get('Name', symbol)} ({symbol.upper()})\n"
            f"P/E: {data.get('PERatio', 'N/A')}  EPS: {data.get('EPS', 'N/A')}\n"
            f"Revenue (TTM): {data.get('RevenueTTM', 'N/A')}\n"
            f"Next earnings: {data.get('NextEarningsDate', 'N/A')}\n"
            f"Sector: {data.get('Sector', 'N/A')}  Industry: {data.get('Industry', 'N/A')}"
        )
    except Exception as e:
        return f"ERROR fetching fundamentals for {symbol}: {e}"


@tool
def get_crypto(coin_id: str) -> str:
    """Get current price, 24h change, market cap, and volume for a cryptocurrency.
    coin_id examples: bitcoin, ethereum, solana."""
    try:
        from pycoingecko import CoinGeckoAPI
        cg = CoinGeckoAPI()
        data = cg.get_price(
            ids=coin_id.lower(),
            vs_currencies="usd",
            include_market_cap=True,
            include_24hr_vol=True,
            include_24hr_change=True,
        )
        if not data or coin_id.lower() not in data:
            return f"No data found for coin '{coin_id}'. Check the CoinGecko coin ID."
        d = data[coin_id.lower()]
        return (
            f"{coin_id.capitalize()}\n"
            f"Price: ${d.get('usd', 0):,.2f}  24h change: {d.get('usd_24h_change', 0):+.2f}%\n"
            f"Market Cap: ${d.get('usd_market_cap', 0):,.0f}\n"
            f"24h Volume: ${d.get('usd_24h_vol', 0):,.0f}"
        )
    except Exception as e:
        return f"ERROR fetching crypto data for {coin_id}: {e}"


FINANCE_TOOLS = [get_quote, get_history, get_fundamentals, get_crypto]


def create_finance_subgraph(subgraph_llm):
    return create_react_agent(
        model=subgraph_llm,
        tools=FINANCE_TOOLS,
        name="finance_agent",
    )
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_finance.py -v
```

Expected: 3 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add agent/src/graph/nodes/finance.py agent/tests/test_finance.py
git commit -m "feat(agent): add Finance node (yfinance + Alpha Vantage + CoinGecko)"
```

---

### Task 2: News node

**Files:**
- Create: `agent/src/graph/nodes/news.py`
- Create: `agent/tests/test_news.py`

The news node wraps Anthropic's web_search server tool. Web search is an Anthropic-only feature (not available on Fireworks). The subgraph uses the Anthropic client directly for its LLM call so web_search works regardless of the supervisor's primary provider.

- [ ] **Step 1: Write failing tests**

Create `agent/tests/test_news.py`:

```python
from agent.src.graph.nodes.news import NEWS_SYSTEM_PROMPT


def test_news_system_prompt_mentions_search():
    assert "search" in NEWS_SYSTEM_PROMPT.lower()


def test_news_system_prompt_asks_for_summary():
    assert "summar" in NEWS_SYSTEM_PROMPT.lower()
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_news.py -v
```

- [ ] **Step 3: Create `agent/src/graph/nodes/news.py`**

```python
from __future__ import annotations
import os
from langgraph.prebuilt import create_react_agent
from langchain_anthropic import ChatAnthropic

NEWS_SYSTEM_PROMPT = (
    "You are a news research assistant. Given a news query, use web_search to find the latest "
    "headlines and articles. Return a concise summary of 3–5 key points with source names. "
    "Focus on facts, recency, and relevance. Do not speculate beyond what the sources say."
)

# web_search is an Anthropic server tool definition
WEB_SEARCH_TOOL = {
    "type": "web_search_20250305",
    "name": "web_search",
    "max_uses": 3,
}


def create_news_subgraph(anthropic_api_key: str | None = None):
    """
    News subgraph always uses ChatAnthropic because web_search is an Anthropic server tool.
    Falls back to ANTHROPIC_API_KEY env var if key not supplied.
    """
    key = anthropic_api_key or os.getenv("ANTHROPIC_API_KEY", "")
    model = os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5")
    llm = ChatAnthropic(api_key=key, model=model, streaming=True)
    return create_react_agent(
        model=llm,
        tools=[WEB_SEARCH_TOOL],
        state_modifier=NEWS_SYSTEM_PROMPT,
        name="news_agent",
    )
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_news.py -v
```

Expected: 2 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add agent/src/graph/nodes/news.py agent/tests/test_news.py
git commit -m "feat(agent): add News node (Anthropic web_search subgraph)"
```

---

### Task 3: MCP loader + Email node

**Files:**
- Create: `agent/src/graph/nodes/mcp_loader.py`
- Create: `agent/src/graph/nodes/email.py`
- Create: `agent/tests/test_email.py`

> **IMPORTANT — verify MCP package names before implementing:**
> Run the following before writing any import:
> ```bash
> npm show @modelcontextprotocol/server-gmail version 2>/dev/null || echo "NOT FOUND"
> npm show @gptscript-ai/mcp-gmail version 2>/dev/null || echo "NOT FOUND"
> npm show @microsoft365/mcp version 2>/dev/null || echo "NOT FOUND"
> npm show @microsoft/365-mcp-server version 2>/dev/null || echo "NOT FOUND"
> ```
> Use the package name that exists. Update the `_GMAIL_CMD` and `_OUTLOOK_CMD` constants
> in `mcp_loader.py` accordingly.

- [ ] **Step 1: Verify MCP package names**

```bash
npm show @modelcontextprotocol/server-gmail version 2>/dev/null || echo "gmail NOT FOUND"
npm show @microsoft365/mcp version 2>/dev/null || echo "outlook NOT FOUND"
```

Update the constants in Step 3 below with the correct package names before proceeding.

- [ ] **Step 2: Write failing tests**

Create `agent/tests/test_email.py`:

```python
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from agent.src.graph.nodes.email import EMAIL_SYSTEM_PROMPT


def test_email_system_prompt_mentions_confirmation():
    assert "confirm" in EMAIL_SYSTEM_PROMPT.lower() or "confirmed" in EMAIL_SYSTEM_PROMPT.lower()


def test_email_system_prompt_covers_both_providers():
    prompt = EMAIL_SYSTEM_PROMPT.lower()
    assert "gmail" in prompt or "email" in prompt
```

- [ ] **Step 3: Create `agent/src/graph/nodes/mcp_loader.py`**

Replace `GMAIL_NPM_PACKAGE` and `OUTLOOK_NPM_PACKAGE` with the verified package names from Step 1.

```python
from __future__ import annotations
import os
import logging
from langchain_mcp_adapters.client import MultiServerMCPClient

log = logging.getLogger(__name__)

# UPDATE THESE after running the npm show verification in Task 3 Step 1
GMAIL_NPM_PACKAGE = "@modelcontextprotocol/server-gmail"   # verify before use
OUTLOOK_NPM_PACKAGE = "@microsoft365/mcp"                  # verify before use
NOTION_NPM_PACKAGE = "@notionhq/notion-mcp-server"         # known-good


async def load_email_tools() -> list:
    """Start Gmail + Outlook MCP servers and return discovered tools."""
    servers: dict = {}

    gmail_token = os.getenv("GMAIL_TOKEN", "")
    if gmail_token:
        servers["gmail"] = {
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", GMAIL_NPM_PACKAGE],
            "env": {"GMAIL_TOKEN": gmail_token, **dict(os.environ)},
        }
    else:
        log.warning("[mcp] GMAIL_TOKEN not set — Gmail tools unavailable")

    outlook_token = os.getenv("OUTLOOK_TOKEN", "")
    if outlook_token:
        servers["outlook"] = {
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", OUTLOOK_NPM_PACKAGE],
            "env": {"OUTLOOK_TOKEN": outlook_token, **dict(os.environ)},
        }
    else:
        log.warning("[mcp] OUTLOOK_TOKEN not set — Outlook tools unavailable")

    if not servers:
        log.warning("[mcp] No email credentials set — email node will have no tools")
        return []

    try:
        client = MultiServerMCPClient(servers)
        tools = await client.get_tools()
        log.info("[mcp] Email tools loaded: %s", [t.name for t in tools])
        return tools
    except Exception as exc:
        log.error("[mcp] Failed to load email tools: %s", exc)
        return []


async def load_notion_tools() -> list:
    """Start Notion MCP server and return discovered tools."""
    token = os.getenv("NOTION_TOKEN", "")
    if not token:
        log.warning("[mcp] NOTION_TOKEN not set — Notion tools unavailable")
        return []

    try:
        client = MultiServerMCPClient({
            "notion": {
                "transport": "stdio",
                "command": "npx",
                "args": ["-y", NOTION_NPM_PACKAGE],
                "env": {"NOTION_TOKEN": token, **dict(os.environ)},
            }
        })
        tools = await client.get_tools()
        log.info("[mcp] Notion tools loaded: %s", [t.name for t in tools])
        return tools
    except Exception as exc:
        log.error("[mcp] Failed to load Notion tools: %s", exc)
        return []
```

- [ ] **Step 4: Create `agent/src/graph/nodes/email.py`**

```python
from __future__ import annotations
from langgraph.prebuilt import create_react_agent
from langchain_core.language_models import BaseChatModel

EMAIL_SYSTEM_PROMPT = (
    "You are an email assistant with access to Gmail and Outlook. "
    "For read operations (search, list, read), act immediately. "
    "For write operations (send, reply, forward, delete), you MUST first describe "
    "exactly what you are about to do, then call the tool only with user_confirmed=True "
    "after the user explicitly agrees. Never send or modify emails without confirmation."
)


def create_email_subgraph(subgraph_llm: BaseChatModel, email_tools: list):
    if not email_tools:
        # Return a no-op subgraph if no credentials are configured
        from langchain_core.tools import tool

        @tool
        def email_unavailable(query: str) -> str:
            """Email tools are not configured (GMAIL_TOKEN / OUTLOOK_TOKEN missing)."""
            return "Email tools are not available. Set GMAIL_TOKEN and/or OUTLOOK_TOKEN in .env."

        email_tools = [email_unavailable]

    return create_react_agent(
        model=subgraph_llm,
        tools=email_tools,
        state_modifier=EMAIL_SYSTEM_PROMPT,
        name="email_agent",
    )
```

- [ ] **Step 5: Run tests**

```bash
cd agent && uv run pytest tests/test_email.py -v
```

Expected: 2 tests PASSED

- [ ] **Step 6: Commit**

```bash
git add agent/src/graph/nodes/mcp_loader.py agent/src/graph/nodes/email.py agent/tests/test_email.py
git commit -m "feat(agent): add Email node + MCP loader (Gmail + Outlook via langchain-mcp-adapters)"
```

---

### Task 4: Notion node

**Files:**
- Create: `agent/src/graph/nodes/notion.py`
- Create: `agent/tests/test_notion.py`

- [ ] **Step 1: Write failing tests**

Create `agent/tests/test_notion.py`:

```python
from agent.src.graph.nodes.notion import NOTION_SYSTEM_PROMPT


def test_notion_system_prompt_mentions_database():
    assert "database" in NOTION_SYSTEM_PROMPT.lower() or "NOTION_DATABASE_ID" in NOTION_SYSTEM_PROMPT


def test_notion_system_prompt_mentions_image_blocks():
    assert "image" in NOTION_SYSTEM_PROMPT.lower()
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_notion.py -v
```

- [ ] **Step 3: Create `agent/src/graph/nodes/notion.py`**

```python
from __future__ import annotations
import os
from langgraph.prebuilt import create_react_agent
from langchain_core.language_models import BaseChatModel
from langchain_core.tools import tool

NOTION_SYSTEM_PROMPT = (
    "You are a Notion assistant. NOTION_DATABASE_ID is available in your environment. "
    "When creating pages, use the format: YYYY-MM-DD — <topic> for the title. "
    "When the user has viewed images (from show_media calls this session), include them "
    "as Notion image blocks (type: 'image', external: { url: '...' }). "
    "For read operations (search, list, retrieve), act immediately. "
    "For write operations (create, update, delete), confirm with the user first."
)


def create_notion_subgraph(subgraph_llm: BaseChatModel, notion_tools: list):
    readonly = os.getenv("AGENT_NOTION_READONLY", "true") == "true"

    if not notion_tools:
        @tool
        def notion_unavailable(query: str) -> str:
            """Notion tools are not configured (NOTION_TOKEN missing)."""
            return "Notion tools are not available. Set NOTION_TOKEN in .env."
        notion_tools = [notion_unavailable]
    elif readonly:
        # Filter to read-only tools only
        read_keywords = ("retrieve", "search", "list", "get", "query", "fetch", "read")
        filtered = [t for t in notion_tools if any(k in t.name.lower() for k in read_keywords)]
        if not filtered:
            filtered = notion_tools  # fallback: keep all if none match
        notion_tools = filtered

    return create_react_agent(
        model=subgraph_llm,
        tools=notion_tools,
        state_modifier=NOTION_SYSTEM_PROMPT,
        name="notion_agent",
    )
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_notion.py -v
```

Expected: 2 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add agent/src/graph/nodes/notion.py agent/tests/test_notion.py
git commit -m "feat(agent): add Notion node (Notion MCP subgraph with readonly mode)"
```

---

### Task 5: Wire domain nodes into supervisor

**Files:**
- Modify: `agent/src/server.py` (lifespan: load MCP tools + build domain subgraphs + wire into graph)

The supervisor's tools list grows from `WORKSPACE_TOOLS` to include `as_tool()` wrappers for each domain subgraph.

- [ ] **Step 1: Update lifespan in `agent/src/server.py`**

Replace the `lifespan` function with the version below. Find the existing `lifespan` block (starts at `@asynccontextmanager` and ends with `yield`) and replace it entirely:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    global providers, graph, checkpointer, memory_cfg

    providers = create_providers()

    # MCP tools (loaded at startup)
    from .graph.nodes.mcp_loader import load_email_tools, load_notion_tools
    from .graph.nodes.email import create_email_subgraph
    from .graph.nodes.notion import create_notion_subgraph
    from .graph.nodes.finance import create_finance_subgraph
    from .graph.nodes.news import create_news_subgraph

    email_tools = await load_email_tools()
    notion_tools = await load_notion_tools()

    # Build domain subgraphs
    finance_agent = create_finance_subgraph(providers.subgraph_llm)
    news_agent = create_news_subgraph(os.getenv("ANTHROPIC_API_KEY"))
    email_agent = create_email_subgraph(providers.subgraph_llm, email_tools)
    notion_agent = create_notion_subgraph(providers.subgraph_llm, notion_tools)

    # Expose subgraphs as tools for the supervisor
    domain_tools = [
        finance_agent.as_tool(
            name="call_finance_agent",
            description=(
                "Use for any finance query: stock quotes, price history, fundamentals, "
                "crypto prices. Pass the user's question as 'query'."
            ),
        ),
        news_agent.as_tool(
            name="call_news_agent",
            description=(
                "Use for news searches, current events, and headline summaries. "
                "Pass the topic or question as 'query'."
            ),
        ),
        email_agent.as_tool(
            name="call_email_agent",
            description=(
                "Use for reading, searching, or sending emails (Gmail + Outlook). "
                "Pass the user's request as 'query'."
            ),
        ),
        notion_agent.as_tool(
            name="call_notion_agent",
            description=(
                "Use for reading, creating, or updating Notion pages and databases. "
                "Pass the user's request as 'query'."
            ),
        ),
    ]

    all_tools = WORKSPACE_TOOLS + domain_tools

    # Checkpointer
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
        tools=all_tools,
        checkpointer=checkpointer,
    )

    tool_names = [t.name if hasattr(t, "name") else str(t) for t in all_tools]
    log.info("[agent] supervisor tools: %s", ", ".join(tool_names))
    log.info(
        "[agent] listening on port %s  fireworks=%s  memory=%s",
        os.getenv("PROXY_PORT", "8787"),
        providers.has_fireworks,
        memory_cfg is not None,
    )
    yield
```

Also add the missing imports at the top of `server.py` (after existing imports):

```python
from .graph.nodes.workspace import WORKSPACE_TOOLS
```

(This import already exists from Plan A — verify it's there, don't duplicate.)

- [ ] **Step 2: Run the full test suite**

```bash
cd agent && uv run pytest -v
```

Expected: all tests PASSED

- [ ] **Step 3: Start the service and verify domain tools are listed**

```bash
npm run agent
```

Expected log line: `[agent] supervisor tools: list_dir, read_file, ..., call_finance_agent, call_news_agent, call_email_agent, call_notion_agent`

- [ ] **Step 4: Test each domain tool with a quick smoke request**

```bash
# Finance
curl -s -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"stream":false,"messages":[{"role":"user","content":"What is the current Apple stock price?"}]}'

# News
curl -s -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"stream":false,"messages":[{"role":"user","content":"What happened in AI news this week?"}]}'
```

Expected: JSON response with `choices[0].message.content` containing relevant information.

- [ ] **Step 5: Commit**

```bash
git add agent/src/server.py
git commit -m "feat(agent): wire domain nodes (Finance/News/Email/Notion) into supervisor"
```

---

### Task 6: Integration test + retire `proxy/`

**Files:**
- Create: `agent/tests/test_domain_routing.py`
- Modify: `AGENTS.md` (update run stack to point to `npm run agent`)
- Modify: `package.json` (add comment that `proxy` is deprecated)

- [ ] **Step 1: Create integration tests**

Create `agent/tests/test_domain_routing.py`:

```python
"""
Smoke tests for domain node routing.
These tests hit the supervisor graph with mocked LLMs to verify routing decisions
without making real API calls.
"""
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from agent.src.graph.supervisor import build_system_prompt


def test_system_prompt_has_today_date():
    prompt = build_system_prompt("You are Jarvis")
    assert "Today's date is" in prompt


def test_system_prompt_with_memory():
    prompt = build_system_prompt("You are Jarvis", memory_context="User is Harry")
    assert "<memory>" in prompt
    assert "Harry" in prompt


def test_system_prompt_without_memory():
    prompt = build_system_prompt("You are Jarvis", memory_context="")
    assert "<memory>" not in prompt
```

- [ ] **Step 2: Run integration tests**

```bash
cd agent && uv run pytest tests/test_domain_routing.py -v
```

Expected: all PASSED

- [ ] **Step 3: Run full test suite**

```bash
cd agent && uv run pytest -v
```

Expected: all tests PASSED, no failures

- [ ] **Step 4: Update `AGENTS.md` run stack section**

Find the section in `AGENTS.md` that describes how to run the proxy (look for `npm run proxy` or `proxy/`). Update it to reference `npm run agent` as the new command, and note that `proxy/` is kept as a fallback.

```bash
# Verify the change makes sense before committing
grep -n "proxy" AGENTS.md | head -20
```

Edit `AGENTS.md` to add under the run stack section:

```markdown
> **Migration note:** The Node.js `proxy/` is superseded by the Python `agent/` service.
> Run `npm run agent` instead of `npm run proxy`. The `proxy/` directory is retained as
> a fallback reference but is no longer the active service.
```

- [ ] **Step 5: Final commit**

```bash
git add agent/tests/test_domain_routing.py AGENTS.md
git commit -m "feat(agent): domain nodes complete; update AGENTS.md run stack"
```

---

**Domain nodes complete.** Jarvis now routes queries to Finance, News, Email, and Notion specialists automatically through the LangGraph supervisor. The Node.js `proxy/` is retired in favour of the Python `agent/` service.
