"""QuickBooks Command Center as a uAgent, so an owner can ask it questions from ASI:One.

Wraps the Command Center Next.js API (command-center/, `npm run dev`). Each chat
message becomes POST /api/plan {request, companyId}; the NDJSON stream's last line
is {type: "result", result}. The reply is plain text: bottom line, top 3 actions
and the key scenario numbers. Commands:
  company <id or name>   pick the books to answer from (default company-002)
  companies              list the companies
  help
Anything else is a question for the Command Center.

    python -m agents.command_center      # run alongside `npm run dev` in command-center/
"""
import asyncio
import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from urllib.parse import quote
from uuid import uuid4

import agents.config  # noqa: F401  (loads .env and SSL certs before uagents builds its HTTP clients)
from agents.config import require_seed
from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    StartSessionContent,
    TextContent,
    chat_protocol_spec,
)

API_URL = os.environ.get("COMMAND_CENTER_URL", "http://localhost:3000").rstrip("/")
# Needed when the deployment sets COMMAND_CENTER_API_KEY on POST /api/plan.
API_KEY = os.environ.get("COMMAND_CENTER_API_KEY", "")
DEFAULT_COMPANY = os.environ.get("COMMAND_CENTER_COMPANY", "company-002")
PORT = int(os.environ.get("COMMAND_CENTER_PORT", "8002"))
TIMEOUT = float(os.environ.get("COMMAND_CENTER_TIMEOUT", "120"))
# Off only in the local test, which runs without Agentverse.
ONLINE = os.environ.get("COMMAND_CENTER_MAILBOX", "1") != "0"

SEED = require_seed("COMMAND_CENTER_SEED")

agent = Agent(
    name="quickbooks-command-center",
    seed=SEED,
    port=PORT,
    mailbox=ONLINE,   # reachable from ASI:One through Agentverse
    description="QuickBooks Command Center: a small-business finance agent. Ask a plain-English question "
                "(can I hire, run a promotion, survive late payers) and it answers from the company's "
                "QuickBooks books with a cash projection, a stress test and the top actions to take.",
    readme_path=os.path.join(os.path.dirname(__file__), "command_center_readme.md"),
    publish_agent_details=ONLINE,
)

chat_proto = Protocol(spec=chat_protocol_spec)

HELP = (
    "I'm the QuickBooks Command Center. Ask me a business question in plain English and I'll answer "
    "from the company's books with a 13-week cash projection, a stress test and the top actions.\n"
    "Try: 'Can I afford to hire two more people next quarter?' or 'What if customers pay 30 days late?'\n"
    "Commands: 'company <id or name>' (for example 'company 3' or 'company roastline'), 'companies', "
    f"'help'. The default company is {DEFAULT_COMPANY}. Demo data is synthetic."
)

_company: dict[str, str] = {}   # sender address -> company id


# ---- formatting (pure, used by the test) -------------------------------------
def money(cents: float | None) -> str:
    if cents is None:
        return "n/a"
    d = round(cents / 100)
    return f"-${-d:,}" if d < 0 else f"${d:,}"


def _assumption(result: dict, key: str):
    for a in (result.get("simulation") or {}).get("assumptions", []):
        if a.get("id") == key:
            return a.get("value")
    return None


def format_result(result: dict) -> str:
    """Turn a PipelineResult into a short plain-text reply."""
    if result.get("kind") == "clarify":
        lines = [result.get("question", "Which company do you mean?")]
        for c in result.get("candidates", [])[:5]:
            lines.append(f"- {c['id']}: {c['name']} ({c['industry']})")
        lines.append("Reply 'company <id>' and ask again.")
        return "\n".join(lines)

    company = result.get("company") or {}
    out = [f"{company.get('name', 'Company')} ({company.get('id', '?')}), books as of {company.get('asOfDate', '?')}",
           "", f"Bottom line: {(result.get('bottomLine') or {}).get('text', 'No answer.')}"]

    answer = result.get("answer")
    if answer:
        out += ["", answer.get("headline", "")]
        for f in answer.get("facts", [])[:5]:
            v, unit = f.get("value"), f.get("unit")
            shown = money(v) if unit == "usd" else f"{v:.0%}" if unit == "pct" else f"{v:,} {unit}"
            out.append(f"- {f.get('label')}: {shown}")

    actions = result.get("actions") or []
    if actions:
        out += ["", "Top actions:"]
        for i, a in enumerate(actions[:3], 1):
            out.append(f"{i}. {a['title']} ({a.get('urgency', '')})")

    sim = result.get("simulation")
    if sim:
        r = sim["result"]
        delay = _assumption(result, "stressDelayDays")
        weeks = _assumption(result, "horizonWeeks") or 13
        stress_label = f"if customers pay {delay} days late" if delay else "under stress"
        out += ["", f"Scenarios ({weeks} weeks, reserve {money(_assumption(result, 'reserve'))}):"]
        for sc in r["scenarios"]:
            p = r["projections"][sc["id"]]["summary"]
            s = r["stressedProjections"][sc["id"]]["summary"]
            ok = "Safe" if r["feasible"].get(sc["id"]) else "Not safe"
            out.append(f"- {sc['name']}: lowest cash {money(p['minCash'])} (week {p['minWeek'] + 1}), "
                       f"ending {money(p['endingCash'])}, low {money(s['minCash'])} {stress_label}. {ok}.")
            if sc.get("role") == "recommended" and sc.get("description"):
                out.append(f"  ({sc['description']})")

    out += ["", "Nothing is sent or paid without your approval. Full plan and evidence: the Command Center web app."]
    return "\n".join(out)


