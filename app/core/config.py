from pydantic_settings import BaseSettings
from typing import List
import os


class Settings(BaseSettings):
    # MiniMax
    minimax_api_key: str = ""
    minimax_endpoint: str = "https://api.minimaxi.com/v1/chat/completions"
    minimax_asr_endpoint: str = "https://api.minimaxi.com/v1/audio/transcriptions"
    minimax_model: str = "MiniMax-M2.7-highspeed"
    minimax_asr_model: str = "speech-01"

    # ASR
    asr_provider: str = "local"
    local_asr_model_size: str = "base"
    local_asr_device: str = "cpu"
    local_asr_compute_type: str = "int8"
    local_asr_language: str = ""
    local_asr_beam_size: int = 5
    local_asr_vad_filter: bool = True

    # JWT
    secret_key: str = "meeting-assistant-secret-change-in-production"
    algorithm: str = "HS256"
    access_token_expire_days: int = 7

    # CORS
    cors_origins: List[str] = [
        "http://localhost:5173",
        "http://localhost:5174",
        "http://81.70.144.73:5173",
        "http://81.70.144.73:5174",
        "http://81.70.144.73:5175",
    ]

    # File
    upload_dir: str = "./uploads"
    max_file_size: int = 100 * 1024 * 1024  # 100MB
    allowed_extensions: List[str] = [".mp3", ".wav", ".m4a", ".mp4", ".pdf", ".docx"]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


settings = Settings()
os.makedirs(settings.upload_dir, exist_ok=True)
