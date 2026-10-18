# DealRoom

> **New: QuickBooks Command Center** lives in [`command-center/`](command-center/README.md): a Next.js app that turns a plain-English financial decision into one evidence-backed action plan (Gemini routing + a deterministic engine, Sentry tracing). `cd command-center && npm install && npm run dev`.


A negotiating purchasing agent for small businesses. LA Hacks AI Hackathon 2026: Intuit QuickBooks (System One models) track and Fetch.ai ASI:One Agent Challenge.

A **buyer agent** reads a small business's QuickBooks accounts-payable data, finds a bill worth negotiating (price creep, a reliable payment history, a bill due near payroll), asks the owner in ASI:One whether to negotiate, haggles with a **supplier agent**, and asks the owner to approve the final deal. Nothing is agreed without owner approval.

> Status: all 5 build steps done, plus a multi-supplier marketplace. The buyer chats over ACP in ASI:One, sends one request to three supplier agents, negotiates with each in parallel, and recommends the best *feasible* deal for the owner to approve. It uses TypeSafe Jev to predict supplier replies when `TYPESAFE_API_KEY` is set. All suppliers are simulated.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in seeds; API keys are optional
```

Python 3.13 works with uagents 0.26.1.

## Data

`data/company-001/` (Hearthloaf Bakeries) is committed so the demo runs without downloading anything. To get all 100 companies:

```bash
./scripts/fetch_data.sh
```

Each company lives at `data/company-XXX/rwm-v4/world-<id>/`, with one YAML file per entity type; field reference is in `SCHEMA.md` next to the YAML. Agents must never read a `hidden/` folder; the participant download does not include one, and `.gitignore` blocks it.

## Marketplace: three suppliers, negotiated in parallel

All suppliers are **simulated** businesses with their own private profiles (`supplier/profiles.py`):

| Supplier | List price | Delivery | Payment | Capacity | Reliability | Style |
| --- | --- | --- | --- | --- | --- | --- |
| Your current vendor (incumbent; Ironclad Larkspur for the bakery) | today's price | 4 days | net 30 (up to 45) | 2,000 | 97% | stubborn |
| Harborline Wholesale | 8% lower | 9 days | upfront only | 1,500 | 86% | walker |
| Prairie Oven Supply | 3% lower | 3 days | net 45 | 600 | 94% | eager |

How a request runs (`core/market.py`):

1. The owner says `negotiate`. The buyer sends one request (`REQ-…`) to all three suppliers. It shares only what the owner authorized: the item, the quantity, the deadline and today's price. Suppliers never see the ledger, cash balance or cash floor.
2. Each supplier answers from its own policy. Each negotiation (`NEG-…`) has its own state, belief and history, and every message gets a transaction ID (`TX-…`). A reply can only touch its own negotiation.
3. The buyer counters each supplier in parallel. Hard constraints come first:
   - Quantity is firm: a supplier offering fewer units is out.
   - Delivery must meet the deadline: the buyer asks once, then rules the supplier out.
   - Payment terms a supplier insists on narrow what the buyer can offer.
   - Cash floor: paying now must not take cash below the owner's floor before payroll.
4. A deal exists only when a supplier sends `Accept` for the exact terms offered.
5. Deals are ranked by **feasibility, then cost plus a reliability risk charge** (`(1 - reliability) x total`), not price alone. In the bakery demo the cheapest supplier, Harborline, can't deliver in time. Even with a 10-day deadline it loses on reliability.
6. The owner approves the recommended deal, or names another feasible one. The chosen supplier gets `Confirm`, after which its terms are locked; the others get `Cancel`. The owner can also `decline`. Suppliers that go quiet time out after 30 s, and offers lapse if the owner doesn't decide within 15 minutes.

The full audit trail is in `demo_state.json` (`audit`): who sent what, which constraint ruled a deal out, and why the buyer countered. Suppliers' secret floors go to `supplier_secret.json`, for the end-of-demo reveal only.

**Judge controls** (simulation events on the supplier side; the buyer only sees the replies):

- Chat: `judge disrupt prairie 100`, `judge restore prairie`
- Terminal (while `run.py` runs): `python -m scripts.judge disrupt prairie 100`, `python -m scripts.judge reset`

If a supplier loses capacity, it offers a partial quantity, which the buyer rules out. If it had already accepted, it withdraws within about 2 s, and the buyer re-ranks and tells the owner the new recommendation. The owner can also change the cash floor live with `floor 97000`, which pushes deals to pay later.

Quick check without agents (everything in one process):

```bash
python -m scripts.run_market                                # Prairie recommended, Harborline misses the deadline
python -m scripts.run_market --disrupt prairie=200          # Prairie can't cover 255: Ironclad wins
python -m scripts.run_market --disrupt-after-agree prairie=100   # Prairie withdraws; re-ranked to Ironclad
python -m scripts.run_market --cash-floor 97000             # paying now breaks the floor: deals move to net 45
python -m scripts.run_market --company company-063          # rent: competitors decline, landlord negotiates alone
```

## Run the agents and chat from ASI:One

```bash
python run.py
```

On startup `run.py` prints an Agentverse inspector link for the buyer. **One time per seed:** open it while `run.py` is running, sign in, click **Connect**, and choose **Mailbox**. After that the buyer (`dealroom-buyer`) is reachable from ASI:One and from its Agentverse page. Until then the log says `Agent mailbox not found`, which is expected.

Chat commands (plain text): `scan`, `negotiate`, `passive` / `balanced` / `aggressive`, `status`, `compare`, `audit`, `floor <dollars>`, `approve` / `approve <supplier>`, `decline`, plus the judge controls above. The buyer acknowledges every message, reports as each supplier finishes, and asks for approval once all have answered.

Test the chat locally without ASI:One (a fake owner agent sends the commands):

```bash
python -m scripts.chat_smoke_test
```

Other ways to run:

```bash
python run.py --auto                       # buyer scans and negotiates on startup (logs only)
python run.py --auto --mode aggressive
SUPPLIER_PERSONALITY=walker SUPPLIER_RNG_SEED=11 python run.py --auto
```

Both agents run in one Bureau on port 8000 (`BUREAU_PORT`). Supplier settings are optional env vars: `SUPPLIER_PERSONALITY`, `SUPPLIER_SEASON`, `SUPPLIER_RNG_SEED`. The "not enough funds to register on Almanac contract" warnings are expected: the agents register through the Almanac API instead, which is free.

## Run a negotiation in the terminal (no API keys needed)

```bash
python -m scripts.run_terminal_negotiation                       # random supplier
python -m scripts.run_terminal_negotiation --personality bluffer --mode aggressive --seed 7
python -m scripts.run_terminal_negotiation --cash-floor 100000   # prepaying would break the floor
```

Options: `--personality stubborn|desperate|bluffer|walker`, `--season busy|normal|slow`, `--mode passive|balanced|aggressive`, `--cash-floor`, `--seed`, `--company`. Each round prints the buyer's belief range, the top moves it considered, and both messages. The script writes `demo_state.json` (buyer) and `supplier_secret.json` (reveal).

## Layout

| File | What it does |
| --- | --- |
| `core/data.py` | Loads a company's YAML; refuses `hidden/` |
| `core/scout.py` | Per-vendor stats (spend, on-time rate, price change, open bills near payroll), best opportunity, cash context |
| `core/offers.py` | `Offer(price, quantity, pay_in_days)` |
| `core/belief.py` | Weighted samples of the supplier's floor; shrinks after each reply |
| `core/predictor.py` | `SupplierPredictor` interface, `HeuristicPredictor`, `make_predictor()` (Jev if the key is set) |
| `core/jev.py` | `JevPredictor`: TypeSafe Jev via `typesafe-sdk` 0.7.5, batched and concurrent, heuristic fallback |
| `core/search.py` | 8 candidate moves x 40 sampled suppliers x 3-round playouts, 2 s limit |
| `core/score.py` | Dollars saved, minus a huge penalty for breaking the cash floor |
| `core/negotiator.py` | Buyer session loop; writes `demo_state.json` every round |
| `core/writer.py` | Message text via Claude (`ANTHROPIC_API_KEY`), template fallback |
| `supplier/policy.py` | Rule-based supplier: secret floor, personality, season, prepay, terms. Imports nothing from `core/` |
| `scripts/run_terminal_negotiation.py` | Step 2 demo (`--company company-063` to try another business) |
| `scripts/sweep_companies.py` | Scout + one negotiation for every company in `data/`; prints a summary |
| `core/market.py` | One request across several suppliers: per-supplier legs, IDs, feasibility ranking, approval, audit |
| `supplier/profiles.py` | The three simulated supplier businesses (private to the supplier side) |
| `supplier/controls.py`, `scripts/judge.py` | Judge-only capacity disruptions |
| `scripts/run_market.py` | In-process marketplace run with judge flags |
| `agents/messages.py` | `NegotiationStart`, `Offer`, `Accept`, `Reject` (uagents Models) |
| `agents/config.py` | Loads `.env` (seeds) and CA certificates |
| `agents/buyer.py` | Buyer uAgent; `BuyerController` handles scan / negotiate / mode / approve / decline |
| `agents/supplier.py` | Supplier uAgent around `supplier/policy.py` |
| `agents/chat.py` | ACP chat protocol: acknowledges every message, parses owner commands, sends updates |
| `agents/buyer_readme.md` | Agentverse profile text so ASI:One can discover the buyer |
| `scripts/chat_smoke_test.py` | Local chat test with a fake owner agent |
| `run.py` | Bureau with both agents |

## Jev (TypeSafe System One)

Set `TYPESAFE_API_KEY` in `.env` and both `run.py` and the terminal script switch to `JevPredictor` automatically; `--predictor heuristic|jev` forces one in the terminal script.

- Each turn, the 8 candidate moves are sent as Choice questions (`accept` / `counter` / `walk`) in 2 batches of 4. The batches run concurrently with asyncio.
- Jev reads the negotiation history, not the sampled floor. Its probabilities are blended 50/50 (`JEV_WEIGHT`) with the heuristic for each sampled supplier. Deeper playout steps use the heuristic, so a turn costs one round of API calls.
- Calls time out after 1.2 s, inside the search's 2 s budget. A timeout or error falls back to the heuristic for that turn; a rejected key turns Jev off for the rest of the run. Both are logged, and `demo_state.json` records which predictor was used (`predictor`).
- The 2026-10 build was tested with mocked Jev responses and a bad key only, not with a real key. Check the real probabilities before relying on them in the demo.

## Works across all 100 companies

```bash
./scripts/fetch_data.sh                 # once: downloads the other 99 companies (gitignored)
python -m scripts.sweep_companies       # ~35 s; every company should reach a deal
```

The scout picks one of two kinds of opportunity:

- **Product** (26 companies, mostly wholesale): an item bought repeatedly, priced per unit, e.g. `255 x Croissant Tray at $9.86 each`. Items with 6+ purchases are preferred; 3+ is the fallback.
- **Service** (74 companies): a recurring overhead bill from a negotiable vendor (subcontractor, operating service, rent, insurance, account-line supply orders), priced per payment over the next quarter, e.g. `3 rent payments of $2,571.42`. Taxes, utilities and lenders are skipped. A rise in bill amounts only counts as price creep when the bills are steady; for variable bills (a courier billed per shipment) the growth is volume, not price.

Last sweep: 100/100 companies reached a supplier-accepted deal (26 product, 74 service), median saving about $1,150. The simulated supplier's floor is 8-18% under the current price for every kind of bill, so rent cuts are more generous than a real landlord would give.

## Data notes (company-001)

- Every bill is paid 1-3 days after its due date, so a strict on-time rate is 0% for every vendor. The scout counts a payment as on time if it lands within 3 days of due.
- Only product bills have item lines, so price creep exists only for the main supplier (Ironclad Larkspur Outfitters). Croissant trays rose 12.7% over the year, from $8.75 to $9.86 averaged.
- Cash is about $104k against about $5k of payroll per two weeks, so the cash floor only matters if you set it high (e.g. `--cash-floor 100000`).
- Messages default to `claude-opus-5-5` with low effort and a 4 s timeout; set `CLAUDE_MODEL` to change it. Refusals and errors fall back to templates.
