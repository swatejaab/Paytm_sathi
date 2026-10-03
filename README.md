# Paytm Saathi

Your AI companion for everyday financial decisions and emergencies. Tell Saathi what happened or what you want to achieve: a hospital bill, a payment you don't recognise, an EMI due before payday, a purchase, or a savings goal. Saathi asks only for what it still needs, works out the numbers from what you said, your documents, and your account records, compares practical options, and prepares the next step. Nothing happens to your money until you approve it.

**Stack:** React + TypeScript (Vite) frontend, Node.js + Express + TypeScript backend, a **LangGraph.js** agent graph, SQLite (built into Node), an MCP tool gateway over simulated partner servers, and optional OpenAI, Sarvam, and n8n.

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

`npm run dev` restarts the API when server files change. To serve a production build with no file watcher, run `npm run demo` (builds the frontend, then serves everything on http://127.0.0.1:8000). `npm run reset` clears saved conversations, goals, and preferences.

Container: `docker build -t paytm-saathi .`, then `docker run -p 8000:8000 -e JWT_SECRET_KEY=<32+ random chars> paytm-saathi`. Mount a volume on `/app/data` to keep conversations across restarts.

Other commands: `npm test` runs the backend suite (node:test + supertest), `npm run typecheck` checks both projects, and `npm run build` builds the frontend.

## Sample accounts

The accounts, statements, transactions, loans, and offers in `data/` are sample data, not real customer data.

| Account | Passcode | Profile |
| --- | --- | --- |
| Neha Kulkarni | `2468` | Product analyst in Powai. Her father is in the ICU at City Hospital, Thane; family health floater, ₹38,420 balance with rent due before salary, mutual funds, and a pre-approved personal loan. |
| Arjun Mehta | `1357` | A healthy savings buffer, so savings often beat credit. Admitted at Sunrise Hospital, Bengaluru; his policy covers almost all of the bill. |
| Riya Sharma | `8642` | Tight savings and an EMI due before payday. Has a family health policy but no hospital admission on file. |
| Saathi Support Desk | `9999` | Specialist queue. Read-only Resolution Passports; cannot approve actions. |

The sign-in card has a **Use sample passcode** helper.

### Neha's story (Money SOS)

1. Sign in as Neha and tap **Money SOS** (header on desktop, floating button on phones). The SOS screen ("Saathi, madad karo") takes one story by voice or text, in any language, and offers **Ask a specialist to call me**.
2. Tap **Hospital deposit** or say "Papa ICU mein hai, ₹80,000 deposit maang rahe hain. Kya karun?" Saathi asks once for permission, then fetches her records through the MCP partner servers: the policy from the insurer (`insurer.get_policy`, `insurer.check_coverage`), the admission and bill from the hospital (`hospital.get_bill`), and her balance, bills due before salary, and mutual funds through Account Aggregator (`aa.fetch_fi_data`).
3. The answer: "Cashless covers ₹55,000. You can pay ₹10,000 now. The real gap is ₹15,000." The ₹10,000 is her ₹38,420 balance minus ₹22,000 rent and a ₹6,420 card bill due before salary. The room-rent cap (policy clause 3.2) and the missing discharge summary are flagged with their sources.
4. The options are ranked on cost, risk, time, and effort only: claim plus a 3-month ₹15,000 plan (recommended, ₹65,000 less borrowed than a full loan), claim plus savings (breaks her emergency buffer), claim plus redeeming mutual funds (too slow for an urgent deposit), a full ₹80,000 pre-approved loan, and waiting for reimbursement.
5. **Approve plan** shows every step (claim, discharge summary request, ₹10,000 payment link, ₹15,000 plan) for explicit approval; the simulated partners then complete them on the case timeline.

Anything the records cannot answer is asked for, and anything the customer says replaces the records. If they decline access, Saathi asks for the details instead. The insurer, hospital, lender, and Account Aggregator responses are simulated.

## The app

- **Money SOS**: one button for any money emergency (header, Home, and a floating button on phones). It opens a voice-first chat with emergency shortcuts and a specialist call-back.
- **Home**: greeting, the four entry points (Ask Saathi, Check Financial Health, View Goals, Explore Insights), proactive "For you" insights, this month at a glance, goals, and recent chats.
- **Saathi**: a multi-turn chat. Every message, including suggestion chips, goes to `POST /api/chat` exactly as typed. Conversations are saved with an automatic title (for example "Hospital Bill Assistance" or "Unknown UPI Transaction"), and can be reopened, renamed, or deleted from the history sidebar (a drawer on phones). The composer supports text, attachments (bill or insurance policy), and voice (record, review the transcript, then send; Sarvam speech-to-text when enabled, otherwise the browser's speech recognition).
- **Insights**: KPI cards (income, spending, savings, upcoming obligations, outstanding debt, financial health) and charts with tooltips and legends (income vs expenses, spending by category, cash flow, debt/EMI, savings progress, upcoming obligations), plus these tabs:
  - **Assets & net worth**: link your PAN once (the KYC PAN or one you type, with explicit consent) and Saathi pulls every holding linked to it, IndMoney-style: stocks from the CDSL/NSDL demat statement, mutual funds from the CAMS/KFintech statement, bank balances and FDs through the Account Aggregator, and PPF/EPF. It shows net worth, allocation, the 6-month trend, gains, liquid money, and holding-level tables, and Saathi can answer "How is my money invested?" from it. Read-only, and you can unlink at any time.
  - **Cash flow forecast**: a Power BI-style report with KPI tiles, what-if slicers (salary delay, which bills to include), a combo chart (daily money in and out as bars, the running balance as a line, payday and the lowest point marked, hover tooltips), and the biggest payments before payday.
  - **Credit health** and **Can I afford it?**
- **Goals**: add, edit, pause, complete, or delete goals; each shows the remaining amount, the monthly amount needed, progress, and expected completion. Saathi takes active goals into account (for example, an iPhone purchase is checked against a car goal).
- **More**: profile, financial profile, linked accounts, chat history, uploaded documents, financial cases, notifications, consent management, privacy, connected services, data permissions, language, theme, notification preferences, help, FAQs, and about.
- Light and dark themes (header toggle, saved in the browser), responsive down to phone widths.
- **App / Web** switch in the header. On a computer, App shows the mobile app inside a phone frame and Web shows the full desktop layout; on a phone, App is the native mobile layout and Web requests the desktop layout. The choice is saved, and switching keeps you signed in on the same screen.

### How a conversation works

1. `assistant/nlu.ts` reads the message (English, Hindi, or Hinglish): the intent, amounts and what they refer to (bill, insurance cover, what you can pay), dates, and items.
2. `assistant/turn.ts` keeps a structured context per conversation (`context.slots`, each value with its source). For a hospital bill it first asks to check the policy, the hospital's bill, and the bank balance through the MCP partner servers (`assistant/records.ts`), then asks only for what is still missing, for example: "I found your Family health floater with Insurer partner (simulated), with a sum insured of ₹5,00,000… tell me the amount the hospital's insurance (TPA) desk pre-authorised."
3. Once the inputs are known, deterministic TypeScript does the maths: funding gap = max(bill − insurance − what you can pay, 0). Saathi asks for consent inline before reading account records, then the agent graph gathers evidence and the decision service ranks options on cost, risk, time, and effort only. Partner commission is never considered.
4. Replies carry cards (funding gap, recommended plan, transactions, affordability, goal drafts) and quick replies. "Why this plan?" shows the information used and its source, the calculation, alternatives, and risks. Low-confidence values are flagged for confirmation.
5. Actions (dispute, secure account, claim, loan application, specialist handoff) are prepared, shown in full, and run only after explicit approval.
6. **Applying for a loan or buying a policy** is only possible when Saathi's recommended option includes one (for example the ₹15,000 exact-gap loan in Neha's hospital plan, or term cover for a family with a protection gap). The plan card then shows the product with its EMI, rate, and total cost, and "Apply for loan" / "Buy policy" walks through a review, the Key Fact Statement (APR including fees, total repayable, cooling-off) or the proposal (free-look period), and a final consent before anything is sent. Asking Saathi directly for a loan or a policy does not open a sale; it asks what the money or cover is for. `GET /api/cases/:id/product` returns 404 when nothing is being suggested.

Unknown values stay unknown: Saathi never substitutes a preset bill, cover, or contribution.

## Architecture

```
frontend/src/
  pages/           Landing, Home, Saathi (chat), Insights, Goals, More
  components/      chat/ (Composer, HistoryPanel, MessageCard), CasePanel (plan drawer), WhyPlan, charts, ui primitives
  api.ts           Typed API client; user-facing errors never expose technical details
  router.ts        Hash routes: #/, #/saathi[/:id], #/insights, #/goals, #/more[/:section]
  theme.ts         Light/dark theme persisted in localStorage
  voice.ts         Voice input state machine (idle, listening, processing, ready, error)
server/src/
  routes/          REST API (auth, chat/conversations, cases, evidence, actions, goals, insights, partner callback)
  assistant/       nlu.ts (understanding), turn.ts (slot filling, follow-ups, titles, cards, quick replies),
                   language.ts (script detection and translation in and out of 11 languages)
  holdings.ts      Portfolio and net worth from the holdings linked to a PAN (aa.fetch_holdings MCP tool)
  products.ts      The loan or policy inside Saathi's recommended option, with its full costs
  agent/graph.ts   LangGraph.js StateGraph: classifier -> consent gate -> context retriever -> policy RAG
                   -> bill / transaction / EMI auditor -> decision service -> explainer (| human review)
  hospitalDecision.ts, decision.ts
                   Deterministic exact gap, EMI, affordability, guardrails, option scoring (no LLM maths)
  goals.ts, insights.ts, financialContext.ts
                   Goals store and maths, KPI and chart data from statements, the per-user financial context
  actions.ts       Prepare -> approve (payload-hash bound) -> gated partner writes
  mcp/             Tool allowlist + gateway (strict schemas, case scope, consent, approval-bound writes, audit)
  partners.ts      n8n webhook + signed callbacks, or a local simulated partner with the same contract
  integrations.ts  OpenAI (redacted, consent-gated) and Sarvam adapters
data/              Sample data: bill/policy documents, profiles, statements, UPI transactions, loans, offers, playbooks, users
```

### MCP: partner servers, gateway as MCP client

Each partner contract is an MCP server built with the official SDK: `insurer.v1`, `provider.v1` (hospital/TPA), `payments.v1`, `lender.v1`, `aa.v1` (Account Aggregator), `crm.v1` (Paytm Support), and `knowledge.v1`. The Saathi gateway runs its checks (allowlist, schema, case scope, playbook scope, consent, approval token, payload hash) and then calls the partner through an MCP client; partners only receive the tool arguments and the customer id in `_meta`. By default each simulated partner runs in-process; set `MCP_URL_<SERVER>` (for example `MCP_URL_INSURER=http://127.0.0.1:8000/mcp/insurer`) to reach a Streamable HTTP server instead. `GET /api/mcp/servers` shows each server's transport.

The same servers are exposed at `http://127.0.0.1:8000/mcp/<server>` (stateless Streamable HTTP, bearer token from `MCP_PARTNER_TOKEN`, or the local token printed at startup).

### Playbooks

Every journey is a playbook in `data/playbooks/*.yaml`: its triggers (English, Hinglish, Devanagari), urgency, auditor, rules engine, the MCP tools it may read and write, and its exit condition. **The gateway denies any tool the active playbook does not declare.** Hospital, UPI fraud, and EMI use unit-tested rule modules; failed UPI refund is fully declarative, evaluated by a small safe expression language (no eval).

### Trust rules enforced in code

- The client never supplies `customer_id`. Every read checks ownership, and other customers get a 404.
- Reads through the gateway need consent. Writes also need a short-lived approval token bound to the case, action, person, and payload hash. A changed amount is rejected.
- Uploaded documents pass a confidence gate. Automated claim and credit steps pause and a specialist is recommended when confidence is low.
- The audit log stores tool names, scopes, decisions, and references, never document contents or keys.

### n8n (optional)

Set `N8N_WEBHOOK_URL` and `N8N_WEBHOOK_SECRET`. Saathi POSTs `saathi.action.approved` with headers `x-saathi-signature: sha256=<HMAC of body>` and `idempotency-key`. Your workflow calls back `POST /api/partners/callback` with:

```json
{ "event_id": "unique-id", "case_id": "SA-XXXXXXXX", "action_id": "ACT-XXXXXXXX",
  "tool": "claim.submit", "status": "acknowledged | completed | failed", "message": "..." }
```

The callback must be signed the same way. Duplicate `event_id`s are ignored. If n8n is unreachable, Saathi records the fallback in the timeline and uses the local simulated partner.

### Voice, languages, and AI

Customers can chat in English, Hinglish, Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Kannada, Malayalam, Punjabi, or Odia. Saathi detects the script of each message (`assistant/language.ts`), translates it to English for the pipeline (Sarvam first, OpenAI as a fallback), shows "Saathi understood: …" under the message, and replies in the same language, with a "Show in English" toggle. The globe picker in the composer can force a reply language, even for English input. Translations that change any amount are discarded. Voice input uses Sarvam speech-to-text (with automatic language detection) after a voice consent, or the browser's speech recognition otherwise.

When the rule-based parser can't tell what a message is about (for example "Diwali is coming and the family wants that 1.2 lakh fridge and TV combo, will it hurt?"), OpenAI classifies it into one of Saathi's journeys with the amount and item (`interpretMessage` in `integrations.ts`). Saathi shows "Saathi understood: …" under the message and runs that journey, so the maths still comes from the deterministic services. An amount the customer didn't write is dropped. Common phrasings such as "I need 60000 to buy a car" are understood by the rules directly, without AI.

OpenAI also answers questions the deterministic journeys don't cover (for example "What is the difference between a mutual fund and an FD?") after the customer taps "Allow AI answers" once in chat. It receives redacted text and only the figures Saathi already has, and a numeric guard discards any answer containing rupee amounts that weren't in those figures. Without OpenAI, every reply comes from the deterministic pipeline. **More > Connected services** shows which providers are connected.

The Paytm Saathi logo is the same in Web and App views. The only exception is the Saathi tab in the app's bottom navigation, which is a raised "Saathi AI" orb (`AssistantMark`).

## Deploy to Vercel

The repo deploys as one Vercel project: the React app is served from Vercel's CDN, and the Express API runs as a single Node.js function behind `/api/*` and `/mcp/*`.

- `vercel.json` runs `npm ci`, then `npm run vercel-build`.
- `scripts/vercel-build.mjs` builds the frontend and bundles `server/src/vercel.ts` with esbuild. It writes `.vercel/output` using Vercel's [Build Output API](https://vercel.com/docs/build-output-api/v3): static files, the `api` function with the sample `data/` beside it, and the routes and security headers.
- `.vercelignore` keeps `.env`, saved SQLite files and the pitch PDFs out of uploads.

**Steps**

1. Push the repo to GitHub, then in Vercel choose **Add New > Project** and import it. Keep the root directory as the repo root; `vercel.json` sets the build. Or, from the repo root, run `npx vercel` for a preview and `npx vercel --prod` for production.
2. In **Project > Settings > Environment Variables**, add:

| Variable | Value |
| --- | --- |
| `JWT_SECRET_KEY` | At least 32 random characters. **Required**: without it each function instance signs its own sessions and users get signed out. |
| `OPENAI_API_KEY`, `OPENAI_ENABLED=true`, `OPENAI_MODEL` | Optional, for AI understanding, answers and photo OCR |
| `SARVAM_API_KEY`, `SARVAM_ENABLED=true`, `SARVAM_TRANSLATE_MODEL` | Optional, for Indian-language chat and voice |
| `DEMO_DATE` | Optional; defaults to `2026-10-03` |
| `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET` | Optional; otherwise the built-in simulated partner is used |

3. Redeploy after changing variables.

On Vercel the API automatically trusts Vercel's proxy (for rate limits), uses the deployment URL as `PUBLIC_API_BASE_URL`, and stores saved state in `/tmp/saathi.sqlite3`. Simulated partner updates arrive 1.5 seconds apart and finish in the background through Vercel's `waitUntil`.

**Limits of this setup:** `/tmp` is per function instance and temporary. Conversations, goals and linked PANs survive while an instance stays warm, but are lost on a cold start or when traffic is spread over several instances. Sample accounts and data always come back because they ship with the function. That is fine for a demo; for lasting data, point `server/src/db.ts` at a hosted database (for example Turso or Postgres). The live status stream reconnects every 60 seconds because of the function time limit, which the browser handles automatically.

## Local secrets

Keep keys in the ignored `.env` file only. Never commit credentials or paste them into chat. Rotate any API key that has been shared outside its provider dashboard. To enable an integration, set its `*_API_KEY` and the matching `*_ENABLED=true`, then restart `npm run dev`. The API prints `OpenAI: ready | Sarvam: ready` at startup when both are picked up from `.env`, and `GET /api/integrations/status` reports the same. The automated test suite switches both off so it never calls live providers; the browser end-to-end run uses them. OpenAI receives redacted text only after a per-request consent, and Sarvam receives audio only after a transcription consent. Provider calls are not tested against live accounts by the automated suite.

## Prototype limits

This build uses sample data, not production systems. Insurer, lender, and payment outcomes are simulated, and offers are labelled sample offers (no Mochatrade or lender API is connected). Holdings fetched by PAN are simulated sample statements; no CDSL, NSDL, CAMS, KFintech, or Account Aggregator connection is made. Policy retrieval is a local keyword index (Cognee is not connected). There is no OCR for scanned PDFs (upload photos of the pages instead, with OpenAI enabled), no encrypted document storage, no tamper-evident ledger, and no production-grade PII detection. Sample passcodes are not secrets. Do not upload real customer or financial documents. Security and consent are prototype design, not a compliance certification.
