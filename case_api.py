from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from evidence_service import build_sample_evidence

DATA_DIR = Path(__file__).resolve().parent / "data"
DATA_DIR.mkdir(exist_ok=True)
DATABASE_PATH = DATA_DIR / "saathi_demo.sqlite3"
HOSPITAL_DEMO = json.loads((DATA_DIR / "hospital_demo.json").read_text(encoding="utf-8"))
router = APIRouter(prefix="/api", tags=["cases"])


class CaseIntakeRequest(BaseModel):
    message: str = Field(min_length=8, max_length=2000)
    customer_id: str = Field(default="demo-customer-01", min_length=3, max_length=80)


class CaseIntakeResponse(BaseModel):
    case_id: str
    customer_id: str
    event_type: str
    status: str
    customer_message: str
    assistant_message: str
    created_at: str
    demo_context: dict[str, Any] | None = None
    evidence: dict[str, Any] | None = None
    uploaded_documents: list[dict[str, Any]] = Field(default_factory=list)
    ai_analysis: dict[str, Any] | None = None


def initialize_database() -> None:
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS cases ("
            "case_id TEXT PRIMARY KEY, payload TEXT NOT NULL)"
        )


def classify_event(message: str) -> str:
    normalized = message.casefold()
    if any(term in normalized for term in ("hospital", "hospitalized", "admitted", "papa", "father", "mother")):
        return "hospitalization"
    if any(term in normalized for term in ("upi", "unrecognized transaction", "not mine", "fraud")):
        return "upi_dispute"
    if any(term in normalized for term in ("emi", "salary delayed", "loan payment")):
        return "emi_shortfall"
    return "general_financial_support"


def build_hospital_demo_context() -> dict[str, Any]:
    context = deepcopy(HOSPITAL_DEMO)
    bill_total = int(context["bill"]["total_inr"])
    coverage_estimate = int(context["policy"]["estimated_coverage_inr"])
    customer_contribution = int(context["financial_context"]["available_to_pay_inr"])
    exact_gap = max(bill_total - coverage_estimate - customer_contribution, 0)
    context["calculation"] = {
        "bill_total_inr": bill_total,
        "coverage_estimate_inr": coverage_estimate,
        "customer_contribution_inr": customer_contribution,
        "exact_gap_inr": exact_gap,
    }
    context["recommendation"]["gap_inr"] = exact_gap
    return context


initialize_database()


def get_case_payload(case_id: str) -> dict[str, Any]:
    with sqlite3.connect(DATABASE_PATH) as connection:
        row = connection.execute(
            "SELECT payload FROM cases WHERE case_id = ?",
            (case_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Case not found")
    return json.loads(row[0])


def save_case_payload(case_id: str, payload: dict[str, Any]) -> None:
    with sqlite3.connect(DATABASE_PATH) as connection:
        cursor = connection.execute(
            "UPDATE cases SET payload = ? WHERE case_id = ?",
            (json.dumps(payload, ensure_ascii=True), case_id),
        )
    if cursor.rowcount != 1:
        raise HTTPException(status_code=404, detail="Case not found")


@router.post("/cases/intake", response_model=CaseIntakeResponse, status_code=201)
def create_case_intake(request: CaseIntakeRequest) -> CaseIntakeResponse:
    event_type = classify_event(request.message)
    demo_context = build_hospital_demo_context() if event_type == "hospitalization" else None
    evidence = build_sample_evidence() if event_type == "hospitalization" else None
    case_id = f"SA-{uuid4().hex[:8].upper()}"
    created_at = datetime.now(timezone.utc).isoformat()
    if demo_context is not None:
        assistant_message = (
            "I opened the synthetic hospital demo case. Its bill, policy estimate, "
            "and available-cash figures are illustrative, not an insurer decision."
        )
    else:
        assistant_message = (
            "I opened a draft case. This step records the situation only; "
            "evidence review and recommendations come next."
        )

    record = CaseIntakeResponse(
        case_id=case_id,
        customer_id=request.customer_id,
        event_type=event_type,
        status="intake_received",
        customer_message=request.message.strip(),
        assistant_message=assistant_message,
        created_at=created_at,
        demo_context=demo_context,
        evidence=evidence,
    )
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            "INSERT INTO cases (case_id, payload) VALUES (?, ?)",
            (case_id, record.model_dump_json()),
        )
    return record


@router.get("/cases/{case_id}", response_model=CaseIntakeResponse)
def get_case(case_id: str) -> CaseIntakeResponse:
    return CaseIntakeResponse.model_validate(get_case_payload(case_id))
