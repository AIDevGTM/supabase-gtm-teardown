"""Write results/headline.json: the per-group numbers the case study page shows (from data/scored.jsonl).

judge = Claude Sonnet 5.5's primary recommendation; first_mention = first product named (Firebase skipped
for "Firebase alternative" prompts). Both are reported so readers can see the range.
"""
import collections
import json
from pathlib import Path

HERE = Path(__file__).parent
LABELS = {
    "generic_backend": "Generic backend (database plus login)",
    "firebase_alt": "Firebase alternative",
    "stack_specific": "Named stack (Next.js, Vercel, Flutter)",
    "ai_app": "AI app (chats, embeddings, RAG)",
    "realtime": "Realtime (chat, live updates)",
    "postgres_hosting": "Postgres hosting",
    "control": "Controls (warehouse, time series, cache, Oracle)",
}


def first(x, skip=()):
    for m in x.get("mentions") or []:
        if m not in skip:
            return m


rows = [json.loads(l) for l in open(HERE / "data" / "scored.jsonl")]
out = []
for i, (g, label) in enumerate(LABELS.items(), 1):
    rs = [x for x in rows if x["group"] == g]
    skip = ("Firebase",) if g == "firebase_alt" else ()
    tops = collections.Counter(x.get("primary") for x in rs if x.get("primary"))
    top, top_n = tops.most_common(1)[0]
    top = {"Postgres (generic)": "Plain Postgres", "Server-Sent Events (SSE)": "Server-Sent Events"}.get(top, top)
    out.append({"sort": i, "prompt_group": label, "answers": len(rs),
                "supabase_judge": sum(x.get("primary") == "Supabase" for x in rs),
                "supabase_first_mention": sum(first(x, skip) == "Supabase" for x in rs),
                "top_pick": top, "top_pick_n": top_n})
models = sorted({x["model_label"] for x in rows})
(HERE / "results" / "headline.json").write_text(json.dumps({"answers": len(rows), "models": models, "judge": "claude-sonnet-5-5", "groups": out}, indent=1))
print(json.dumps(out, indent=1))
