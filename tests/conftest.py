"""Tests run offline and must not see keys from the developer's shell: every provider starts unconfigured."""
import pytest

import app.main as main
from app.providers import azure, google, openai_tts, polly


@pytest.fixture(autouse=True)
def _no_provider_keys(monkeypatch):
    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "")
    monkeypatch.setattr(azure, "KEY", "")
    monkeypatch.setattr(azure, "REGION", "")
    monkeypatch.setattr(google, "KEY", "")
    monkeypatch.setattr(polly, "ACCESS_KEY", "")
    monkeypatch.setattr(polly, "SECRET_KEY", "")
    monkeypatch.setattr(polly, "SESSION_TOKEN", "")
    monkeypatch.setattr(polly, "REGION", "us-east-1")
    monkeypatch.setattr(polly, "ENGINE", "neural")
    monkeypatch.setattr(openai_tts, "KEY", "")
    monkeypatch.delenv("VOICE_LOCALES", raising=False)
    main._provider_voice_cache.clear()
