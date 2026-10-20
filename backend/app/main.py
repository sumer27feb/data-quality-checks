from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.routes import router as runs_router
from app.api.profile_routes import router as profiles_router
from app.api.traditional_routes import router as traditional_router

app = FastAPI(
    title="Automated Data Quality Rule Recommendation",
    description="API for generating and managing data quality rule recommendations.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(runs_router)
app.include_router(profiles_router)
app.include_router(traditional_router)


@app.get("/api/v1/health", tags=["Health"])
def health_check():
    return {"status": "healthy", "service": "data-quality-recommendation-api"}

# python -m uvicorn app.main:app --reload
