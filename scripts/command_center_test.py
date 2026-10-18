"""Local check of the Command Center agent through the chat protocol, without Agentverse.

Needs the Command Center running (`npm run dev` in command-center/). First checks the
reply formatter and company lookup against the live API, then runs the agent and a
fake owner agent in one Bureau and sends plain-text ChatMessages.
    python -m scripts.command_center_test
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["COMMAND_CENTER_MAILBOX"] = "0"   # no Agentverse in the local test
os.environ.setdefault("COMMAND_CENTER_SEED", "quickbooks command center local test seed")

import agents.config  # noqa: F401  (env + certs before uagents)
from uagents import Agent, Bureau, Context, Protocol
from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage, TextContent, chat_protocol_spec

from agents import command_center as cc

SCRIPT = ["help", "company roastline", "Can I afford to hire two more people next quarter?",
          "company 1", "What if customers pay 30 days late?", "company nowhere"]


def check(name: str, ok: bool) -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}", flush=True)
    if not ok:
        failures.append(name)


failures: list[str] = []


def direct_checks() -> None:
    try:
        companies = cc._get_companies()
    except Exception as e:
        sys.exit(f"Command Center not reachable at {cc.API_URL} ({e}). Run `npm run dev` in command-center/ first.")
    check("resolve 'company-002'", (cc.resolve_company("company-002", companies) or {}).get("id") == "company-002")
    check("resolve '7'", (cc.resolve_company("7", companies) or {}).get("id") == "company-007")
    check("resolve 'roastline'", (cc.resolve_company("roastline", companies) or {}).get("id") == "company-002")
    check("resolve unknown -> None", cc.resolve_company("nowhere", companies) is None)
    check("money(-3105000) == -$31,050", cc.money(-3105000) == "-$31,050")
    text = cc.format_result(cc._post_plan("Can I afford to hire two more people next quarter?", "company-002"))
    check("reply has bottom line", "Bottom line:" in text)
    check("reply has top actions", "Top actions:\n1." in text)
    check("reply has scenario numbers", "Recommended plan: lowest cash $" in text)
    print("\n" + text + "\n", flush=True)


owner = Agent(name="fake-cc-owner", seed="command center fake owner for local chat test")
owner_proto = Protocol(spec=chat_protocol_spec)
acks: list = []
replies: list[str] = []


@owner_proto.on_message(ChatMessage)
async def on_reply(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(timestamp=msg.timestamp, acknowledged_msg_id=msg.msg_id))
    for c in msg.content:
        if isinstance(c, TextContent):
            replies.append(c.text)
            print(f"\n<<< COMMAND CENTER:\n{c.text}", flush=True)


@owner_proto.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    acks.append(msg.acknowledged_msg_id)


owner.include(owner_proto)


@owner.on_event("startup")
async def run_script(ctx: Context):
    await asyncio.sleep(2)
    for text in SCRIPT:
        n = len(replies)
        print(f"\n>>> OWNER: {text}", flush=True)
        await ctx.send(cc.agent.address, text_message(text))
        for _ in range(int(cc.TIMEOUT)):   # one reply per message; plans can take a few seconds
            if len(replies) > n:
                break
            await asyncio.sleep(1)
    await asyncio.sleep(1)
    check(f"acknowledgements {len(acks)} of {len(SCRIPT)}", len(acks) == len(SCRIPT))
    check(f"replies {len(replies)} of {len(SCRIPT)}", len(replies) == len(SCRIPT))
    if len(replies) == len(SCRIPT):
        check("company set to Roastline", "Roastline Coffee Roasters (company-002)" in replies[1])
        check("hiring answer for company-002", "(company-002)" in replies[2] and "Bottom line:" in replies[2])
        check("late-payer answer for company-001", "(company-001)" in replies[4] and "Bottom line:" in replies[4])
        check("unknown company handled", "don't have a company" in replies[5])
    print(f"\n{'ALL PASSED' if not failures else 'FAILED: ' + ', '.join(failures)}", flush=True)
    os._exit(1 if failures else 0)


text_message = cc.text_message

if __name__ == "__main__":
    direct_checks()
    Bureau(agents=[cc.agent, owner], port=8003, endpoint="http://127.0.0.1:8003/submit").run()
