from __future__ import annotations

import json

import fitz
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

import integration_service
from main import app
from settings import settings

client = TestClient(app)


def create_hospital_case() -> str:
    response = client.post(
        "/api/cases/intake",
        json={"message": "Papa is in hospital. Please help with the policy and bill."},
    )
    assert response.status_code == 201
    return response.json()["case_id"]


def test_uploaded_policy_evidence_cites_its_own_page() -> None:
    case_id = create_hospital_case()
    uploaded_text = b"[Page 2]\nInpatient room expenses require receipts under clause R-7."
    upload = client.post(
        f"/api/cases/{case_id}/documents",
        data={"document_type": "policy"},
        files={"file": ("uploaded-policy.txt", uploaded_text, "text/plain")},
    )

    assert upload.status_code == 201
    evidence = client.get(f"/api/cases/{case_id}/evidence").json()
    citation = evidence["retrieved_evidence"][0]
    assert citation["document_id"] == upload.json()["document_id"]
    assert citation["document_name"] == "uploaded-policy.txt"
    assert citation["page"] == 2
    assert citation["document_id"] != "POLICY-DEMO-001"
    assert evidence["demo_only"] is False


def test_non_hospital_case_does_not_receive_synthetic_hospital_evidence() -> None:
    response = client.post(
        "/api/cases/intake",
        json={"message": "I want help organizing my monthly spending."},
    )
    case_id = response.json()["case_id"]

    evidence = client.get(f"/api/cases/{case_id}/evidence").json()

    assert evidence["documents"] == []
    assert evidence["retrieved_evidence"] == []
    assert evidence["calculation"] is None
    assert evidence["demo_only"] is False


def test_pdf_upload_extracts_page_text_without_storing_original_file() -> None:
    case_id = create_hospital_case()
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), "Synthetic policy clause R-7 covers inpatient treatment.")
    pdf_content = document.tobytes()
    document.close()

    upload = client.post(
        f"/api/cases/{case_id}/documents",
        data={"document_type": "policy"},
        files={"file": ("synthetic-policy.pdf", pdf_content, "application/pdf")},
    )

    assert upload.status_code == 201
    assert upload.json()["page_count"] == 1
    saved_case = client.get(f"/api/cases/{case_id}").json()
    assert saved_case["uploaded_documents"][0]["text"].startswith("[Page 1]")
    assert "pdf_content" not in saved_case["uploaded_documents"][0]


def test_document_upload_rejects_unsupported_files() -> None:
    case_id = create_hospital_case()
    response = client.post(
        f"/api/cases/{case_id}/documents",
        data={"document_type": "bill"},
        files={"file": ("bill.exe", b"not a document", "application/octet-stream")},
    )

    assert response.status_code == 422


def test_openai_endpoint_requires_explicit_consent_and_enabled_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    case_id = create_hospital_case()
    monkeypatch.setattr(settings, "openai_enabled", False)

    no_consent = client.post(
        f"/api/cases/{case_id}/analyze",
        json={"confirm_external_processing": False},
    )
    disabled = client.post(
        f"/api/cases/{case_id}/analyze",
        json={"confirm_external_processing": True},
    )

    assert no_consent.status_code == 403
    assert disabled.status_code == 503


def test_sarvam_endpoint_requires_explicit_consent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "sarvam_enabled", False)
    files = {"file": ("voice.wav", b"synthetic audio", "audio/wav")}

    no_consent = client.post("/api/voice/transcribe", files=files)
    disabled = client.post(
        "/api/voice/transcribe",
        data={"consent_to_transcribe": "true"},
        files=files,
    )

    assert no_consent.status_code == 403
    assert disabled.status_code == 503


def test_openai_adapter_uses_redacted_structured_evidence(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "openai_enabled", True)
    monkeypatch.setattr(settings, "openai_api_key", SecretStr("unit-test-key"))
    captured: dict[str, object] = {}

    class FakeCompletions:
        def create(self, **kwargs: object) -> object:
            captured.update(kwargs)

            class Message:
                content = json.dumps(
                    {
                        "summary": "The uploaded policy discusses inpatient expenses.",
                        "observations": ["Clause page evidence is available."],
                        "missing_information": [],
                        "follow_up_questions": [],
                    }
                )

            class Choice:
                message = Message()

            class Completion:
                choices = [Choice()]

            return Completion()

    class FakeClient:
        def __init__(self, **kwargs: object) -> None:
            captured["client_options"] = kwargs
            self.chat = type("Chat", (), {"completions": FakeCompletions()})()

        def close(self) -> None:
            captured["closed"] = True

    monkeypatch.setattr(integration_service, "OpenAI", FakeClient)
    result = integration_service.analyze_case_with_openai(
        "Policy for demo@example.org",
        {
            "event_type": "hospitalization",
            "documents": [
                {
                    "document_type": "policy",
                    "document_name": "policy.txt",
                    "text": "[Page 2] Inpatient coverage details.",
                }
            ],
            "retrieved_evidence": [
                {
                    "document_id": "DOC-1",
                    "clause_id": "R-7",
                    "page": 2,
                    "title": "Inpatient cover",
                    "text": "Synthetic cited policy passage.",
                }
            ],
        },
    )

    sent_messages = captured["messages"]
    assert isinstance(sent_messages, list)
    assert "demo@example.org" not in str(sent_messages)
    assert "DOC-1" in str(sent_messages)
    assert captured["response_format"] == {"type": "json_object"}
    assert result["summary"].startswith("The uploaded policy")
    assert captured["closed"] is True


def test_sarvam_adapter_uses_documented_multipart_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "sarvam_enabled", True)
    monkeypatch.setattr(settings, "sarvam_api_key", SecretStr("unit-test-key"))
    captured: dict[str, object] = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return {
                "transcript": "Papa hospital mein hain.",
                "language_code": "hi-IN",
                "request_id": "unit-test-request",
            }

    class FakeHttpClient:
        def __init__(self, **kwargs: object) -> None:
            captured["timeout"] = kwargs["timeout"]

        def __enter__(self) -> "FakeHttpClient":
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def post(self, url: str, **kwargs: object) -> FakeResponse:
            captured["url"] = url
            captured.update(kwargs)
            return FakeResponse()

    monkeypatch.setattr(integration_service.httpx, "Client", FakeHttpClient)
    result = integration_service.transcribe_with_sarvam(
        b"synthetic-audio",
        "voice.wav",
        "audio/wav",
    )

    assert captured["url"] == "https://api.sarvam.ai/speech-to-text"
    assert captured["headers"] == {"api-subscription-key": "unit-test-key"}
    assert captured["data"] == {"model": "saaras:v4", "language_code": "unknown"}
    assert result["transcript"] == "Papa hospital mein hain."
    assert result["language_code"] == "hi-IN"