# ---- API calls ---------------------------------------------------------------
def _post_plan(request: str, company_id: str) -> dict:
    body = json.dumps({"request": request, "companyId": company_id}).encode()
    headers = {"content-type": "application/json", **({"x-api-key": API_KEY} if API_KEY else {})}
    req = urllib.request.Request(f"{API_URL}/api/plan", data=body, headers=headers)
    last = None
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        for raw in resp:
            line = raw.strip()
            if line:
                last = json.loads(line)
    if not last:
        raise RuntimeError("empty response from the Command Center")
    if last.get("type") == "error":
        raise RuntimeError(last.get("message", "pipeline failed"))
    if last.get("type") != "result":
        raise RuntimeError("the Command Center stream ended before a result")
    return last["result"]


def _get_companies() -> list[dict]:
    with urllib.request.urlopen(f"{API_URL}/api/companies", timeout=15) as resp:
        return json.load(resp)


def resolve_company(query: str, companies: list[dict]) -> dict | None:
    """'company-007', '7', '007' or a name fragment like 'roastline'."""
    q = query.strip().lower()
    if re.fullmatch(r"\d{1,3}", q):
        q = f"company-{int(q):03d}"
    for c in companies:
        if c["id"].lower() == q:
            return c
    return next((c for c in companies if q and q in c["name"].lower()), None)


def _unreachable(e: Exception) -> str:
    return (f"I couldn't reach the Command Center at {API_URL} ({e}). "
            "Start it with `npm run dev` in command-center/ and try again.")


async def reply_to(sender: str, text: str) -> str:
    """Handle one chat message and return the reply text."""
    t = text.strip()
    low = t.lower()
    if low in ("", "help", "hi", "hello", "?"):
        return HELP
    try:
        if low in ("companies", "list companies", "company"):
            cs = await asyncio.to_thread(_get_companies)
            return "Companies:\n" + "\n".join(f"- {c['id']}: {c['name']} ({c['industry']})" for c in cs)
        m = re.fullmatch(r"(?:use\s+)?company\s+(.+)", t, flags=re.I)
        if m:
            c = resolve_company(m.group(1), await asyncio.to_thread(_get_companies))
            if not c:
                return f"I don't have a company matching '{m.group(1)}'. Say 'companies' to list them."
            _company[sender] = c["id"]
            return f"Company set to {c['name']} ({c['id']}). Ask me a question."
        if len(t) < 3:
            return HELP
        result = await asyncio.to_thread(_post_plan, t[:2000], _company.get(sender, DEFAULT_COMPANY))
        return format_result(result)
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        return _unreachable(e)
    except Exception as e:  # keep the chat alive on any API problem
        return f"The Command Center couldn't answer that: {e}"


# ---- chat protocol -----------------------------------------------------------
def text_message(text: str) -> ChatMessage:
    return ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(),
                       content=[TextContent(type="text", text=text)])


@chat_proto.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc),
                                               acknowledged_msg_id=msg.msg_id))
    for item in msg.content:
        if isinstance(item, StartSessionContent):
            await ctx.send(sender, text_message(HELP))
        elif isinstance(item, TextContent):
            ctx.logger.info(f"[from {sender[:16]}] {item.text}")
            reply = await reply_to(sender, item.text)
            ctx.logger.info(f"[reply] {reply.splitlines()[0] if reply else ''}")
            await ctx.send(sender, text_message(reply))
        elif isinstance(item, EndSessionContent):
            ctx.logger.info("Chat session ended")


@chat_proto.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    ctx.logger.debug(f"Acknowledged {msg.acknowledged_msg_id}")


agent.include(chat_proto, publish_manifest=ONLINE)


def register_with_agentverse():
    """Agentverse 'Connect an agent' flow: with AGENTVERSE_KEY set (an API key from
    agentverse.ai), list this agent under your Agentverse account so it shows up in
    your dashboard and ASI:One without the manual inspector Connect step. Optional;
    the agent runs fine without it."""
    key = os.environ.get("AGENTVERSE_KEY", "").strip()
    if not key:
        return
    from uagents_core.utils.registration import (
        RegistrationRequestCredentials,
        register_chat_agent,
    )
    name = os.environ.get("AGENTVERSE_AGENT_NAME", "Command-Center")
    handle = os.environ.get("AGENTVERSE_HANDLE", "odumosu")
    try:
        register_chat_agent(
            name,
            handle,
            active=True,
            credentials=RegistrationRequestCredentials(
                agentverse_api_key=key,
                agent_seed_phrase=SEED,
            ),
        )
        print(f"Registered with Agentverse as {handle}/{name}")
    except Exception as e:
        print(f"Agentverse registration failed ({e}); continuing without it.")


if __name__ == "__main__":
    register_with_agentverse()
    print(f"command center agent {agent.address}  (API {API_URL}, default {DEFAULT_COMPANY})")
    inspector = (f"https://agentverse.ai/inspect/?uri={quote(f'http://127.0.0.1:{PORT}', safe='')}"
                 f"&address={agent.address}")
    print("\nConnect to Agentverse (one time): open this link, click Connect, choose Mailbox:")
    print(f"  {inspector}")
    print("Then find 'quickbooks-command-center' in ASI:One (or chat from its Agentverse page).\n")
    agent.run()
