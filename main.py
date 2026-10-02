from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from case_api import router as case_router
from evidence_api import router as evidence_router
from settings import settings

app = FastAPI(
	title="Paytm Saathi API",
	description="Event-first financial resolution demo API.",
	version="0.1.0",
)

frontend_origins = [origin.strip() for origin in settings.frontend_origins.split(",") if origin.strip()]

app.add_middleware(
	CORSMiddleware,
	allow_origins=frontend_origins,
	allow_credentials=True,
	allow_methods=["GET", "POST", "OPTIONS"],
	allow_headers=["Authorization", "Content-Type"],
)

app.include_router(case_router)
app.include_router(evidence_router)


@app.get("/api/health", tags=["system"])
def health_check() -> dict[str, str]:
	return {"status": "ok", "service": "paytm-saathi-api"}