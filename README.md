# Paytm Saathi

An event-first financial resolution demo. The first build milestone provides a Streamlit frontend and FastAPI backend.

## Prerequisites

- Python 3.11 or newer
- Streamlit 1.59.2 or newer

## Backend

From the repository root in PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
uvicorn main:app --reload
```

The API health endpoint is `http://127.0.0.1:8000/api/health`. Case intake is `POST /api/cases/intake`; retrieve a saved case with `GET /api/cases/{case_id}`. Interactive API docs are at `http://127.0.0.1:8000/docs`.

Step 2 uses the synthetic fixture at `data/hospital_demo.json` and stores created cases in an ignored local SQLite database. Hospital figures are illustrative demo values, not policy decisions or real customer data.

Step 3 adds `POST /api/cases/{case_id}/documents` for text-based PDF, TXT, or JSON uploads (5 MB per file, four files per case), `GET /api/cases/{case_id}/evidence` for source-linked passages, and consent-gated `POST /api/cases/{case_id}/analyze`. `POST /api/voice/transcribe` sends audio to Sarvam only when transcription consent is submitted and the provider is enabled. Scanned-PDF OCR is not enabled.

## Streamlit frontend

In a second PowerShell terminal, from the repository root:

```powershell
.\.venv\Scripts\Activate.ps1
python -m streamlit run streamlit_app.py
```

Open `http://localhost:8501`. The first screen checks that the FastAPI backend is reachable.

## Local secrets

Keep keys in the ignored `.env` file only. Never commit credentials or paste them into chat. `.env.example` intentionally contains blank placeholders. Rotate any API key that has been shared outside its provider dashboard. To enable an integration after rotation, set its `*_API_KEY` value and the matching `*_ENABLED=true` value in `.env`, then restart both app processes. OpenAI receives redacted text only after a per-request consent; Sarvam receives audio only after a transcription consent. The provider calls are not tested against live accounts by the automated suite.

## Prototype limits

This build is suitable for a synthetic-data hackathon demo, not production deployment. It does not yet provide customer authentication/authorization, OCR for scanned documents, encrypted document storage, insurer/lender execution, a tamper-evident audit ledger, or production-grade PII detection. Do not upload real customer or financial documents.