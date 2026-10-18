# Data map: QuickBooks Hackathon 2026 dataset

## Source and provenance

- Dataset: `CL251215/QuickBooks-Hackathon-2026` on Hugging Face, participant release (`hackathon-100-participant.tar.gz`, 26.7 MB).
- We did not re-download it. The archive was already on this machine (`~/Downloads/hackathon-100-participant.tar.gz`), and the DealRoom repo's `data/` folder holds the same files. We extracted the archive and ran `diff -rq` against `data/company-001`: no differences.
- The participant release has **no `hidden/` folder** (no personas, market context, or management decisions). Our loader refuses to read any path containing `hidden/`.
- Format: provider-neutral YAML in qb-world-sim's "realized world model" v4, with one folder per company: `company-XXX/rwm-v4/world-<id>/*.yaml` plus `reports/`. Field reference: `SCHEMA.md` inside each company folder.
- Compiled form: `npm run data` converts each company's YAML to compact JSON (`data/compiled/company-XXX.json.gz`, all 100 companies, 8.6 MB total, committed). Money becomes integer cents and dates become simulation days. Code: `src/lib/data/compile.ts`, types in `src/lib/data/types.ts`.

## Coverage

| | |
|---|---|
| Companies | 100 (22 wholesale, 22 project contractors, 12 supply-and-install "mixed", 16 recurring services, 14 point-of-sale, 10 appointment practices, 4 nonprofits) |
| Industries | 71 distinct NAICS titles |
| History | 365 days for every company: opens 2025-10-06 (day 0, owner contribution), observation date 2026-10-06 (day 365) |
| Distressed | 7 companies flagged `distressed` in `index.json` (insolvent or wound down) |
| Currency | USD, two-decimal strings in the YAML |

One year of history means no year-over-year comparison and no seasonality estimate. Trends compare the first and last quarters of the same year.

## Tables

Row counts are totals across all 100 companies. "Companies" counts how many have at least one row.

| File | Rows | Companies | Key columns (type) | Notes |
|---|---:|---:|---|---|
| `company.yaml` | 100 | 100 | id, trade_name, legal_name, industry_naics, industry_title, opening_date (date), fiscal_year_start_month (int) | One profile per company |
| `accounts.yaml` | 37 per company | 100 | id, name, classification, account_type, account_subtype | 36-account shared template plus an industry revenue account. Ids are stable across companies |
| `customers.yaml` | 8,322 | 100 | id, display_name, email, payment_terms, payment_terms_days (int), credit_limit_amount (money), joined/ended day | POS companies have one walk-in aggregate customer |
| `vendors.yaml` | 821 | 100 | id, display_name, supply_role (product, subcontract, premises, utility, insurance, lender, government, operating), payment_terms_days | |
| `employees.yaml` | 582 | 100 | id, display_name, job_title, weekly_wage_amount (money), hired/released day | Gross wages only |
| `items.yaml` | small | 100 | id, name, item_type, unit_price_amount, unit_cost_amount | Unit cost lets us estimate margin per invoice for product companies |
| `invoices.yaml` | 84,451 | 86 | id, customer_id, txn day/date, due day/date, total_amount, deposit_applied_amount, retainage_amount, project_id, lines[1] | Always one line per invoice. **No status field**: open/paid/overdue is derived from payments |
| `customer_payments.yaml` | 143,616 | 84 | id, customer_id, txn day, amount, applications[{document_id, amount}], settles (receivable or retainage) | Each payment settles one invoice, sometimes in installments |
| `sales_receipts.yaml` | 28,501 | 28 | id, txn day, total_amount, deposit_account_id | Register takings (POS, appointment desk payments, donations) |
| `bills.yaml` | 39,563 | 100 | id, vendor_id, expense_kind (product or operating), cost_category (28 values), txn day, due day, total_amount, project_id | **No status field**: derived from bill payments |
| `bill_payments.yaml` | 36,032 | 100 | id, vendor_id, txn day, amount, applications[{document_id, amount}] | Each payment settles one bill |
| `journal_entries.yaml` | ~330k (13,917 kept) | 100 | id, purpose, txn day, lines[{account_id, debit, credit, customer_id, document_id}] | We keep the non-routine purposes: opening_equity, owner_distribution (152), bad_debt (41), client_default (7), financing_draw/repayment, interest_accrual, depreciation, deposit_receipt, inventory_disposal. COGS, wage-accrual and card-settlement entries are dropped because the P&L and bank feed already carry them |
| `bank_transactions.yaml` | 234,610 | 100 | id, day, amount (signed), running_balance_amount, source_document_id, kind | The cash truth. Kinds: customer_payment, sales_receipt, card_settlement, deposit_receipt, wage_payment, bill_payment, owner_distribution, financing, journal_entry, opening_equity |
| `payroll_runs.yaml` | 25,733 | 100 | id, day, total_amount, lines[{employee_id, gross_amount}] | One run per employee per payday |
| `projects.yaml` / `estimates.yaml` | small | project companies | contract amounts, status, won/lost bids | Not used yet |
| `terms.yaml` | small | 100 | name, days | |
| `reports/profit_and_loss.yaml` | 13 months | 100 | full period and monthly lines: Revenue, COGS, Wages, Operating expenses, Depreciation, Bad debts, Interest, Income tax, net_profit | First and last months are partial (`full_calendar_month: false`) |
| `reports/balance_sheet.yaml` | 5 snapshots | 100 | period end plus quarter ends, per account | Used for the exact profit-vs-cash bridge |
| `reports/ar_aging.yaml`, `ap_aging.yaml` | 1 | 100 | buckets (current, 1-30, 31-60, 61-90, 90+), rows per open document | Used to verify our derived aging |

