from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import fitz

DATA_DIR = Path(__file__).resolve().parent / "data"
SAMPLE_DOCUMENTS_PATH = DATA_DIR / "sample_documents.json"
MAX_DOCUMENT_BYTES = 5 * 1024 * 1024
MAX_DOCUMENT_PAGES = 20
MAX_EXTRACTED_CHARACTERS = 100_000


def load_sample_documents() -> dict[str, Any]:
    return json.loads(SAMPLE_DOCUMENTS_PATH.read_text(encoding="utf-8"))


def redact_contact_identifiers(text: str) -> str:
    text = re.sub(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "[REDACTED_EMAIL]", text)
    text = re.sub(r"(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)", "[REDACTED_PHONE]", text)
    text = re.sub(r"\b[A-Z]{5}\d{4}[A-Z]\b", "[REDACTED_ID]", text, flags=re.IGNORECASE)
    text = re.sub(r"(?<!\d)(?:\d[ -]?){11,18}\d(?!\d)", "[REDACTED_ID]", text)
    return text


def extract_document_text(
    filename: str,
    content_type: str,
    content: bytes,
) -> tuple[str, int]:
    if not content:
        raise ValueError("The uploaded document is empty.")
    if len(content) > MAX_DOCUMENT_BYTES:
        raise ValueError("Each document must be 5 MB or smaller.")

    suffix = Path(filename).suffix.casefold()
    if suffix == ".pdf" and content_type in {"application/pdf", "application/octet-stream"}:
        if not content.startswith(b"%PDF-"):
            raise ValueError("The uploaded file is not a valid PDF.")
        try:
            with fitz.open(stream=content, filetype="pdf") as document:
                if document.is_encrypted:
                    raise ValueError("Password-protected PDFs are not supported.")
                if len(document) > MAX_DOCUMENT_PAGES:
                    raise ValueError("Documents may contain at most 20 pages.")
                page_text = [
                    f"[Page {page_number}]\n{page.get_text('text')}"
                    for page_number, page in enumerate(document, start=1)
                ]
        except fitz.FileDataError as error:
            raise ValueError("The uploaded PDF could not be read.") from error
        extracted = "\n\n".join(page_text)
        page_count = len(page_text)
        if not extracted.strip():
            raise ValueError("This PDF has no selectable text. Scanned-document OCR is not enabled yet.")
    elif suffix in {".txt", ".json"} and content_type in {
        "text/plain",
        "application/json",
        "application/octet-stream",
    }:
        try:
            decoded = content.decode("utf-8-sig")
            if suffix == ".json":
                decoded = json.dumps(json.loads(decoded), ensure_ascii=True, indent=2)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("Upload valid UTF-8 text or JSON.") from error
        extracted = decoded
        page_count = 1
    else:
        raise ValueError("Supported documents are text-based PDF, TXT, or JSON files.")

    if len(extracted) > MAX_EXTRACTED_CHARACTERS:
        raise ValueError("Extracted document text exceeds the 100,000 character limit.")
    return redact_contact_identifiers(extracted), page_count


def retrieve_policy_clauses(query: str, top_k: int = 3) -> list[dict[str, Any]]:
    sample = load_sample_documents()
    query_terms = set(re.findall(r"[a-z0-9]+", query.casefold()))
    ranked: list[tuple[int, int, dict[str, Any]]] = []

    for index, clause in enumerate(sample["policy"]["clauses"]):
        clause_text = f"{clause['title']} {clause['text']}".casefold()
        clause_terms = set(re.findall(r"[a-z0-9]+", clause_text))
        overlap = len(query_terms & clause_terms)
        if overlap:
            ranked.append((overlap, -index, clause))

    ranked.sort(reverse=True, key=lambda item: (item[0], item[1]))
    return [
        {
            "document_id": sample["policy"]["document_id"],
            "document_name": sample["policy"]["file_name"],
            "clause_id": clause["clause_id"],
            "page": clause["page"],
            "title": clause["title"],
            "text": clause["text"],
            "estimated_coverage_inr": clause["estimated_coverage_inr"],
            "score": score,
        }
        for score, _, clause in ranked[:top_k]
    ]


