from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_hospital_intake_persists_case_and_calculates_exact_gap() -> None:
    response = client.post(
        "/api/cases/intake",
        json={
            "message": "Papa is in hospital. The bill is INR 80,000. What should I do?"
        },
    )

    assert response.status_code == 201
    case = response.json()
    assert case["event_type"] == "hospitalization"
    assert case["status"] == "intake_received"
    assert case["demo_context"]["calculation"]["exact_gap_inr"] == 15000

    saved_case = client.get(f"/api/cases/{case['case_id']}")
    assert saved_case.status_code == 200
    assert saved_case.json() == case


def test_general_intake_does_not_attach_hospital_facts() -> None:
    response = client.post(
        "/api/cases/intake",
        json={"message": "I want help understanding my monthly money."},
    )

    assert response.status_code == 201
    assert response.json()["event_type"] == "general_financial_support"
    assert response.json()["demo_context"] is None


def test_intake_rejects_messages_that_are_too_short() -> None:
    response = client.post("/api/cases/intake", json={"message": "Help"})

    assert response.status_code == 422
