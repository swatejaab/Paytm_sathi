from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from dotenv import load_dotenv

load_dotenv(override=True)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    frontend_origins: str = "http://localhost:8501"
    openai_enabled: bool = False
    openai_api_key: SecretStr | None = None
    openai_model: str = "gpt-4o-mini"
    sarvam_enabled: bool = False
    sarvam_api_key: SecretStr | None = None
    sarvam_stt_model: str = "saaras:v4"
    max_document_bytes: int = 5 * 1024 * 1024
    max_audio_bytes: int = 10 * 1024 * 1024

    @property
    def has_openai_key(self) -> bool:
        return bool(self.openai_api_key and self.openai_api_key.get_secret_value().strip())

    @property
    def has_sarvam_key(self) -> bool:
        return bool(self.sarvam_api_key and self.sarvam_api_key.get_secret_value().strip())


settings = Settings()
