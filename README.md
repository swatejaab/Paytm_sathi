# Paytm Saathi

An event-first financial resolution demo for Track 2 (Insurance + Lending + Fintech). A customer explains what happened; Saathi gathers source-linked evidence, calculates the exact funding gap, compares practical paths, and coordinates the chosen step only after explicit approval.

**Stack:** React + TypeScript (Vite) frontend, Node.js + Express + TypeScript backend, a **LangGraph.js** agent graph, SQLite (built into Node), an MCP-style tool gateway over synthetic partner fixtures, optional OpenAI, Sarvam, and n8n.

## Prerequisites

- Node.js 22.13 or newer (Node 24 recommended). No Python is required.

## Run it

From the repository root in PowerShell:

```powershell
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm run dev
```

- Web app: http://localhost:5173 (Vite proxies `/api` to the backend)
- API: http://127.0.0.1:8000/api/health

**For a live demo, run `npm run reset` (clears demo cases so alerts reappear), then `npm run demo`** (builds, then serves everything on http://127.0.0.1:8000 with no file watcher, so nothing restarts mid-presentation). `npm run dev` is for development only.

Container: `docker build -t paytm-saathi .`, then `docker run -p 8000:8000 -e JWT_SECRET_KEY=<32+ random chars> paytm-saathi`. Mount a volume on `/app/data` to keep cases across restarts.

Other commands: `npm test` runs the backend suite (node:test + supertest), and `npm run typecheck` checks both projects.

## Demo accounts (synthetic)

| Demo ID | Passcode | What it shows |
| --- | --- | --- |
| `demo-customer-01` (Riya) | `2468` | Hero journey. Savings are tight, so the exact-gap plan wins. |
| `demo-customer-02` (Arjun) | `1357` | A healthy savings buffer, so savings win over credit (product neutrality). |
| `support-agent-01` | `9999` | Specialist queue. Read-only Resolution Passports; cannot approve actions. |

## Demo script

1. Sign in as Riya. The **Home** tab is her Financial Twin: net position, "₹41,500 is due before your salary but your balance is ₹23,400", the upcoming-bills inbox with a projected balance after each item, money tiles, goals, and cash flow. Tap a mode chip (RECOVER / PROTECT / PLAN) or **See my options** to open the Saathi tab with the question ready. Click **Turn on alerts**, and show the two "Saathi noticed" cards (EMI due in 2 days and INR 4,600 short; an unusual INR 8,500 debit). Tick **Allow Saathi to read my case records**. Without consent the case is saved but nothing is read.
2. Click **Hospital demo**. Saathi classifies the event, reads the bill, policy, and cash context through the MCP gateway, and shows `₹80,000 − ₹55,000 − ₹10,000 = ₹15,000`.
3. In **Plan**, open **How the INR 55,000 cover was calculated**: room capped at INR 5,000/day (clause 3.2), INR 5,000 of non-medical consumables excluded (4.3), INR 5,000 deductible (6.1). Then compare five options scored on cost, risk, time, and effort. Open **Why this score?** to see guardrails: affordability, exact-gap borrowing, emergency buffer, and confidence gate.
4. Click **Review & approve** on *Claim + 3-month plan*. Check the exact steps, partners, amounts, and payload hash, then approve.
5. Watch **Timeline** receive partner callbacks until the case is **Resolved**. Open **Agents** to show each graph run: which specialist node ran, the MCP tools it called, and how long it took.
6. Open **Passport** (Tell It Once packet) and **Trust ledger** (every gateway allow and deny).
7. Click **Unrecognized UPI**, pick the ₹8,500 QuickKart debit, see the fraud signals, and approve the dispute.
8. Click **EMI shortfall**. Saathi finds the INR 12,000 EMI, the delayed salary, and the INR 4,600 shortfall, then recommends moving the due date past payday over borrowing. It replies in Hinglish because the customer wrote in Hinglish.
8a. On **Home**, show the **Cash-flow Copilot**: the balance dips below zero on 5 Oct and bottoms at -INR 18,100 on 7 Oct before payday; the cheapest fix (borrow only the INR 18,100 for INR 422) and the no-new-loan plan (move the EMI + card minimum, INR 699). Toggle "salary late by 5 days". Then **Can I afford it?** with "₹1.2 lakh iPhone": Riya gets card EMI with a warning to fix the crunch first; Arjun is told to wait 2 months.
8b. Click **Failed UPI refund**, pick the INR 2,450 debit, and show the declarative playbook: 2 days past T+1, so INR 200 compensation, and a refund trace to approve. Open **Agents** to show the playbook card and its tool allowlist.
9. In **Passport**, click **Download PDF** (one-page packet to hand to the hospital or insurer) or **Copy summary**.
10. Upload your own bill as TXT/PDF (or a photo, with OCR consent). Saathi reads the line items, asks you to confirm the total, and recalculates the exact gap from your bill.
11. Sign in as support, open a case in **Human review**, click **Pick up this case**, verify uploaded documents, recommend an option, and message the customer. The customer still approves.
12. Optional: sign in as Arjun to show the recommendation flip.

## Architecture

```
frontend/  React workspace: conversation, consent, plan, evidence, timeline, passport, trust ledger
server/src/
  routes/          REST API (auth, cases, evidence, actions, partner callback)
  auth.ts          Demo JWT login, role scopes, approval tokens
  agent/graph.ts   LangGraph.js StateGraph: classifier -> consent gate -> context retriever -> policy RAG
                   -> bill / transaction / EMI auditor -> decision service -> explainer (| human review)
  agent/trace.ts   Per-run trace of nodes, tools, and timings (shown in the Agents tab)
  workflow.ts      Case entry points; statuses INTAKE -> UNDERSTAND -> EVIDENCE_READY -> OPTIONS_READY
                   -> AWAITING_APPROVAL -> IN_PROGRESS -> RESOLVED | HUMAN_REVIEW
  mcp/             Tool allowlist + gateway (strict schemas, case scope, consent, approval-bound writes, audit)
  decision.ts      Deterministic exact-gap, EMI, affordability, guardrails, option scoring (no LLM maths)
  actions.ts       Prepare -> approve (payload-hash bound) -> gated partner writes
  partners.ts      n8n webhook + signed callbacks, or local simulated partner with the same contract
  integrations.ts  OpenAI (redacted, consent-gated) and Sarvam STT adapters
data/              Synthetic fixtures: bill/policy, profiles, UPI transactions, loans, lender offers, playbooks, users
```

### MCP: real partner servers, gateway as MCP client

Each partner contract is a real MCP server built with the official SDK: `insurer.v1`, `provider.v1` (hospital/TPA), `payments.v1`, `lender.v1`, `aa.v1` (Account Aggregator), `crm.v1` (Paytm Support), and `knowledge.v1`. The Saathi gateway runs its checks (allowlist, schema, case scope, playbook scope, consent, approval token, payload hash) and then calls the partner through an MCP client; partners only receive the tool arguments and the customer id in `_meta`. By default each simulated partner runs in-process; set `MCP_URL_<SERVER>` (for example `MCP_URL_INSURER=http://127.0.0.1:8000/mcp/insurer`) to reach a Streamable HTTP server instead: swapping in a partner's real server is a URL change. `GET /api/mcp/servers` shows each server's transport.

The same servers are exposed at `http://127.0.0.1:8000/mcp/<server>` (stateless Streamable HTTP, bearer token from `MCP_PARTNER_TOKEN`, or the local token printed at startup). To show them live: `npx @modelcontextprotocol/inspector`, choose Streamable HTTP, enter the URL, and add headers `Authorization: Bearer <token>` and `x-saathi-customer: demo-customer-01`.

Deck tools now implemented: `payments.create_link` (the customer pays their INR 10,000 share to the hospital), `lending.get_kfs` (the lender's Key Fact Statement, shown before approval and bound into the payload hash), `aa.request_consent` / `aa.fetch_fi_data` (Account Aggregator consent artefact and inflows), `crm.handoff_to_agent` (every specialist handoff gets a ticket), `crm.create_ticket`, and `hospital.request_cashless`.

### Playbooks: a new money problem is a new YAML file

Every journey is a playbook in `data/playbooks/*.yaml`: its triggers (English, Hinglish, Devanagari), urgency, auditor, rules engine, the MCP tools it may read and write, and its exit condition. The classifier routes by triggers, and **the gateway denies any tool the active playbook does not declare** (`playbook_scope`, logged in the trust ledger). Hospital, UPI fraud, and EMI use built-in, unit-tested rule modules referenced by name. **Failed UPI refund is fully declarative**: its facts (days since debit, T+1 deadline, days late, INR 100/day compensation per the RBI TAT circular), guards, options, and write payload are expressions in the YAML, evaluated by a small safe expression language (no eval). Adding it needed one new payments contract (`payments.raise_refund_trace`, which independently re-checks the compensation ceiling) and no orchestrator, decision-engine, consent, or audit changes. `GET /api/playbooks` lists the catalogue; the Agents tab shows the active playbook and its allowed tools.

### Agent graph

The plan's bounded agent workflow runs as a LangGraph.js `StateGraph` (`GET /api/agent/graph` returns its nodes and a Mermaid diagram). Agents gather and explain evidence; they call partner systems only through the MCP gateway, and ordinary TypeScript owns every calculation and action rule. The persisted case record is the durable checkpoint, so each trigger (intake, consent, transaction confirmation, document upload) resumes the right node. Any node failure routes the case to a specialist instead of failing the request. The explainer answers in Hinglish when the customer writes in Hinglish, using only numbers the decision service produced.

Trust rules enforced in code:
- The client never supplies `customer_id`. Every read checks case ownership, and other customers get a 404.
- Reads through the gateway need case consent. Writes also need a short-lived approval token bound to the case, action, person, and payload hash. A changed amount is rejected.
- Uploaded documents trigger a confidence gate. Automated claim and credit steps pause and a specialist is recommended.
- The audit log stores tool names, scopes, decisions, and references, never document contents or keys.

### n8n (optional)

Set `N8N_WEBHOOK_URL` and `N8N_WEBHOOK_SECRET`. Saathi POSTs `saathi.action.approved` with headers `x-saathi-signature: sha256=<HMAC of body>` and `idempotency-key`. Your workflow calls back `POST /api/partners/callback` with:

```json
{ "event_id": "unique-id", "case_id": "SA-XXXXXXXX", "action_id": "ACT-XXXXXXXX",
  "tool": "claim.submit", "status": "acknowledged | completed | failed", "message": "..." }
```

The callback must be signed the same way. Duplicate `event_id`s are ignored. If n8n is unreachable, Saathi records the fallback in the timeline and uses the local simulated partner.

## Build plan coverage

How `PAYTM_SAATHI_BUILD_PLAN.html` maps to this code:

| Plan step | Where it lives |
| --- | --- |
| 1. Scaffold | npm workspaces: `frontend/` (React + Vite), `server/` (Express + TypeScript), shared types |
| 2. Seed the demo | `data/*.json` synthetic users, profiles, bill and policy, transactions, loans, offers, playbooks |
| 3. Auth + case API | `auth.ts` (demo JWT, role scopes, approval tokens), `routes/cases.ts`, ownership checks in `caseStore.ts` |
| 4. MCP tools | `mcp/tools.ts` (22 tools across identity, insurer, hospital, payments, lender, knowledge), `mcp/gateway.ts` |
| 5. Evidence + RAG | `documents.ts` (PDF/TXT/JSON extraction, redaction, cited retrieval), photo OCR via OpenAI vision, `routes/evidence.ts`, OpenAI summaries |
| 6a. Coverage rules | `coverage.ts`: each bill line marked payable / capped (room limit) / partly excluded (non-medical items), then the deductible and sum-insured ceiling, every amount with its clause |
| 6. Decisions | `decision.ts`: exact gap, EMI shortfall, affordability, guardrails, confidence gate, scoring |
| 7. Agent workflow | `agent/graph.ts` (LangGraph.js), consent pause, approval-bound writes in `actions.ts`, audit trail, timeline |
| 8. UX + partners | Case workspace, Agents tab, live updates (Server-Sent Events), mic input, 11-language replies and read-aloud (Sarvam), OpenAI follow-up chat, n8n webhook and signed callbacks in `partners.ts` |
| 9a00. Real MCP servers | `mcp/servers.ts` (SDK McpServer per contract), `mcp/clients.ts` (gateway MCP client, in-process or Streamable HTTP), `routes/mcp.ts` (`/mcp/<server>`) |
| 9a0. Playbook registry | `data/playbooks/*.yaml`, `playbooks/registry.ts` (zod-validated, triggers, tool allowlist), `playbooks/declarative.ts` + `expressions.ts` |
| 9a1. Cash-flow Copilot | `forecast.ts` (`GET /api/forecast`): day-by-day balance, crunch day, safe-to-spend, priced fixes, cheapest plan with and without a new loan, salary-delay and skip what-ifs; `ForecastCard.tsx` chart |
| 9a2. Can I afford it? | `afford.ts` (`POST /api/afford`): parses "1.2 lakh" / "15L", compares cash, card EMI, personal or vehicle loan (with down payments), and waiting against the buffer, forecast, and affordability rules |
| 9a. Financial Twin + Home | `twin.ts` (`GET /api/twin`): sourced assets, liabilities, cash flow, obligations inbox, insurance, goals; `HomeView.tsx` |
| 9b. Complete product | Proactive alerts (`alerts.ts`), specialist desk (`support.ts`, read-only gateway access when assigned), customer-confirmed bill parsing (`billParser.ts`), passport PDF, phone layout |
| 9. Demo hardening | Three journeys (hospital, UPI, EMI), 47 automated tests, rate limiting, security headers, Docker, CI |

Not connected in this build: Cognee (local keyword index instead) and Mochatrade (labeled fixture offers). Scanned PDFs are not rendered; upload photos of the pages for OCR instead.

### Voice, languages, and AI chat

Pick a language in the chat header (English plus Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Kannada, Malayalam, Punjabi, Odia, or Auto for English/Hinglish). The mic button sends speech to Sarvam speech-to-text; Saathi's explanations are translated by Sarvam (English original kept, English fallback on failure), and the speaker button reads any message aloud. With a case open, follow-up questions go to OpenAI with redacted case facts only; a numeric guard replaces any answer containing numbers the decision service did not produce. Every external call needs its own consent checkbox.

## Local secrets

Keep keys in the ignored `.env` file only. Never commit credentials or paste them into chat. Rotate any API key that has been shared outside its provider dashboard. To enable an integration, set its `*_API_KEY` and the matching `*_ENABLED=true`, then restart `npm run dev`. OpenAI receives redacted text only after a per-request consent, and Sarvam receives audio only after a transcription consent. Provider calls are not tested against live accounts by the automated suite.

## Prototype limits

This build is for a synthetic-data hackathon demo, not production. Insurer, lender, and payment outcomes are simulated, and offers are labeled fixtures (no Mochatrade or lender API is connected). Policy retrieval is a local keyword index (Cognee is not connected). The build has no OCR for scanned PDFs, no encrypted document storage, no tamper-evident ledger, and no production-grade PII detection. Demo passcodes are not secrets. Do not upload real customer or financial documents. Security and consent are prototype design, not a compliance certification.
