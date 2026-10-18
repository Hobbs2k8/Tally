"""QuickBooks Command Center - Agentverse HOSTED agent (runs 24/7 on agentverse.ai).

Unlike agents/command_center.py (a local mailbox agent that only works while your
laptop runs it), this file is pasted into an Agentverse hosted agent, so it stays
online and discoverable from ASI:One around the clock. It fronts a deployed
Command Center API (command-center/ on Vercel or any host).

Setup (full walkthrough in agentverse/DEPLOY.md):
  1. Deploy command-center/ (e.g. Vercel) and note the URL.
  2. agentverse.ai -> Agents -> + Launch an Agent -> Generate Agent, open the
     Build tab and replace agent.py with this file.
  3. Secrets tab (or .env in the editor), add:
       COMMAND_CENTER_URL      https://<your-deployment>.vercel.app   (required)
       COMMAND_CENTER_API_KEY  same value as on the deployment        (optional)
       COMMAND_CENTER_COMPANY  default company id                     (optional)
  4. Stop + Run, then paste agentverse/agentverse_profile.md into the agent's
     Overview so ASI:One can discover it.

Each chat message becomes POST /api/plan {request, companyId}. The NDJSON stream's
stage events become the "engine" footer (real timings, plan variants, verification
checks) and the last line {type: "result", result} becomes a markdown reply:
verdict, findings, top actions, scenario table, weekly-cash sparkline. Commands:
  company <id or name>   pick the books to answer from
  companies              list the companies
  help
Anything else is a question for the Command Center.
"""
import json
import os
import re
from datetime import datetime, timezone
from uuid import uuid4

import requests
from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    StartSessionContent,
    TextContent,
    chat_protocol_spec,
)

API_URL = os.environ.get("COMMAND_CENTER_URL", "").rstrip("/")
API_KEY = os.environ.get("COMMAND_CENTER_API_KEY", "")
DEFAULT_COMPANY = os.environ.get("COMMAND_CENTER_COMPANY", "company-002")
TIMEOUT = float(os.environ.get("COMMAND_CENTER_TIMEOUT", "90"))

# Hosted agents ignore custom Agent(...) settings: Agentverse supplies the
# name, seed, address and endpoint. Bare Agent() keeps the file portable.
agent = Agent()
chat_proto = Protocol(spec=chat_protocol_spec)

_ROASTLINE_INTRO = (
    "👋 **You've just become the owner of Roastline Coffee Roasters** — a wholesale coffee "
    "business with **$96k cash, 7 employees, and $24,778 of overdue customer invoices**. "
    "These are real (synthetic) QuickBooks books; I answer only from them."
)

HELP = (
    (_ROASTLINE_INTRO if DEFAULT_COMPANY == "company-002" else
     f"👋 **You've just become the owner of {DEFAULT_COMPANY}** (synthetic QuickBooks books; "
     "I answer only from them).")
    + "\n\nAsk me anything an owner would:\n"
    "- *Can I afford to hire two more people next quarter?*\n"
    "- *What happens to my cash if customers pay 45 days late?*\n"
    "- *Where am I losing money? Are my margins shrinking?*\n"
    "- *Are there any duplicate or suspicious charges in my books?*\n\n"
    "Want a different business? Say `companies` — there are 100, from bakeries to clinics — "
    "then `company 7` or `company roastline` to switch.\n\n"
    "🔒 Every number comes from a deterministic financial engine reading the books, never from "
    "an LLM. Nothing is sent or paid without your approval."
)

SPARK = "▁▂▃▄▅▆▇█"
SEV = {"high": "🔴", "medium": "🟠", "low": "🟡"}


# ---- formatting (pure) --------------------------------------------------------
def money(cents) -> str:
    if cents is None:
        return "n/a"
    d = round(cents / 100)
    return f"-${-d:,}" if d < 0 else f"${d:,}"


def _assumption(result: dict, key: str):
    for a in (result.get("simulation") or {}).get("assumptions", []):
        if a.get("id") == key:
            return a.get("value")
    return None


def sparkline(values: list) -> str:
    """Weekly closing cash as a unicode mini-chart."""
    if not values:
        return ""
    lo, hi = min(values), max(values)
    if hi == lo:
        return SPARK[4] * len(values)
    return "".join(SPARK[round((v - lo) / (hi - lo) * 7)] for v in values)


