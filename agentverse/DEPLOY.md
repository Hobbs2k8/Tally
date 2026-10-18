# Putting the Command Center on Agentverse, for real

The repo already has `agents/command_center.py`, a **mailbox** agent: it only exists while
your laptop runs `python -m agents.command_center` *and* `npm run dev`. This folder turns the
same agent into an Agentverse **hosted** agent that runs 24/7 on agentverse.ai with nothing
on your machine.

Two pieces:

```
ASI:One / other agents
        │  Agent Chat Protocol
        ▼
Agentverse hosted agent          agentverse/agent.py   (paste into agentverse.ai)
        │  HTTPS: POST /api/plan, GET /api/companies
        ▼
Command Center API               command-center/       (deploy to Vercel)
```

The hosted agent must call a public URL, so the Next.js app gets deployed first.

## 1. Deploy the Command Center API (Vercel, ~5 minutes)

The app is self-contained: the compiled dataset for all 100 companies is committed, and
`next.config.ts` already tells Vercel to bundle it (`outputFileTracingIncludes`).

1. Push this repo to GitHub (or use `npx vercel` from `command-center/`).
2. On [vercel.com](https://vercel.com): **Add New → Project**, import the repo,
   set **Root Directory** to `command-center`. Framework is auto-detected (Next.js).
3. Environment variables (all optional, but recommended):
   - `GEMINI_API_KEY` — enables Gemini intent extraction and wording. Without it the app
     runs on the deterministic provider, which still answers every eval question.
   - `COMMAND_CENTER_API_KEY` — any long random string. When set, `POST /api/plan` requires
     this value in an `x-api-key` header from server-to-server callers (the agent); the
     app's own web UI still works. Leave unset and the API is open, fine for a hackathon.
4. Deploy, then sanity-check from a terminal:

```bash
curl -s https://YOUR-APP.vercel.app/api/companies | head -c 300
```

```bash
curl -s -X POST https://YOUR-APP.vercel.app/api/plan -H "content-type: application/json" -H "x-api-key: YOUR-KEY-IF-SET" -d "{\"request\":\"Can I afford to hire two more people next quarter?\",\"companyId\":\"company-002\"}" | tail -n 1
```

The last NDJSON line should be `{"type":"result","result":{...}}`.

Notes:
- `POST /api/plan` declares `maxDuration = 60`; a cold start plus two Gemini calls fits.
- Any other host (Render, Railway, Fly.io) works the same: `npm run build && npm start`.

## 2. Put the agent on Agentverse

Agentverse offers two ways in, and its "Create or Connect an Agent" wizard pushes the
second. Know which one you're in:

| | **Path A: hosted agent** (recommended) | **Path B: "Connect your agent" wizard** |
|---|---|---|
| Where the agent runs | On Agentverse's servers | On **your machine** (`python -m agents.command_center`) |
| Online when your laptop is off | **Yes** | No |
| Code | paste `agentverse/agent.py` in the web editor | registration is built into `agents/command_center.py` |
| Registration snippet (`register_chat_agent`) | **not needed** | handled automatically when `AGENTVERSE_KEY` is set |

### Path A: hosted agent (24/7, recommended)

1. Sign in at [agentverse.ai](https://agentverse.ai) → **Agents** → **+ New Agent** →
   **Blank agent**. Name it `quickbooks-command-center`.
2. In the editor, replace the contents of `agent.py` with [`agentverse/agent.py`](agent.py)
   from this repo. It is one self-contained file: only `uagents`, `uagents_core` and
   `requests`, all on Agentverse's allowed-imports list. (No Bureau: hosted projects run a
   single agent, which is why the DealRoom buyer/supplier marketplace stays a mailbox agent.)
3. Open the **Secrets** tab and add:
   - `COMMAND_CENTER_URL` = `https://YOUR-APP.vercel.app` (required)
   - `COMMAND_CENTER_API_KEY` = the same value you set on Vercel (only if you set one)
   - `COMMAND_CENTER_COMPANY` = default company id (optional, default `company-002`)
4. Press **Run**. The log should show the agent starting and the chat protocol manifest
   being published; the agent now has a permanent `agent1q...` address and stays up when
   you close the tab.
5. On the agent's **Overview** page, paste [`agentverse/agentverse_profile.md`](agentverse_profile.md)
   as the README and keep the tag badges: that text is what makes the agent discoverable
   and well-ranked in ASI:One.

### Path B: the "Connect your agent" wizard (agent runs on your machine)

If you're in the wizard that shows a `register_chat_agent(...)` snippet (name
`Command-Center`, username `odumosu`): that flow registers an agent that keeps running
on your own machine. The snippet is already integrated into `agents/command_center.py`,
so **don't paste it anywhere** — just set the env vars and run:

1. In the repo root `.env`:
   - `COMMAND_CENTER_SEED` — keep whatever you already use (the registered address comes from it)
   - `AGENTVERSE_KEY` — an API key from agentverse.ai (Profile → API Keys)
   - `COMMAND_CENTER_URL=https://YOUR-APP.vercel.app` and `COMMAND_CENTER_API_KEY` to answer
     from the deployed brain, or leave the localhost default and keep `npm run dev` running
2. `python -m agents.command_center` — on startup it prints
   `Registered with Agentverse as odumosu/Command-Center`, and the agent appears under
   your Agentverse account without the manual inspector Connect step.
3. Remember: it answers only while that terminal stays open. For 24/7 without Path A,
   run the same command on any small always-on box (Render background worker, a VPS, a
   spare machine).

## 3. Test it

- **Agentverse**: open the agent's profile → **Chat with Agent** → say `help`, then
  `Can I afford to hire two more people next quarter?`
- **ASI:One**: on [asi1.ai](https://asi1.ai), enable **Agents** and ask it to find the
  QuickBooks Command Center, or reference `@quickbooks-command-center`; new agents can take
  a little while to be indexed.
- `companies` and `company roastline` switch books; the choice is remembered per sender
  (`ctx.storage`, survives restarts).

## Troubleshooting

| Symptom | Cause |
|---|---|
| "I'm not wired to a Command Center deployment yet" | `COMMAND_CENTER_URL` secret missing — add it and restart the agent |
| "The Command Center couldn't answer that: 401" | `COMMAND_CENTER_API_KEY` missing on the agent or different from Vercel's |
| "I couldn't reach the Command Center" / timeouts | deployment asleep or URL wrong; try the `curl` checks above |
| Replies cite no Gemini wording | expected without `GEMINI_API_KEY`: the deterministic provider answers |
| Agent not found in ASI:One | wait for indexing; make sure the README with tag badges is saved and the agent is Running |

## What stays local

`agents/command_center.py` (mailbox) is still useful for development: run it against
`http://localhost:3000` to test changes before redeploying. The DealRoom buyer + 3-supplier
marketplace (`run.py`) needs multiple agents in one process, YAML data and the Anthropic
SDK, so it is not hostable as-is; to make *it* permanent, run it on any small VM with
mailbox mode, or split each supplier into its own hosted agent speaking the
`agents/messages.py` models.