def retrieve_uploaded_passages(
    query: str,
    documents: list[dict[str, Any]],
    top_k: int = 4,
) -> list[dict[str, Any]]:
    query_terms = set(re.findall(r"[a-z0-9]+", query.casefold()))
    ranked: list[tuple[int, int, int, dict[str, Any]]] = []

    for document_index, document in enumerate(documents):
        page_chunks = re.split(r"(?=\[Page \d+\])", str(document.get("text", "")))
        for chunk_index, chunk in enumerate(page_chunks):
            cleaned_chunk = chunk.strip()
            if not cleaned_chunk:
                continue
            page_match = re.match(r"\[Page (\d+)\]", cleaned_chunk)
            page_number = int(page_match.group(1)) if page_match else chunk_index + 1
            body = re.sub(r"^\[Page \d+\]\s*", "", cleaned_chunk).strip()
            passage_terms = set(re.findall(r"[a-z0-9]+", body.casefold()))
            score = len(query_terms & passage_terms)
            if score:
                ranked.append(
                    (
                        score,
                        -document_index,
                        -chunk_index,
                        {
                            "document_id": document.get("document_id"),
                            "document_name": document.get("document_name"),
                            "document_type": document.get("document_type"),
                            "page": page_number,
                            "text": body[:3000],
                        },
                    )
                )

    ranked.sort(reverse=True, key=lambda item: (item[0], item[1], item[2]))
    return [
        {**passage, "score": score}
        for score, _, _, passage in ranked[: max(0, min(top_k, 5))]
    ]


def calculate_sample_gap(sample: dict[str, Any] | None = None) -> dict[str, int]:
    source = sample or load_sample_documents()
    bill_total = int(source["bill"]["total_inr"])
    line_total = sum(int(line["amount_inr"]) for line in source["bill"]["lines"])
    coverage = int(source["policy"]["estimated_coverage_inr"])
    customer_contribution = int(source["customer_context"]["available_to_pay_inr"])

    if bill_total != line_total:
        raise ValueError("Sample bill lines do not reconcile to the stated total.")
    if min(bill_total, coverage, customer_contribution) < 0 or coverage > bill_total:
        raise ValueError("Sample financial values are outside valid bounds.")

    exact_gap = max(bill_total - coverage - customer_contribution, 0)
    return {
        "bill_total_inr": bill_total,
        "coverage_estimate_inr": coverage,
        "customer_contribution_inr": customer_contribution,
        "exact_gap_inr": exact_gap,
    }


def build_sample_evidence() -> dict[str, Any]:
    sample = load_sample_documents()
    bill_text = "\n".join(
        f"Line {line['line']}: {line['description']} - INR {line['amount_inr']}"
        for line in sample["bill"]["lines"]
    )
    policy_text = "\n".join(
        f"Clause {clause['clause_id']} (page {clause['page']}), {clause['title']}: {clause['text']}"
        for clause in sample["policy"]["clauses"]
    )
    return {
        "fixture_id": sample["fixture_id"],
        "documents": [
            {
                "document_type": "bill",
                "document_name": sample["bill"]["file_name"],
                "text": bill_text,
            },
            {
                "document_type": "policy",
                "document_name": sample["policy"]["file_name"],
                "text": policy_text,
            },
        ],
        "bill": sample["bill"],
        "policy": sample["policy"],
        "customer_context": sample["customer_context"],
        "missing_documents": sample["missing_documents"],
        "calculation": calculate_sample_gap(sample),
        "retrieved_evidence": retrieve_policy_clauses(
            "hospital inpatient claim room bill documents", top_k=3
        ),
    }