### Status fields

Invoices and bills have no status column. We derive status as of the observation day:

- Open balance = total − deposit applied − retainage − receivable payments applied − write-offs (`bad_debt` / `client_default` journal lines carry the invoice id in `document_id`).
- Retainage is held in its own asset account and released by payments with `settles: retainage`, so we track it apart from AR. With that rule, our derived AR aging equals `reports/ar_aging.yaml` to the cent, bucket by bucket, for all 100 companies. Open bills equal `ap_aging` and opening cash equals balance-sheet checking for all 100 as well (300 checks in `tests/reconcile.test.ts`).
- Days past due = observation day − due day. An invoice with no due date (none in this dataset, but handled) falls back to the customer's terms, or 30 days.

### Joins

```
customers.id ─< invoices.customer_id ─< customer_payments.applications.document_id
vendors.id   ─< bills.vendor_id      ─< bill_payments.applications.document_id
bank_transactions.source_document_id → customer_payments.id | bill_payments.id | journal_entries.id | sales_receipts.id
journal_entries.lines.document_id → invoices.id (write-offs)
payroll_runs.lines.employee_id → employees.id;  payroll_runs.source_journal_entry_id → journal_entries.id
invoices.lines.item_id → items.id   (unit cost gives an estimated cost of goods per invoice)
```

All ids are company-scoped (`cust-customer-3` exists in many companies). Every lookup goes through one loaded company.

## What the data supports, by capability