def _verdict(result: dict) -> str:
    sim = result.get("simulation")
    if sim:
        feasible = sim["result"].get("feasible", {})
        roles = {s.get("role"): s["id"] for s in sim["result"]["scenarios"]}
        prop_ok = feasible.get(roles.get("proposed"))
        rec_ok = feasible.get(roles.get("recommended"))
        if "proposed" in roles and prop_ok:
            return "## ✅ Yes — and here's the safest way to do it"
        if rec_ok:
            return ("## ⚠️ Not as asked — but there's a safe way" if "proposed" in roles
                    else "## ✅ Here's the safest plan")
        return "## ❌ Not safely — here's the least risky option"
    if result.get("findings"):
        return "## 🔎 What I found in your books"
    return "## 💡 Straight answer from your books"


def format_result(result: dict, stages: list | None = None) -> str:
    """Turn a PipelineResult (+ pipeline stage events) into a markdown chat reply."""
    if result.get("kind") == "clarify":
        lines = [result.get("question", "Which company do you mean?")]
        for c in result.get("candidates", [])[:5]:
            lines.append(f"- {c['id']}: {c['name']} ({c['industry']})")
        lines.append("Reply 'company <id>' and ask again.")
        return "\n".join(lines)

    company = result.get("company") or {}
    checks = result.get("validation") or []
    ok = sum(1 for c in checks if c.get("ok"))
    header = f"**{company.get('name', 'Company')}** · books as of {company.get('asOfDate', '?')}"
    if checks:
        header += f" · 📒 **{ok}/{len(checks)}** numbers verified against the company's own reports"
    out = [header, "", _verdict(result), "", (result.get("bottomLine") or {}).get("text", "No answer.")]

    findings = result.get("findings") or []
    if findings:
        out += ["", "**🔎 Findings**"]
        for f in findings[:4]:
            tag = "verified" if f.get("status") == "verified" else "hypothesis"
            out.append(f"- {SEV.get(f.get('severity'), '🟡')} **{f.get('title')}** — "
                       f"{f.get('detail', '')} _[{tag}]_")

    answer = result.get("answer")
    if answer:
        headline = answer.get("headline", "")
        # The bottom line often repeats the headline; don't show it twice.
        if headline and headline != (result.get("bottomLine") or {}).get("text"):
            out += ["", f"**{headline}**"]
        else:
            out += [""]
        for f in answer.get("facts", [])[:5]:
            v, unit = f.get("value"), f.get("unit")
            shown = money(v) if unit == "usd" else f"{v:.0%}" if unit == "pct" else f"{v:,} {unit}"
            out.append(f"- {f.get('label')}: **{shown}**")

    actions = result.get("actions") or []
    if actions:
        out += ["", "**📋 Do this first**"]
        for i, a in enumerate(actions[:3], 1):
            urg = f" · _{a['urgency']}_" if a.get("urgency") else ""
            out.append(f"{i}. **{a['title']}**{urg}")

    sim = result.get("simulation")
    if sim:
        r = sim["result"]
        delay = _assumption(result, "stressDelayDays")
        weeks = _assumption(result, "horizonWeeks") or 13
        stress = f"customers pay {delay} days late" if delay else "stress"
        out += ["", f"**🔮 {weeks}-week cash outlook** · reserve {money(_assumption(result, 'reserve'))} "
                    f"· stress test: {stress}", "",
                "| Plan | Lowest cash | Ending | Low under stress | Verdict |",
                "|---|---|---|---|---|"]
        rec_id = None
        for sc in r["scenarios"]:
            p = r["projections"][sc["id"]]["summary"]
            s = r["stressedProjections"][sc["id"]]["summary"]
            name = f"**{sc['name']}**" if sc.get("role") == "recommended" else sc["name"]
            verdict = "✅ Safe" if r["feasible"].get(sc["id"]) else "❌ Not safe"
            out.append(f"| {name} | {money(p['minCash'])} (wk {p['minWeek'] + 1}) | "
                       f"{money(p['endingCash'])} | {money(s['minCash'])} | {verdict} |")
            if sc.get("role") == "recommended":
                rec_id = sc["id"]
                rec_desc = sc.get("description")
        if rec_id:
            if rec_desc:
                out += ["", f"→ **The safe route:** {rec_desc}"]
            closings = [w["closing"] for w in r["projections"][rec_id].get("weeks", [])]
            if closings:
                lo_wk = min(range(len(closings)), key=closings.__getitem__) + 1
                out += ["", f"📈 Recommended plan, weekly cash: `{sparkline(closings)}` "
                            f"(lowest {money(min(closings))} in week {lo_wk})"]

    engine = []
    for st in stages or []:
        if st.get("status") == "done" and st.get("stage") != "rank":
            d = f" ({st['detail']})" if st.get("detail") else ""
            engine.append(f"{st.get('label', '').lower()}{d}")
    total = result.get("totalMs")
    if engine:
        tot = f" in **{total:.0f} ms**" if isinstance(total, (int, float)) else ""
        out += ["", f"⚙️ _Engine{tot}: " + " → ".join(engine) + "_"]

    out += ["", "🔒 Every number above was computed from the QuickBooks records by a deterministic "
                "engine — no LLM arithmetic. Nothing is sent or paid without your approval."]
    return "\n".join(out)


