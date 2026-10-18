# Synthetic changes to the dataset

**The app uses the hackathon data unchanged.** No rows were added, removed or edited for the hero workflow or any other app feature. The real books for the demo company already support every capability we show (overdue receivables, recurring costs, owner draws, a write-off, margin drift). See `DATA_MAP.md`.

## What is derived (not synthetic)

`npm run data` compiles the YAML into compact JSON (`data/compiled/*.json.gz`). The compile step:

- converts money strings to integer cents and calendar dates to simulation days;
- keeps only the journal-entry purposes we use (drops routine COGS, wage-accrual and card-settlement entries, which the P&L and bank feed already carry);
- keeps the first line's item and an estimated cost (item unit cost × quantity) per invoice.

Nothing is invented. Derived figures (open balances, aging, recurring costs, run-rates) are computed by the engine and checked against the dataset's own reports: AR aging, AP aging and balance-sheet cash match to the cent for all 100 companies (`tests/reconcile.test.ts`).

## Evaluation only: planted anomalies

The organizers state the books and bank feed are clean. To measure duplicate and unusual-expense detection, `eval/plant.ts` adds two bills to an **in-memory copy** of six companies' data during `npm run eval`:

| Kind | What | Why |
|---|---|---|
| Duplicate bill | The largest bill from the last 60 days, re-entered one day later with the same vendor, category and amount (id `planted-dup-<original id>`) | Duplicate detection cannot be measured on data with no duplicates |
| Unusual expense | A bill from the vendor/category with the most history, at 8× its median amount (at least +$1,000), dated 10 days before the observation date (id `planted-spike-<source id>`) | Same |

Affected companies: 002, 021, 024, 073, 087, 058. The exact planted ids are listed in `EVAL_RESULTS.md`. Effect: none on the app. The copies exist only inside the eval process, and the compiled files are never written.

## Assumptions the engine makes (not data changes, but worth knowing)

Each one is shown in the UI as an editable assumption or noted under "Assumptions and uncertainty":

- default cash reserve of about 4 weeks of fixed costs;
- a 30-day payment-delay stress test;
- 50% of overdue balances recovered by chasing within 14 days;
- suppliers may agree to 14 more days on new bills;
- no sales lift from marketing within 90 days;
- price elasticity of −1 for price changes;
- invoices more than 90 days past due are not counted as cash.
