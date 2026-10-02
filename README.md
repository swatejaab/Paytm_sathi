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

Single-port demo build: `npm run build`, then `npm start`. Express serves `frontend/dist` on http://127.0.0.1:8000.

Container: `docker build -t paytm-saathi .`, then `docker run -p 8000:8000 -e JWT_SECRET_KEY=<32+ random chars> paytm-saathi`. Mount a volume on `/app/data` to keep cases across restarts.

Other commands: `npm test` runs the backend suite (node:test + supertest), and `npm run typecheck` checks both projects.

## Demo accounts (synthetic)

| Demo ID | Passcode | What it shows |
| --- | --- | --- |
| `demo-customer-01` (Riya) | `2468` | Hero journey. Savings are tight, so the exact-gap plan wins. |
| `demo-customer-02` (Arjun) | `1357` | A healthy savings buffer, so savings win over credit (product neutrality). |
| `support-agent-01` | `9999` | Specialist queue. Read-only Resolution Passports; cannot approve actions. |

## Demo script

1. Sign in as Riya and tick **Allow Saathi to read my case records**. Without consent the case is saved but nothing is read.
2. Click **Hospital demo**. Saathi classifies the event, reads the bill, policy, and cash context through the MCP gateway, and shows `₹80,000 − ₹55,000 − ₹10,000 = ₹15,000`.
3. In **Plan**, compare five options scored on cost, risk, time, and effort. Open **Why this score?** to see guardrails: affordability, exact-gap borrowing, emergency buffer, and confidence gate.
4. Click **Review & approve** on *Claim + 3-month plan*. Check the exact steps, partners, amounts, and payload hash, then approve.
5. Watch **Timeline** receive partner callbacks until the case is **Resolved**. Open **Agents** to show each graph run: which specialist node ran, the MCP tools it called, and how long it took.
6. Open **Passport** (Tell It Once packet) and **Trust ledger** (every gateway allow and deny).
7. Click **Unrecognized UPI**, pick the ₹8,500 QuickKart debit, see the fraud signals, and approve the dispute.
8. Click **EMI shortfall**. Saathi finds the INR 12,000 EMI, the delayed salary, and the INR 4,600 shortfall, then recommends moving the due date past payday over borrowing. It replies in Hinglish because the customer wrote in Hinglish.
9. Optional: sign in as Arjun to show the recommendation flip, or as support to show the specialist queue.

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
| 5. Evidence + RAG | `documents.ts` (PDF/TXT/JSON extraction, redaction, cited retrieval), `routes/evidence.ts`, OpenAI summaries |
| 6. Decisions | `decision.ts`: exact gap, EMI shortfall, affordability, guardrails, confidence gate, scoring |
| 7. Agent workflow | `agent/graph.ts` (LangGraph.js), consent pause, approval-bound writes in `actions.ts`, audit trail, timeline |
| 8. UX + partners | Case workspace, Agents tab, Sarvam voice, n8n webhook and signed callbacks in `partners.ts` |
| 9. Demo hardening | Three journeys (hospital, UPI, EMI), 47 automated tests, rate limiting, security headers, Docker, CI |

Not connected in this build: Cognee (local keyword index instead), Mochatrade (labeled fixture offers), scanned-PDF OCR.

## Local secrets

Keep keys in the ignored `.env` file only. Never commit credentials or paste them into chat. Rotate any API key that has been shared outside its provider dashboard. To enable an integration, set its `*_API_KEY` and the matching `*_ENABLED=true`, then restart `npm run dev`. OpenAI receives redacted text only after a per-request consent, and Sarvam receives audio only after a transcription consent. Provider calls are not tested against live accounts by the automated suite.

## Prototype limits

This build is for a synthetic-data hackathon demo, not production. Insurer, lender, and payment outcomes are simulated, and offers are labeled fixtures (no Mochatrade or lender API is connected). Policy retrieval is a local keyword index (Cognee is not connected). The build has no OCR for scanned PDFs, no encrypted document storage, no tamper-evident ledger, and no production-grade PII detection. Demo passcodes are not secrets. Do not upload real customer or financial documents. Security and consent are prototype design, not a compliance certification.