def resolve_company(query: str, companies: list) -> dict | None:
    """'company-007', '7', '007' or a name fragment like 'roastline'."""
    q = query.strip().lower()
    if re.fullmatch(r"\d{1,3}", q):
        q = f"company-{int(q):03d}"
    for c in companies:
        if c["id"].lower() == q:
            return c
    return next((c for c in companies if q and q in c["name"].lower()), None)


# ---- API calls ----------------------------------------------------------------
def _headers() -> dict:
    return {"content-type": "application/json", **({"x-api-key": API_KEY} if API_KEY else {})}


def _post_plan(request: str, company_id: str) -> tuple:
    """Returns (result, stage events) from the NDJSON stream."""
    resp = requests.post(f"{API_URL}/api/plan",
                         data=json.dumps({"request": request, "companyId": company_id}),
                         headers=_headers(), timeout=TIMEOUT)
    resp.raise_for_status()
    last, stages = None, []
    for line in resp.text.splitlines():
        if not line.strip():
            continue
        last = json.loads(line)
        if last.get("type") == "stage":
            stages.append(last)
    if not last:
        raise RuntimeError("empty response from the Command Center")
    if last.get("type") == "error":
        raise RuntimeError(last.get("message", "pipeline failed"))
    if last.get("type") != "result":
        raise RuntimeError("the Command Center stream ended before a result")
    return last["result"], stages


def _get_companies() -> list:
    resp = requests.get(f"{API_URL}/api/companies", headers=_headers(), timeout=15)
    resp.raise_for_status()
    return resp.json()


def reply_to(ctx: Context, sender: str, text: str) -> str:
    """Handle one chat message and return the reply text."""
    if not API_URL:
        return ("I'm not wired to a Command Center deployment yet. The operator needs to set the "
                "COMMAND_CENTER_URL secret on this agent (see agentverse/DEPLOY.md in the repo).")
    t = text.strip()
    low = t.lower()
    if low in ("", "help", "hi", "hello", "?"):
        return HELP
    try:
        if low in ("companies", "list companies", "company"):
            cs = _get_companies()
            return "Pick whose owner you want to be (`company <id or name>`):\n" + \
                "\n".join(f"- {c['id']}: {c['name']} ({c['industry']})" for c in cs)
        m = re.fullmatch(r"(?:use\s+)?company\s+(.+)", t, flags=re.I)
        if m:
            c = resolve_company(m.group(1), _get_companies())
            if not c:
                return f"I don't have a company matching '{m.group(1)}'. Say 'companies' to list them."
            ctx.storage.set(f"company:{sender}", c["id"])
            return (f"🏢 You now own **{c['name']}** ({c['id']}), a {c['industry']} business. "
                    "Ask me anything about it.")
        if len(t) < 3:
            return HELP
        company_id = ctx.storage.get(f"company:{sender}") or DEFAULT_COMPANY
        result, stages = _post_plan(t[:2000], company_id)
        return format_result(result, stages)
    except (requests.ConnectionError, requests.Timeout) as e:
        return f"I couldn't reach the Command Center at {API_URL} ({e}). Please try again in a minute."
    except Exception as e:  # keep the chat alive on any API problem
        return f"The Command Center couldn't answer that: {e}"


# ---- chat protocol ------------------------------------------------------------
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
            reply = reply_to(ctx, sender, item.text)
            ctx.logger.info(f"[reply] {reply.splitlines()[0] if reply else ''}")
            await ctx.send(sender, text_message(reply))
        elif isinstance(item, EndSessionContent):
            ctx.logger.info("Chat session ended")


@chat_proto.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    ctx.logger.debug(f"Acknowledged {msg.acknowledged_msg_id}")


agent.include(chat_proto, publish_manifest=True)


if __name__ == "__main__":
    agent.run()