| Capability | Support | Basis / gaps |
|---|---|---|
| Flight Simulator (cash projection) | **Good** | Opening cash from the bank feed. Open AR and AP with due dates. Per-customer payment lateness. A collection curve from 6 months of invoices. Recurring bills by cadence. Payroll from current wage rates. Gaps: one year of history, so no seasonality; deposits and financing are left out of the run-rate |
| Money Detective | **Good for overdue and write-offs; synthetic for anomalies** | Overdue invoices and write-offs are real. The organizers say the feed is clean (no duplicates or unmatched lines), so duplicate and unusual-transaction detection can only be tested on **planted** anomalies (eval only, never in the app's data) |
| Autopilot | **Good** | Overdue invoices with customer emails (`.example` domains) and bills due soon |
| Profit Leak Radar | **Partial** | Monthly P&L gives margin trends. Bill categories give cost-share trends. Recurring bills show cost creep. Item unit costs give margin by customer for product companies only. No SKU or basket data for POS |
| Future Accountant | **Good** | P&L, balance sheet, aging, and the bank feed. The profit-vs-cash bridge is exact |
| Time Machine | **Good for payment-timing counterfactuals** | The bank feed plus payment-to-invoice links let us replay cash with payments moved to their due dates |
| Negotiation Coach | **Partial** | Vendor and customer terms are real. Counterparty responses are not in the data, so every behaviour is a labeled assumption |
| Chaos Simulator | **Good** | Fully deterministic over the projection engine |
| Payroll taxes, sales tax, inventory turns, multi-year trends | **Not supported** | Gross-only payroll, no sales tax, one year of history |

## Demo company: `company-002` Roastline Coffee Roasters

Chosen because its real books fit the hero question ("hire two, more marketing, owner draw, what if payments slip"):

- **Overdue receivables that matter.** $24,778 of $52,088 outstanding is past due (48%), including an invoice over 90 days late. Seven customers are 30+ days behind their own usual pattern, and one receivable was written off this year.
- **Cash is tight relative to the decision.** $96,081 in checking against weekly payroll of $5,250 (7 staff, $750 each) and about $23k of weekly sales. Supplier purchases eat 64% of sales on Net 7 terms. Two hires plus a draw is material here, which it would not be for a company with $1M+ in cash.
- **Cash has been falling.** It went from $173,816 at opening to $96,081, while the P&L shows a $70,053 profit. The gap is mostly owner draws ($111,328 across four quarterly draws). That makes a good "why profit is not cash" answer.
- **Recurring costs.** Weekly rent, weekly utilities, a weekly services vendor, and quarterly income tax are all detectable.
- **Margin pressure.** Gross margin went from 43.4% (first three full months) to 39.1% (last three).
- Full year of wholesale history, about 1,600 invoices and 6,000 payments. Not distressed.

Runners-up: company-021 Crumbford Commercial Bakery (similar, but $218k cash makes the decision less tight), company-003 Keghouse Brewing (thin profit, 14 staff), and company-019 Pawmart Pet Supply.

## All companies

Cash, revenue and profit are from `index.json`. AR and overdue are derived by our engine (and match the aging reports). Staff counts employees active at the observation date.

| ID | Company | Industry | Shape | Size | Cash | Revenue | Profit | AR | Overdue AR | Staff | Flags |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| company-001 | Hearthloaf Bakeries | Commercial Bakeries | wholesale | small | $104,108 | $809,718 | $90,544 | $26,129 | $5,098 | 4 |  |
| company-002 | Roastline Coffee Roasters | Coffee and Tea Manufacturing | wholesale | medium | $96,081 | $1,157,894 | $70,053 | $52,088 | $24,778 | 7 |  |
| company-003 | Keghouse Brewing Co | Breweries | wholesale | large | $152,717 | $1,895,102 | $9,413 | $103,708 | $45,175 | 14 |  |
| company-004 | Stitchform Apparel Co | Cut and Sew Apparel Manufacturing | wholesale | small | $127,153 | $1,686,191 | $168,533 | $58,413 | $20,864 | 4 |  |
| company-005 | Pistonhouse Auto Parts | Motor Vehicle Supplies and New Parts Merchant Wholesalers | wholesale | medium | $192,203 | $3,391,119 | $517,431 | $172,345 | $78,840 | 5 |  |
| company-006 | Knotwood Lumber Supply | Lumber, Plywood, Millwork, and Wood Panel Merchant Wholesalers | wholesale | large | $2,217,222 | $4,377,095 | $479,493 | $652,080 | $65,796 | 14 |  |
| company-007 | Scrubline Medical Supply | Medical, Dental, and Hospital Equipment and Supplies Merchant Wholesalers | wholesale | small | $504,462 | $1,357,851 | $107,846 | $208,869 | $32,534 | 4 |  |
| company-008 | Conduitworks Electrical Supply | Electrical Apparatus and Equipment, Wiring Supplies, and Related Equipment Merchant Wholesalers | wholesale | medium | $1,676,968 | $4,487,591 | $942,713 | $656,486 | $48,596 | 8 |  |
| company-009 | Soldertown Plumbing Supply | Plumbing and Heating Equipment and Supplies (Hydronics) Merchant Wholesalers | wholesale | large | $1,116,677 | $2,930,124 | $266,337 | $462,437 | $53,070 | 13 |  |
| company-010 | Driveline Machinery Supply | Industrial Machinery and Equipment Merchant Wholesalers | wholesale | small | $54,044 | $416,073 | $-125,641 | $70,155 | $11,189 | 4 |  |
| company-011 | Grindell Industrial Supply | Industrial Supplies Merchant Wholesalers | wholesale | medium | $575,240 | $2,196,650 | $96,622 | $363,792 | $20,058 | 10 |  |
| company-012 | Baseline Sporting Goods | Sporting and Recreational Goods and Supplies Merchant Wholesalers | wholesale | large | $95,598 | $848,133 | $-359,264 | $110,571 | $10,011 | 12 |  |
| company-013 | Ledgermark Office Supply | Stationery and Office Supplies Merchant Wholesalers | wholesale | small | $107,460 | $400,714 | $-36,205 | $64,065 | $5,259 | 4 |  |
| company-014 | Rollforth Paper Supply | Industrial and Personal Service Paper Merchant Wholesalers | wholesale | medium | $538,355 | $1,981,599 | $145,565 | $314,742 | $49,152 | 6 |  |
| company-015 | Harvest Line Food Distributors | General Line Grocery Merchant Wholesalers | wholesale | large | $1,541,884 | $3,901,017 | $330,028 | $679,557 | $40,104 | 11 |  |
| company-016 | Coppervat Beverage Supply | Beer and Ale Merchant Wholesalers | wholesale | small | $151,907 | $370,737 | $-75,114 | $50,581 | $6,871 | 4 |  |
| company-017 | Trinketvale Novelty Distributors | Other Miscellaneous Nondurable Goods Merchant Wholesalers | wholesale | medium | $612,181 | $1,526,777 | $-44,168 | $200,138 | $6,435 | 9 |  |
| company-018 | Shipwise Online Goods | Electronic Shopping and Mail-Order Houses | wholesale | large | $316,121 | $3,145,953 | $223,134 | $180,513 | $88,760 | 13 |  |
| company-019 | Pawmart Pet Supply | Pet and Pet Supplies Retailers | wholesale | small | $105,125 | $1,989,476 | $451,472 | $73,256 | $32,846 | 4 |  |
| company-020 | Palletbay Storage & Warehousing | General Warehousing and Storage | wholesale | medium | $6,534 | $701,488 | $-194,456 | $28,509 | $14,928 | 6 | distressed |
| company-021 | Crumbford Commercial Bakery | Commercial Bakeries | wholesale | large | $218,441 | $2,893,312 | $460,521 | $131,891 | $58,894 | 14 |  |
| company-022 | Emberpot Coffee Roasters | Coffee and Tea Manufacturing | wholesale | small | $116 | $7,293 | $-36,776 | $0 | $0 | 0 | distressed |
| company-023 | Reelmark Productions | Motion Picture and Video Production | construction | small | $85,298 | $596,606 | $24,937 | $129,938 | $66,295 | 1 |  |
| company-024 | Trueline Architecture | Architectural Services | construction | medium | $470,092 | $1,284,255 | $129,382 | $71,402 | $61,278 | 3 |  |
| company-025 | Umber Room Interiors | Interior Design Services | construction | large | $857,808 | $1,397,622 | $22,958 | $319,282 | $35,391 | 4 |  |
| company-026 | Loudfield Advertising | Advertising Agencies | construction | small | $266,546 | $1,031,120 | $133,726 | $33,651 | $32,464 | 2 |  |
| company-027 | Saffron Table Catering | Caterers | construction | medium | $387,849 | $1,194,108 | $75,025 | $40,720 | $0 | 2 |  |
| company-028 | Gilded Oak Weddings | All Other Personal Services | construction | large | $867,178 | $1,378,499 | $27,044 | $93,546 | $13,439 | 2 |  |
| company-029 | Birchfield Custom Homes | New Single-Family Housing Construction (except For-Sale Builders) | construction | small | $85,228 | $886,491 | $12,799 | $85,682 | $85,682 | 1 |  |
| company-030 | Hearthworn Remodeling | Residential Remodelers | construction | medium | $269,815 | $1,123,976 | $46,273 | $212,904 | $212,904 | 1 |  |
| company-031 | Keystone Commercial Construction | Commercial and Institutional Building Construction | construction | large | $840,923 | $1,251,325 | $-41,075 | $245,975 | $104,889 | 4 |  |
| company-032 | Clapboard Lane Films | Motion Picture and Video Production | construction | small | $201,020 | $418,817 | $-6,006 | $27,964 | $0 | 1 |  |
| company-033 | Datum Point Architects | Architectural Services | construction | medium | $392,958 | $1,150,343 | $78,478 | $223,389 | $0 | 2 |  |
| company-034 | Soft Palette Interiors | Interior Design Services | construction | large | $912,311 | $922,301 | $-2,491 | $89,648 | $0 | 4 |  |
| company-035 | Brightmark Ad Agency | Advertising Agencies | construction | small | $387,601 | $966,822 | $118,082 | $35,041 | $7,712 | 1 |  |
| company-036 | Greenverge Landscaping | Landscaping Services | construction | medium | $352,322 | $777,196 | $52,043 | $136,883 | $0 | 3 |  |
| company-037 | Copper Ladle Catering | Caterers | construction | large | $863,488 | $823,935 | $13,937 | $139,825 | $33,476 | 4 |  |
| company-038 | Confetti Row Events | All Other Personal Services | construction | small | $249,486 | $754,752 | $59,635 | $53,127 | $1,139 | 1 |  |
| company-039 | Lanterncrest Home Construction | New Single-Family Housing Construction (except For-Sale Builders) | construction | medium | $341,538 | $375,709 | $-66,382 | $45,075 | $0 | 2 |  |
| company-040 | Courtyard Commons Apartments Construction | New Multifamily Housing Construction (except For-Sale Builders) | construction | large | $758,557 | $1,007,491 | $-89,422 | $197,676 | $5,956 | 4 |  |
| company-041 | Clovermead Homes | New Housing For-Sale Builders | construction | small | $125,076 | $499,280 | $-692 | $105,694 | $0 | 1 |  |
| company-042 | Sawhorse Home Remodelers | Residential Remodelers | construction | medium | $492,678 | $1,085,556 | $67,881 | $106,679 | $0 | 2 |  |
| company-043 | Granary Commercial Builders | Commercial and Institutional Building Construction | construction | large | $1,001,922 | $1,395,488 | $10,535 | $85,060 | $9,778 | 4 |  |
| company-044 | Lumenwork Video | Motion Picture and Video Production | construction | small | $8 | $403,561 | $-364,853 | $0 | $0 | 1 | distressed, distressed |
| company-045 | Sunward Roof & Solar | Roofing Contractors | mixed | small | $154,654 | $487,661 | $-7,383 | $2,959 | $389 | 2 |  |
| company-046 | Brightline Electric & Supply | Electrical Contractors | mixed | medium | $140,653 | $680,814 | $10,047 | $2,094 | $0 | 3 |  |
| company-047 | Ductline Mechanical & Supply | Plumbing, Heating, and Air-Conditioning Contractors | mixed | large | $74,882 | $975,054 | $50,644 | $147,204 | $152 | 1 |  |
| company-048 | Guardwire Security Systems | Other Building Equipment Contractors | mixed | small | $187,904 | $442,996 | $-17,938 | $13,734 | $118 | 2 |  |
| company-049 | Jointer Finish Carpentry | Finish Carpentry Contractors | mixed | medium | $100,281 | $337,339 | $-49,288 | $5,964 | $1,637 | 2 |  |
| company-050 | Plasterline Finishing & Supply | Other Building Finishing Contractors | mixed | large | $136,940 | $661,146 | $-13,865 | $9,673 | $1,535 | 4 |  |
| company-051 | Oddjob Specialty Trades & Supply | All Other Specialty Trade Contractors | mixed | small | $137,638 | $367,024 | $-57,432 | $13,033 | $346 | 2 |  |
| company-052 | Maple & Stone Kitchens | Wood Kitchen Cabinet and Countertop Manufacturing | mixed | medium | $266,322 | $779,529 | $41,397 | $20,272 | $204 | 3 |  |
| company-053 | Brightface Sign Co | Sign Manufacturing | mixed | large | $135,119 | $881,660 | $38,512 | $59,077 | $7,751 | 4 |  |
| company-054 | Signalcraft Systems Integration | Computer and Computer Peripheral Equipment and Software Merchant Wholesalers | mixed | small | $74,176 | $401,736 | $-51,171 | $51,592 | $27,732 | 2 |  |
| company-055 | Peakline Roof & Solar | Roofing Contractors | mixed | medium | $111,256 | $475,008 | $-47,698 | $20,067 | $15,573 | 3 |  |
| company-056 | Voltpost Electrical Contractors | Electrical Contractors | mixed | large | $262,716 | $1,020,241 | $66,358 | $20,721 | $7,614 | 5 |  |
| company-057 | Ledgerline Bookkeeping | Other Accounting Services | recurring | small | $25,269 | $137,083 | $31,390 | $7,725 | $0 | 1 |  |
| company-058 | Beacon Hill Tax & Accounting | Tax Preparation Services | recurring | medium | $58,614 | $286,394 | $37,614 | $23,586 | $0 | 3 |  |
| company-059 | Stackwise Managed IT | Computer Systems Design Services | recurring | large | $146,124 | $647,037 | $182,178 | $48,063 | $0 | 6 |  |
| company-060 | Fernwood Payroll Services | Payroll Services | recurring | small | $25,034 | $117,253 | $15,724 | $4,576 | $0 | 1 |  |
| company-061 | Clearbook CPA Group | Offices of Certified Public Accountants | recurring | medium | $57,680 | $316,851 | $35,332 | $22,749 | $0 | 3 |  |
| company-062 | Ironbark Fitness Club | Fitness and Recreational Sports Centers | recurring | large | $191,088 | $808,754 | $272,237 | $48,834 | $0 | 6 |  |
| company-063 | Helm & Harbor PR Retainers | Public Relations Agencies | recurring | small | $29,000 | $209,664 | $88,728 | $17,207 | $0 | 1 |  |
| company-064 | Stonebriar Residential Properties | Lessors of Residential Buildings and Dwellings | recurring | medium | $61,397 | $445,133 | $223,601 | $19,540 | $0 | 2 |  |
| company-065 | Oakmoor Property Management | Residential Property Managers | recurring | large | $789,671 | $1,343,227 | $844,053 | $28,282 | $0 | 4 |  |
| company-066 | Garnet Row Apartments | Lessors of Residential Buildings and Dwellings | recurring | small | $33,297 | $412,771 | $262,365 | $15,859 | $0 | 1 |  |
| company-067 | Lanternwade Commercial Realty | Lessors of Nonresidential Buildings | recurring | medium | $428,025 | $1,045,835 | $697,371 | $38,848 | $0 | 2 |  |
| company-068 | Willowmere Lofts | Lessors of Residential Buildings and Dwellings | recurring | large | $623,565 | $1,088,378 | $663,904 | $23,881 | $0 | 4 |  |
| company-069 | Meridian Wealth Advisors | Investment Advice | recurring | small | $82,168 | $459,282 | $157,267 | $93,063 | $0 | 2 |  |
| company-070 | Larchmont Capital Counsel | Investment Advice | recurring | medium | $166,654 | $1,138,200 | $590,523 | $218,760 | $0 | 4 |  |
| company-071 | Northgate Portfolio Partners | Portfolio Management | recurring | large | $1,318,334 | $3,101,075 | $1,946,568 | $634,976 | $0 | 8 |  |
| company-072 | Silverbirch Financial Planning | Investment Advice | recurring | small | $165 | $272,499 | $-34,635 | $49,088 | $0 | 2 | distressed |
| company-073 | Copper Kettle Cafe | Snack and Nonalcoholic Beverage Bars | pos | small | $39,014 | $396,121 | $92,910 | $0 | $0 | 2 |  |
| company-074 | Driftwood Espresso Bar | Snack and Nonalcoholic Beverage Bars | pos | medium | $51,857 | $509,425 | $99,542 | $0 | $0 | 5 |  |
| company-075 | Morning Lark Bakeshop | Retail Bakeries | pos | large | $87,844 | $730,214 | $79,718 | $0 | $0 | 11 |  |
| company-076 | Juniper & Rye Coffeehouse | Snack and Nonalcoholic Beverage Bars | pos | small | $22,606 | $211,929 | $3,163 | $0 | $0 | 2 |  |
| company-077 | Sugarpine Donut Co. | Retail Bakeries | pos | medium | $42,134 | $365,956 | $12,488 | $0 | $0 | 5 |  |
| company-078 | Little Harvest Juice Bar | Snack and Nonalcoholic Beverage Bars | pos | large | $1,206,645 | $3,341,505 | $1,098,638 | $0 | $0 | 20 |  |
| company-079 | Tavola Rossa Trattoria | Full-Service Restaurants | pos | small | $109,075 | $993,009 | $231,102 | $0 | $0 | 6 |  |
| company-080 | Blue Heron Bistro | Full-Service Restaurants | pos | medium | $144,025 | $1,105,145 | $131,995 | $0 | $0 | 12 |  |
| company-081 | Smokestack Barbecue House | Full-Service Restaurants | pos | large | $2,311,270 | $5,324,880 | $2,132,150 | $0 | $0 | 20 |  |
| company-082 | Lotus Garden Kitchen | Full-Service Restaurants | pos | small | $87,160 | $607,267 | $36,632 | $0 | $0 | 6 |  |
| company-083 | El Farolito Taqueria | Limited-Service Restaurants | pos | medium | $154,494 | $1,009,133 | $189,620 | $0 | $0 | 4 |  |
| company-084 | Pagewood Books & Prints | Book Retailers and News Dealers | pos | large | $586,578 | $2,173,708 | $517,222 | $0 | $0 | 8 |  |
| company-085 | Thistle & Thread Yarn Shop | Sewing, Needlework, and Piece Goods Retailers | pos | small | $85,653 | $764,855 | $140,228 | $0 | $0 | 2 |  |
| company-086 | Rolling Spoke Bicycle Shop | Sporting Goods Retailers | pos | medium | $109,212 | $851,400 | $126,048 | $0 | $0 | 4 |  |
| company-087 | Lakeview Family Dental | Offices of Dentists | appointments | small | $17,011 | $299,793 | $-17,497 | $4,461 | $1,219 | 3 |  |
| company-088 | Birchwood Orthodontics | Offices of Dentists | appointments | medium | $68,350 | $501,666 | $21,655 | $11,395 | $920 | 6 |  |
| company-089 | Cedar Hollow Veterinary Clinic | Veterinary Services | appointments | large | $307,126 | $1,340,914 | $330,783 | $18,986 | $3,874 | 13 |  |
| company-090 | Elm Street Counseling Group | Offices of Mental Health Practitioners | appointments | small | $5,293 | $261,454 | $-59,112 | $3,992 | $277 | 3 | distressed |
| company-091 | Quietwater Counsel LLP | Offices of Lawyers | appointments | medium | $143,678 | $713,648 | $156,951 | $73,275 | $453 | 5 |  |
| company-092 | Ashgrove Family Law | Offices of Lawyers | appointments | large | $220,189 | $1,168,628 | $85,695 | $50,217 | $992 | 11 |  |
| company-093 | Hollis & Pine Legal Group | Offices of Lawyers | appointments | small | $23,138 | $314,226 | $512 | $27,161 | $326 | 2 |  |
| company-094 | Velvet Finch Salon | Beauty Salons | appointments | medium | $67,911 | $320,653 | $73,145 | $374 | $149 | 5 |  |
| company-095 | Clipper & Crown Barbershop | Barber Shops | appointments | large | $154,696 | $590,015 | $143,938 | $324 | $69 | 11 |  |
| company-096 | Golden Hour Massage Studio | Other Personal Care Services | appointments | small | $23,759 | $146,995 | $9,741 | $59 | $0 | 2 |  |
| company-097 | Brightwater Community Fund | Civic and Social Organizations | nonprofit | small | $2,162 | $119,930 | $-27,867 | $3,900 | $3,900 | 2 | distressed |
| company-098 | Open Table Food Pantry | Community Food Services | nonprofit | medium | $61,092 | $285,814 | $26,229 | $17,600 | $17,600 | 4 |  |
| company-099 | Riverstage Arts Alliance | Promoters of Performing Arts with Facilities | nonprofit | large | $47,035 | $539,547 | $-173,868 | $0 | $0 | 11 |  |
| company-100 | Lanternlight Community Theater | Promoters of Performing Arts with Facilities | nonprofit | small | $1,363 | $93,094 | $-109,162 | $0 | $0 | 2 | distressed |
