"""Arm A: ask every model every prompt N times and save raw responses to JSONL.

Usage:
  python run_ask.py --dry-run          # 1 sample per prompt per model, to measure cost
  python run_ask.py --samples 10       # full run (resumable: finished calls are skipped)

Needs: pip install anthropic openai google-genai
Keys:  Anthropic credentials (ANTHROPIC_API_KEY or `ant auth login`), OPENAI_API_KEY, GEMINI_API_KEY.

Settings are deliberately plain: no system prompt, provider-default sampling and reasoning,
no web search, and no refusal fallbacks (so every answer comes from the model being measured).
"""
import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

HERE = Path(__file__).parent

from envload import load_env
load_env()
OUT = HERE / "data" / "responses.jsonl"
MAX_TOKENS = 16000
write_lock = Lock()


# ---------------------------------------------------------------- providers
def ask_anthropic(model: str, prompt: str) -> dict:
    import anthropic
    client = anthropic.Anthropic()
    resp = client.messages.create(
        model=model,
        max_tokens=MAX_TOKENS,
        messages=[{"role": "user", "content": prompt}],
    )
    text = "".join(b.text for b in resp.content if b.type == "text")
    return {
        "text": text,
        "stop_reason": resp.stop_reason,
        "refusal_category": getattr(getattr(resp, "stop_details", None), "category", None) if resp.stop_reason == "refusal" else None,
        "usage": {"input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens},
        "request_id": getattr(resp, "_request_id", None),
    }


def ask_openai(model: str, prompt: str) -> dict:
    # Verify against the current OpenAI SDK docs before running.
    from openai import OpenAI
    client = OpenAI()
    resp = client.responses.create(model=model, input=prompt)
    usage = getattr(resp, "usage", None)
    return {
        "text": resp.output_text,
        "stop_reason": getattr(resp, "status", None),
        "refusal_category": None,
        "usage": {"input_tokens": getattr(usage, "input_tokens", None), "output_tokens": getattr(usage, "output_tokens", None)},
        "request_id": getattr(resp, "id", None),
    }


def ask_google(model: str, prompt: str) -> dict:
    # Verify against the current google-genai SDK docs before running.
    from google import genai
    client = genai.Client()
    resp = client.models.generate_content(model=model, contents=prompt)
    um = getattr(resp, "usage_metadata", None)
    return {
        "text": resp.text or "",
        "stop_reason": str(resp.candidates[0].finish_reason) if resp.candidates else None,
        "refusal_category": None,
        "usage": {"input_tokens": getattr(um, "prompt_token_count", None), "output_tokens": getattr(um, "candidates_token_count", None)},
        "request_id": getattr(resp, "response_id", None),
    }


PROVIDERS = {"anthropic": ask_anthropic, "openai": ask_openai, "google": ask_google}


# ---------------------------------------------------------------- run
def key(model_label: str, prompt_id: str, sample: int) -> str:
    return f"{model_label}|{prompt_id}|{sample}"


def load_done() -> set:
    if not OUT.exists():
        return set()
    done = set()
    for line in OUT.read_text().splitlines():
        r = json.loads(line)
        if r.get("text") is not None or r.get("stop_reason") == "refusal":
            done.add(key(r["model_label"], r["prompt_id"], r["sample"]))
    return done


def call_with_retry(fn, model: str, prompt: str, attempts: int = 5) -> dict:
    import anthropic
    for i in range(attempts):
        try:
            return fn(model, prompt)
        except anthropic.BadRequestError:
            raise  # not retryable: bad model id or bad request
        except anthropic.NotFoundError:
            raise
        except anthropic.RateLimitError as e:
            wait = int(e.response.headers.get("retry-after", "30"))
            time.sleep(wait)
        except anthropic.APIStatusError as e:
            if e.status_code < 500:
                raise
            time.sleep(10 * (i + 1))
        except anthropic.APIConnectionError:
            time.sleep(10 * (i + 1))
        except Exception:  # other providers' SDK errors: back off and retry
            if i == attempts - 1:
                raise
            time.sleep(15 * (i + 1))
    raise RuntimeError("retries exhausted")


def run_one(m: dict, p: dict, sample: int) -> dict:
    started = datetime.now(timezone.utc).isoformat()
    base = {"model_label": m["label"], "provider": m["provider"], "model": m["model"],
            "prompt_id": p["id"], "group": p["group"], "persona": p["persona"],
            "prompt": p["text"], "sample": sample, "started_at": started}
    try:
        res = call_with_retry(PROVIDERS[m["provider"]], m["model"], p["text"])
        return {**base, **res, "error": None}
    except Exception as e:  # recorded, not fatal; the run is resumable
        return {**base, "text": None, "stop_reason": None, "error": f"{type(e).__name__}: {e}"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=int, default=10)
    ap.add_argument("--dry-run", action="store_true", help="1 sample per prompt per model")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--only", help="comma-separated model labels to run")
    args = ap.parse_args()

    prompts = json.loads((HERE / "prompts.json").read_text())
    models = json.loads((HERE / "models.json").read_text())
    if args.only:
        wanted = {s.strip() for s in args.only.split(",")}
        models = [m for m in models if m["label"] in wanted]
    bad = [m["label"] for m in models if m["model"].startswith("FILL_ME")]
    if bad:
        raise SystemExit(f"Fill in model ids in models.json first: {bad}")

    samples = 1 if args.dry_run else args.samples
    OUT.parent.mkdir(exist_ok=True)
    done = load_done()
    jobs = [(m, p, s) for m in models for p in prompts for s in range(samples)
            if key(m["label"], p["id"], s) not in done]
    print(f"{len(jobs)} calls to make ({len(done)} already done)")

    with ThreadPoolExecutor(max_workers=args.workers) as pool, OUT.open("a") as f:
        futures = [pool.submit(run_one, *j) for j in jobs]
        for n, fut in enumerate(as_completed(futures), 1):
            rec = fut.result()
            with write_lock:
                f.write(json.dumps(rec) + "\n")
                f.flush()
            if n % 25 == 0 or rec["error"]:
                print(f"{n}/{len(jobs)} {rec['model_label']} {rec['prompt_id']} {rec['error'] or 'ok'}")

    if args.dry_run:
        totals = {}
        for line in OUT.read_text().splitlines():
            r = json.loads(line)
            u = r.get("usage") or {}
            t = totals.setdefault(r["model_label"], [0, 0, 0])
            t[0] += 1; t[1] += u.get("input_tokens") or 0; t[2] += u.get("output_tokens") or 0
        print("\nDry-run token usage (multiply by --samples for the full run):")
        for label, (n, i, o) in totals.items():
            print(f"  {label:20s} calls={n:4d}  input={i:8d}  output={o:8d}")


if __name__ == "__main__":
    main()
