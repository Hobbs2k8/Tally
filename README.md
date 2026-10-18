# Tally

Ask your books before you make the call.

Tally lets a small business owner ask a money question in plain English on ASI:One, like "can I hire two people next quarter?" It reads that company's QuickBooks books, plays out the next 13 weeks, stress-tests the plan against late payments and cost spikes, and answers with the safest plan. Every number traces back to a record in the books.

When the books show a supplier raising prices, Tally's negotiation agent haggles with supplier agents for better terms. Nothing is sent, paid or agreed without the owner's approval.

Built at LA Hacks AI Hackathon 2026 for the Intuit QuickBooks (System One) and Fetch.ai ASI:One tracks.

## Who it's for

Small businesses on QuickBooks that can't afford a CFO. A part-time CFO costs thousands a month. Tally answers the same "can I afford this?" questions for the price of a subscription. We'd sell it to individual businesses as a QuickBooks add-on: the owner connects their books once, then asks Tally before they hire, spend or pay themselves.

QuickBooks reports show what already happened. Tally shows what happens next if you make a decision, and whether you're still okay when things go wrong.

## How it works

```
Owner in ASI:One
   │  "Can I afford to hire two people?"
   ▼
Tally agent (Fetch.ai uAgent, Agent Chat Protocol)      agentverse/agent.py (hosted on Agentverse)
   │  POST /api/plan
   ▼
Planning engine (Next.js API on Vercel)                 command-center/
   ├─ Gemini reads the question and picks the checks (never does the math)
   ├─ deterministic engine: cash projection, stress test, 336 plan variants
   └─ every number checked against the dataset's own reports
   ▼
One plan back in chat: bottom line, top actions, cash low points

Negotiation (when a supplier is worth renegotiating)
Buyer agent ⇄ 3 supplier agents, in parallel            agents/buyer.py, core/market.py
   └─ look-ahead search with a running guess of each supplier's secret lowest price
```

## Repo layout

| Folder | What's in it |
| --- | --- |
| `command-center/` | The planning engine and API (Next.js, TypeScript). Full docs in [`command-center/README.md`](command-center/README.md) |
| `agentverse/` | The Tally chat agent as an Agentverse hosted agent, runs 24/7. Setup in [`agentverse/DEPLOY.md`](agentverse/DEPLOY.md) |
| `agents/` | The same chat agent as a local mailbox agent, plus the buyer (negotiator) and supplier agents |
| `core/` | Negotiation logic: search, belief over the supplier's floor, scout, marketplace |
| `supplier/` | Simulated supplier businesses and their private pricing rules |
| `scripts/` | Local tests and terminal demos |
| `data/` | QuickBooks synthetic dataset (company-001 committed, the rest via `scripts/fetch_data.sh`) |

## Run it

### 1. Planning engine

```bash
cd command-center
npm install
npm run dev            # http://localhost:3000
npm test               # 370 tests
npm run hero -- --summary   # runs the demo question in the terminal
```

No keys needed. Without `GEMINI_API_KEY` it uses a rules-based parser. Add keys in `command-center/.env.local` (see its `.env.example`).

### 2. Tally chat agent

The live version runs as a hosted agent on Agentverse and calls the engine deployed on Vercel, so nothing needs to run on a laptop. To set that up, follow [`agentverse/DEPLOY.md`](agentverse/DEPLOY.md): deploy `command-center/` to Vercel, paste `agentverse/agent.py` into a new Agentverse agent, and set the `COMMAND_CENTER_URL` secret.

To run the agent locally instead, from the repo root:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env    # set COMMAND_CENTER_SEED to any long random string, and keep it
python -m agents.command_center
```

Set `COMMAND_CENTER_URL` in `.env` to the Vercel URL, or leave it as `http://localhost:3000` when running the engine locally. The agent prints an Agentverse inspector link once: open it, click Connect, choose Mailbox. Then find it in ASI:One.

Chat: ask any question, `company <id or name>` to switch company (default company-002, Roastline Coffee Roasters), `companies` to list them.

### 3. Negotiation agents

```bash
python run.py           # buyer + supplier agents (set BUYER_SEED and SUPPLIER_SEED in .env)
python -m scripts.run_market                 # whole marketplace in one process, no agents
python -m scripts.run_terminal_negotiation   # one negotiation, round by round
```

The buyer sends one request to three simulated suppliers, negotiates with each in parallel, rules out anyone who can't meet quantity, deadline or the owner's cash floor, and recommends the best feasible deal. Chat commands: `scan`, `negotiate`, `status`, `compare`, `approve`, `decline`, `floor <dollars>`.

## Results

- Planning engine: 100% calculation accuracy and company matching on 28 known-answer cases, 12 of 12 planted problems caught, under 10 ms per answer. Numbers reconcile exactly with the dataset's reports for all 100 companies. Details in [`command-center/docs/EVAL_RESULTS.md`](command-center/docs/EVAL_RESULTS.md).
- Negotiation (bakery, 124 negotiations): look-ahead search saved 9.2% on average, split-the-difference 7.0%, an LLM negotiator 3.3%. Search takes under 2 ms per move.

## Honest limits

- Supplier agents and their secret lowest prices are simulated.
- The real System One model was never run (no TypeSafe key). The System One provider runs on an open-source stand-in model and labels itself that way.
- Gemini works live on single requests but wasn't run across the full eval (free-tier limits).
- One year of history per company, so no seasonality.

## Data changes

None to Intuit's dataset. The eval plants test problems in in-memory copies only. See [`command-center/docs/SYNTHETIC_CHANGES.md`](command-center/docs/SYNTHETIC_CHANGES.md). For the negotiation demo, on-time payment allows a 3-day grace period, since every bill in the data is paid 1 to 3 days late.

## Team

Arnav, Akhil, Timi and Gibran.
