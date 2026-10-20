"""Print the model IDs each provider currently offers, so models.json uses real, current IDs.

Usage: .venv/bin/python list_models.py
"""
from envload import load_env

load_env()


def show(title, ids):
    print(f"\n{title}")
    for i in ids:
        print(f"  {i}")


try:
    import anthropic
    show("Anthropic", [m.id for m in anthropic.Anthropic().models.list(limit=50)])
except Exception as e:
    print(f"\nAnthropic: {type(e).__name__}: {e}")

try:
    from openai import OpenAI
    ids = sorted(m.id for m in OpenAI().models.list())
    show("OpenAI (chat-capable looking)", [i for i in ids if i.startswith(("gpt", "o")) and not any(x in i for x in ("audio", "realtime", "tts", "transcribe", "image", "embedding", "search", "moderation"))])
except Exception as e:
    print(f"\nOpenAI: {type(e).__name__}: {e}")

try:
    from google import genai
    ids = sorted(m.name.replace("models/", "") for m in genai.Client().models.list())
    show("Google", [i for i in ids if i.startswith("gemini") and not any(x in i for x in ("embedding", "tts", "image", "live", "audio"))])
except Exception as e:
    print(f"\nGoogle: {type(e).__name__}: {e}")
