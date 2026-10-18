# QuickBooks Command Center

![tag:quickbooks](https://img.shields.io/badge/quickbooks-3D8BD3)
![tag:finance](https://img.shields.io/badge/finance-3D8BD3)
![tag:cash-flow](https://img.shields.io/badge/cash--flow-3D8BD3)
![tag:small-business](https://img.shields.io/badge/small--business-3D8BD3)

A finance chief for a small business, answering from its QuickBooks books.

Ask a plain-English question (can I hire two people, what if customers pay 30 days late, should I run a promotion) and the Command Center reads the company's bank balance, open invoices, bills and payroll, projects cash for 13 weeks, stress-tests the plan, and searches for the safest version of what you asked. Every number comes from a deterministic financial engine, not a language model. **Nothing is sent or paid without the owner's approval.**

## Talk to it

- Any question: get the bottom line, the top 3 actions and the key numbers for each scenario (current, your proposal, recommended)
- `company <id or name>`: switch company, for example `company 3` or `company roastline` (default company-002)
- `companies`: list the companies
- `help`

## Example

> **You:** Can I afford to hire two more people next quarter?
> **Command Center:** Not right away: doing it now runs out of cash if customers pay 30 days late. Safest plan: chase overdue invoices first, hire both in week 5 and ask suppliers for 14 more days.
> Top actions: 1. Chase 43 overdue customers for $24,778 ...

Demo data: synthetic QuickBooks books (LA Hacks 2026 dataset).
