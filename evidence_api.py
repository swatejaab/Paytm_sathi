from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from case_api import get_case_payload, save_case_payload
from evidence_service import (
    build_sample_evidence,
    extract_document_text,
    retrieve_uploaded_passages,
)
from integration_service import (
    IntegrationDisabledError,
    IntegrationRequestError,
    analyze_case_with_openai,
    transcribe_with_sarvam,
)
from settings import settings

router = APIRouter(prefix="/api", tags=["evidence and AI"])


class ExternalAnalysisConsent(BaseModel):
    confirm_external_processing: bool = False


@router.get("/integrations/status")
def get_integration_status() -> dict[str, bool]:
    return {
        "openai_available": settings.openai_enabled and settings.has_openai_key,
        "sarvam_available": settings.sarvam_enabled and settings.has_sarvam_key,
    }


@router.get("/cases/{case_id}/evidence")
def get_case_evidence(case_id: str) -> dict:
    case_payload = get_case_payload(case_id)
    uploads = case_payload.get("uploaded_documents", [])
    evidence = case_payload.get("evidence")
    if uploads:
        evidence = dict(evidence or {})
        evidence["documents"] = uploads
        policy_documents = [document for document in uploads if document["document_type"] == "policy"]
        evidence["retrieved_evidence"] = retrieve_uploaded_passages(
            f"{case_payload['customer_message']} insurance policy coverage hospital inpatient claim documents",
            policy_documents,
        )
        evidence["missing_documents"] = []
        evidence["demo_only"] = False
        evidence["notice"] = (
            "Uploaded-document text is shown for review. The sample coverage calculation "
            "is synthetic and was not derived from these uploads."
        )
    elif evidence is None:
        return {
            "case_id": case_id,
            "demo_only": False,
            "documents": [],
            "retrieved_evidence": [],
            "missing_documents": [],
            "calculation": None,
            "notice": "No documents or evidence are attached to this case yet.",
        }
    return {
        "case_id": case_id,
        "demo_only": not bool(uploads),
        "documents": evidence.get("documents", []),
        "retrieved_evidence": evidence.get("retrieved_evidence", evidence.get("retrieved_clauses", [])),
        "missing_documents": evidence.get("missing_documents", []),
        "calculation": None if uploads else evidence.get("calculation"),
        "notice": evidence.get("notice", "Synthetic sample evidence; not a real coverage decision."),
    }


@router.post("/cases/{case_id}/documents", status_code=201)
async def upload_case_document(
    case_id: str,
    document_type: Literal["bill", "policy"] = Form(...),
    file: UploadFile = File(...),
) -> dict[str, str | int]:
    case_payload = get_case_payload(case_id)
    filename = Path(file.filename or "uploaded-document").name[:120]
    content_type = (file.content_type or "application/octet-stream").casefold()
    content = await file.read(settings.max_document_bytes + 1)
    await file.close()
    try:
        extracted_text, page_count = extract_document_text(filename, content_type, content)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    document = {
        "document_id": f"DOC-{uuid4().hex[:10].upper()}",
        "document_type": document_type,
        "document_name": filename,
        "content_type": content_type,
        "page_count": page_count,
        "text": extracted_text,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
    }
    uploaded_documents = case_payload.setdefault("uploaded_documents", [])
    if len(uploaded_documents) >= 4:
        raise HTTPException(status_code=422, detail="A case may contain at most four uploaded documents.")
    if sum(len(item.get("text", "")) for item in uploaded_documents) + len(extracted_text) > 200_000:
        raise HTTPException(status_code=422, detail="Combined extracted text exceeds the 200,000 character case limit.")
    uploaded_documents.append(document)
    save_case_payload(case_id, case_payload)
    return {
        "document_id": document["document_id"],
        "document_name": filename,
        "document_type": document_type,
        "page_count": page_count,
        "extracted_characters": len(extracted_text),
        "message": "Text extracted and contact identifiers redacted. Original file and audio were not stored.",
    }


@router.post("/cases/{case_id}/analyze")
def analyze_case(
    case_id: str,
    consent: ExternalAnalysisConsent,
) -> dict:
    if not consent.confirm_external_processing:
        raise HTTPException(
            status_code=403,
            detail="Explicit consent is required before sending redacted case text to OpenAI.",
        )
    case_payload = get_case_payload(case_id)
    uploads = case_payload.get("uploaded_documents", [])
    if uploads:
        evidence = {
            "event_type": case_payload.get("event_type"),
            "documents": uploads,
            "retrieved_evidence": retrieve_uploaded_passages(
                f"{case_payload['customer_message']} insurance policy coverage hospital inpatient claim documents",
                [document for document in uploads if document["document_type"] == "policy"],
            ),
            "missing_documents": [],
        }
    else:
        evidence = case_payload.get("evidence") or {
            "documents": [],
            "retrieved_evidence": [],
            "missing_documents": [],
        }
        evidence["event_type"] = case_payload.get("event_type")

    try:
        analysis = analyze_case_with_openai(case_payload["customer_message"], evidence)
    except IntegrationDisabledError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except IntegrationRequestError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

    case_payload["ai_analysis"] = {
        **analysis,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "consent_purpose": "analyze_redacted_case_text_with_openai",
    }
    save_case_payload(case_id, case_payload)
    return {"case_id": case_id, "analysis": case_payload["ai_analysis"]}


@router.post("/voice/transcribe")
async def transcribe_voice_note(
    file: UploadFile = File(...),
    consent_to_transcribe: bool = Form(False),
) -> dict[str, str | None]:
    if not consent_to_transcribe:
        raise HTTPException(status_code=403, detail="Consent is required before sending audio to Sarvam.")
    if not settings.sarvam_enabled or not settings.has_sarvam_key:
        raise HTTPException(status_code=503, detail="Sarvam voice transcription is disabled or not configured.")
    filename = Path(file.filename or "voice-note.wav").name[:120]
    content_type = (file.content_type or "application/octet-stream").casefold()
    audio = await file.read(settings.max_audio_bytes + 1)
    await file.close()
    try:
        return transcribe_with_sarvam(audio, filename, content_type)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except IntegrationDisabledError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except IntegrationRequestError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
