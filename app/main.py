from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.api.v1 import router as v1_router

app = FastAPI(title="AI 会议助手 API", version="1.0.0")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 路由
app.include_router(v1_router, prefix="/api/v1")


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "version": "1.0.0",
        "model": settings.minimax_model,
        "asr_provider": settings.asr_provider,
        "local_asr_model_size": settings.local_asr_model_size,
    }


@app.get("/")
async def root():
    return {"message": "AI 会议助手 API", "docs": "/docs"}
