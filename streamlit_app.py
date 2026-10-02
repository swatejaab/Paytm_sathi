import os
from typing import Any

import httpx
import streamlit as st
from dotenv import load_dotenv

load_dotenv()

st.set_page_config(page_title="Paytm Saathi", page_icon="S", layout="wide")

API_BASE_URL = os.getenv("API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
REQUEST_TIMEOUT = httpx.Timeout(8.0, connect=3.0)


@st.cache_data(ttl=5, max_entries=1)
def get_api_health(base_url: str) -> tuple[bool, str]:
    try:
        response = httpx.get(f"{base_url}/api/health", timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        payload: dict[str, Any] = response.json()
        return True, str(payload.get("service", "Saathi API"))
    except (httpx.HTTPError, ValueError):
        return False, ""


@st.cache_data(ttl=5, max_entries=1)
def get_integrations_status(base_url: str) -> dict[str, bool]:
    try:
        response = httpx.get(f"{base_url}/api/integrations/status", timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError):
        return {"openai_available": False, "sarvam_available": False}


def get_case(case_id: str) -> dict[str, Any]:
    response = httpx.get(f"{API_BASE_URL}/api/cases/{case_id}", timeout=REQUEST_TIMEOUT)
    response.raise_for_status()
    return response.json()


def submit_case(message: str) -> None:
    st.session_state.messages.append({"role": "user", "content": message})
    try:
        response = httpx.post(
            f"{API_BASE_URL}/api/cases/intake",
            json={"message": message},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
    except httpx.HTTPError:
        st.session_state.active_case = None
        st.session_state.messages.append(
            {"role": "assistant", "content": "I could not save this case. No financial action was started."}
        )
        return

    case_record = response.json()
    st.session_state.active_case = case_record
    st.session_state.messages.append(
        {"role": "assistant", "content": case_record["assistant_message"]}
    )


def reload_active_case(case_id: str) -> None:
    st.session_state.active_case = get_case(case_id)


api_online, api_service = get_api_health(API_BASE_URL)
integrations = get_integrations_status(API_BASE_URL)

st.session_state.setdefault("messages", [])
st.session_state.setdefault("active_case", None)
st.session_state.setdefault("voice_transcript", "")
if not st.session_state.messages:
    st.session_state.messages.append(
        {"role": "assistant", "content": "Tell me what happened, or open the hospital demo."}
    )

with st.sidebar:
    st.markdown("### Paytm Saathi")
    st.caption("AI financial first aid / Step 3")
    st.divider()
    st.markdown("#### Service status")
    if api_online:
        st.success(f"Connected: {api_service}")
    else:
        st.error("Saathi API is unavailable")
        st.caption("Start the backend with `uvicorn main:app --reload`.")
    st.caption(f"OpenAI analysis: {'ready' if integrations['openai_available'] else 'disabled'}")
    st.caption(f"Sarvam voice: {'ready' if integrations['sarvam_available'] else 'disabled'}")
    st.caption(f"API: {API_BASE_URL}")
    st.divider()
    st.caption("Use synthetic documents only. No claim, credit, or payment action is available.")

st.markdown(
    """
    <div style="display:flex;align-items:center;gap:14px;padding:18px 22px;
                border-radius:14px;background:#10264B;color:#F5F8FC;margin-bottom:22px">
      <span style="display:grid;place-items:center;width:52px;height:52px;flex:0 0 52px;
                   border-radius:50%;background:#00B9E8;color:#FFFFFF;font-size:29px">&#9825;</span>
      <span><strong style="font-size:20px">Paytm Saathi</strong><br>
        <small style="color:#A9DDF0">&#9679; Demo online / English</small></span>
      <span style="margin-left:auto;color:#A9DDF0;font-size:11px">FINANCIAL FIRST AID</span>
    </div>
    """,
    unsafe_allow_html=True,
)

conversation_column, resolution_column = st.columns([1.05, 0.95], gap="large")

with conversation_column:
    st.markdown("##### LIFE HAPPENED?")
    st.title("Tell Saathi what happened.")
    st.caption("One conversation. Evidence-backed next steps. You stay in control.")

    demo_clicked = st.button(
        "Open hospital demo",
        type="primary",
        icon=":material/local_hospital:",
    )
    prompt = st.chat_input("Papa hospital mein hain... what happened?")
    if demo_clicked:
        submit_case("Papa hospital mein hain. Bill INR 80,000 hai. Insurance hai, ab kya karun?")
    elif prompt:
        submit_case(prompt)

    for message in st.session_state.messages:
        with st.chat_message(message["role"]):
            st.write(message["content"])

    with st.expander("Use a voice note"):
        if integrations["sarvam_available"]:
            audio_note = st.audio_input("Record a short voice note", key="saathi_voice_note")
            voice_consent = st.checkbox(
                "I agree to send this audio to Sarvam for transcription.",
                key="saathi_voice_consent",
            )
            if st.button(
                "Transcribe with Sarvam",
                disabled=audio_note is None or not voice_consent,
                icon=":material/mic:",
            ):
                try:
                    response = httpx.post(
                        f"{API_BASE_URL}/api/voice/transcribe",
                        data={"consent_to_transcribe": "true"},
                        files={
                            "file": (
                                audio_note.name or "voice-note.wav",
                                audio_note.getvalue(),
                                audio_note.type or "audio/wav",
                            )
                        },
                        timeout=30.0,
                    )
                    response.raise_for_status()
                    st.session_state.voice_transcript = response.json()["transcript"]
                except httpx.HTTPError:
                    st.error("Voice transcription failed. Try again or type your message.")
        else:
            st.caption("Sarvam is disabled until a rotated API key is configured and the integration is enabled.")

        if st.session_state.voice_transcript:
            reviewed_transcript = st.text_area(
                "Review transcript before creating a case",
                value=st.session_state.voice_transcript,
                key="saathi_transcript_review",
            )
            if st.button("Create case from transcript", disabled=not reviewed_transcript.strip()):
                submit_case(reviewed_transcript.strip())
                st.session_state.voice_transcript = ""

with resolution_column:
    case_record = st.session_state.active_case
    if case_record:
        case_id = case_record["case_id"]
        st.badge(f"{case_id} / {case_record['status']}", color="blue")
        st.subheader("Here's your clear path")

        if case_record.get("demo_context") and not case_record.get("uploaded_documents"):
            demo_context = case_record["demo_context"]
            calculation = demo_context["calculation"]
            recommendation = demo_context["recommendation"]
            with st.container(border=True):
                insurance_column, cash_column, gap_column = st.columns(3)
                insurance_column.metric("Insurance estimate", f"₹{calculation['coverage_estimate_inr']:,}")
                cash_column.metric("You can pay now", f"₹{calculation['customer_contribution_inr']:,}")
                gap_column.metric("Exact gap", f"₹{calculation['exact_gap_inr']:,}")
                st.caption(
                    f"Bill: ₹{calculation['bill_total_inr']:,} / "
                    f"Sample policy {demo_context['policy']['clause']} and bill lines 4-7"
                )
            st.success(
                f"Illustrative path: {recommendation['title']} for ₹{recommendation['gap_inr']:,}"
            )
            st.caption("Synthetic fixture values only; this is not a coverage decision or loan offer.")
        elif case_record.get("uploaded_documents"):
            st.info("Uploaded documents are being reviewed separately. Synthetic coverage figures are hidden for this case.")
        else:
            st.write(f"Detected journey: **{case_record['event_type'].replace('_', ' ')}**")
            st.caption("This case is saved. Evidence processing is available for the hospitalization demo.")

        try:
            evidence_response = httpx.get(
                f"{API_BASE_URL}/api/cases/{case_id}/evidence",
                timeout=REQUEST_TIMEOUT,
            )
            evidence_response.raise_for_status()
            evidence = evidence_response.json()
        except httpx.HTTPError:
            evidence = None

        if evidence:
            with st.expander("Evidence and sources", expanded=True):
                st.caption(evidence["notice"])
                for source in evidence.get("retrieved_evidence", []):
                    if source.get("clause_id"):
                        citation = f"Clause {source['clause_id']} / page {source['page']}"
                    else:
                        citation = f"{source.get('document_name', 'Uploaded document')} / page {source.get('page', 1)}"
                    st.markdown(f"**{citation}**")
                    if source.get("title"):
                        st.caption(source["title"])
                    st.write(source.get("text", ""))
                if evidence.get("missing_documents"):
                    st.warning("Sample checklist: " + ", ".join(evidence["missing_documents"]))

        with st.expander("Add a bill or policy"):
            st.caption("Text-based PDF, TXT, or JSON. Maximum 5 MB each; scanned-PDF OCR is not enabled. Use synthetic files only.")
            policy_files = st.file_uploader(
                "Health policy documents",
                type=["pdf", "txt", "json"],
                accept_multiple_files=True,
                key=f"policy-upload-{case_id}",
            )
            bill_files = st.file_uploader(
                "Hospital bill documents",
                type=["pdf", "txt", "json"],
                accept_multiple_files=True,
                key=f"bill-upload-{case_id}",
            )
            if st.button(
                "Upload and extract text",
                disabled=not policy_files and not bill_files,
                icon=":material/upload_file:",
            ):
                try:
                    for document_type, files in (("policy", policy_files), ("bill", bill_files)):
                        for uploaded_file in files or []:
                            response = httpx.post(
                                f"{API_BASE_URL}/api/cases/{case_id}/documents",
                                data={"document_type": document_type},
                                files={
                                    "file": (
                                        uploaded_file.name,
                                        uploaded_file.getvalue(),
                                        uploaded_file.type or "application/octet-stream",
                                    )
                                },
                                timeout=20.0,
                            )
                            response.raise_for_status()
                    reload_active_case(case_id)
                    st.success("Text extracted and contact identifiers redacted. Original files were not retained.")
                    st.rerun()
                except httpx.HTTPError:
                    st.error("A document could not be processed. Check its type and size, then try again.")

        if integrations["openai_available"]:
            with st.expander("Ask OpenAI to summarize the evidence"):
                openai_consent = st.checkbox(
                    "I consent to sending the redacted case text and relevant evidence to OpenAI for this analysis.",
                    key=f"openai-consent-{case_id}",
                )
                if st.button(
                    "Analyze evidence",
                    disabled=not openai_consent,
                    icon=":material/psychology:",
                ):
                    try:
                        response = httpx.post(
                            f"{API_BASE_URL}/api/cases/{case_id}/analyze",
                            json={"confirm_external_processing": True},
                            timeout=25.0,
                        )
                        response.raise_for_status()
                        reload_active_case(case_id)
                        st.rerun()
                    except httpx.HTTPError:
                        st.error("Evidence analysis failed. No financial action was started.")

        analysis = case_record.get("ai_analysis")
        if analysis:
            with st.container(border=True):
                st.markdown("**AI evidence summary**")
                st.write(analysis["summary"])
                if analysis.get("observations"):
                    st.markdown("**Observations**")
                    for observation in analysis["observations"]:
                        st.markdown(f"- {observation}")
                if analysis.get("missing_information"):
                    st.markdown("**Still needs verification**")
                    for item in analysis["missing_information"]:
                        st.markdown(f"- {item}")
                if analysis.get("follow_up_questions"):
                    st.markdown("**Questions**")
                    for question in analysis["follow_up_questions"]:
                        st.markdown(f"- {question}")
                st.caption("AI text is informational; verify against cited documents and partner decisions.")

        st.button("Approve plan", disabled=True, icon=":material/lock:")
        st.caption("Approval, claims, credit, and payment execution are not implemented in this step.")
    else:
        with st.container(border=True):
            st.subheader("Here's your clear path")
            st.write("Open the hospital demo or describe your situation to create a case.")
            st.caption("The case plan and cited evidence will appear here after intake.")
