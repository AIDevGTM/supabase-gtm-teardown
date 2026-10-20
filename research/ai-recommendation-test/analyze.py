"""Turn data/scored.jsonl into the numbers for the case study.

Usage:
  python analyze.py                # writes results/summary.json, results/summary.md, results/by_*.csv
  python analyze.py --labels       # also reports judge agreement against data/hand_labels.csv
  python analyze.py --metric first_mentioned   # use the deterministic primary instead of the judge
"""
import argparse
import csv
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).parent
SCORED = HERE / "data" / "scored.jsonl"
RES = HERE / "results"
TARGET = "Supabase"
RIVALS = ["Firebase", "Neon", "Convex", "PlanetScale", "AWS RDS/Aurora", "Appwrite", "MongoDB Atlas", "Postgres (generic)"]


def wilson(k: int, n: int, z: float = 1.96):
    if n == 0:
        return (None, None, None)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (round(100 * p, 1), round(100 * max(0, c - h), 1), round(100 * min(1, c + h), 1))


def rates(rows, primary_field):
    n = len(rows)
    first = sum(1 for r in rows if r.get(primary_field) == TARGET)
    mention = sum(1 for r in rows if TARGET in (r.get("mentions") or []))
    clarify = sum(1 for r in rows if (r.get("judge") or {}).get("asked_clarifying_question_instead"))
    all_m = sum(len([m for m in (r.get("mentions") or []) if m != "Postgres (generic)"]) for r in rows)
    sov = round(100 * mention / all_m, 1) if all_m else None
    positions = [(r["mentions"].index(TARGET) + 1) for r in rows if TARGET in (r.get("mentions") or [])]
    return {
        "n": n,
        "first_pick": wilson(first, n),
        "mention": wilson(mention, n),
        "clarify": wilson(clarify, n),
        "share_of_voice_pct": sov,
        "mean_position_when_mentioned": round(sum(positions) / len(positions), 2) if positions else None,
        "head_to_head_first_pick": {x: wilson(sum(1 for r in rows if r.get(primary_field) == x), n)[0] for x in [TARGET] + RIVALS},
    }


def group_by(rows, field):
    g = defaultdict(list)
    for r in rows:
        g[r[field]].append(r)
    return g


def fmt(t):
    return "n/a" if t[0] is None else f"{t[0]}% ({t[1]} to {t[2]})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--metric", default="primary", choices=["primary", "first_mentioned"])
    ap.add_argument("--labels", action="store_true")
    args = ap.parse_args()

    rows = [json.loads(l) for l in SCORED.read_text().splitlines()]
    rows = [r for r in rows if r.get("text")]
    RES.mkdir(exist_ok=True)
    pf = args.metric
    core = [r for r in rows if r["group"] != "control"]

    summary = {
        "metric": pf,
        "responses": len(rows),
        "overall_excluding_controls": rates(core, pf),
        "controls": rates([r for r in rows if r["group"] == "control"], pf),
        "by_model": {k: rates(v, pf) for k, v in group_by(core, "model_label").items()},
        "by_vendor": {k: rates(v, pf) for k, v in group_by(core, "provider").items()},
        "by_group": {k: rates(v, pf) for k, v in group_by(rows, "group").items()},
        "by_persona": {k: rates(v, pf) for k, v in group_by(core, "persona").items()},
        "top_primary_overall": Counter(r.get(pf) for r in core).most_common(12),
    }

    # hypotheses
    by_group = summary["by_group"]
    vend = summary["by_vendor"]
    gen_by_vendor = {k: rates([r for r in v if r["group"] == "generic_backend"], pf)["first_pick"][0] for k, v in group_by(rows, "model_label" if len(group_by(rows, "provider")) == 1 else "provider").items()}
    summary["hypotheses"] = {
        "H1_generic_first_pick_over_50_all_vendors": {"by_segment": gen_by_vendor, "holds": all((v or 0) > 50 for v in gen_by_vendor.values())},
        "H2_firebase_alt_over_80": {"value": by_group.get("firebase_alt", {}).get("first_pick"), "holds": (by_group.get("firebase_alt", {}).get("first_pick", [0])[0] or 0) > 80},
        "H3_ai_below_generic": {"ai": by_group.get("ai_app", {}).get("first_pick"), "generic": by_group.get("generic_backend", {}).get("first_pick")},
        "H4_controls_under_10": {"value": summary["controls"]["first_pick"], "holds": (summary["controls"]["first_pick"][0] or 0) < 10},
        "H6_vendor_spread_under_15": {"tested": len(vend) > 1, "by_vendor": {k: v["first_pick"][0] for k, v in vend.items()},
                                      "spread": (max(v["first_pick"][0] for v in vend.values()) - min(v["first_pick"][0] for v in vend.values())) if vend else None},
    }

    if args.labels:
        lab = list(csv.DictReader((HERE / "data" / "hand_labels.csv").open()))
        lab = [l for l in lab if l["YOUR_LABEL"].strip()]
        agree = sum(1 for l in lab if (l["judge_primary"] or "").lower() == l["YOUR_LABEL"].strip().lower())
        agree_det = sum(1 for l in lab if (l["first_mentioned"] or "").lower() == l["YOUR_LABEL"].strip().lower())
        summary["judge_validation"] = {"labelled": len(lab), "judge_agreement": wilson(agree, len(lab)), "first_mentioned_agreement": wilson(agree_det, len(lab))}

    (RES / "summary.json").write_text(json.dumps(summary, indent=1))

    for name in ["by_model", "by_vendor", "by_group", "by_persona"]:
        with (RES / f"{name}.csv").open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["segment", "n", "first_pick_pct", "ci_low", "ci_high", "mention_pct", "share_of_voice_pct", "mean_position"] + [f"first_pick_{x}" for x in RIVALS])
            for seg, s in summary[name].items():
                w.writerow([seg, s["n"], *s["first_pick"], s["mention"][0], s["share_of_voice_pct"], s["mean_position_when_mentioned"]] + [s["head_to_head_first_pick"][x] for x in RIVALS])

    md = [f"# Results ({pf})", "", f"Responses scored: {len(rows)}", "",
          f"**Overall (excluding controls):** Supabase first pick {fmt(summary['overall_excluding_controls']['first_pick'])}, mentioned {fmt(summary['overall_excluding_controls']['mention'])}", "",
          "| Model | n | First pick | Mentioned | Firebase first pick |", "| --- | --- | --- | --- | --- |"]
    for k, s in sorted(summary["by_model"].items(), key=lambda kv: -(kv[1]["first_pick"][0] or 0)):
        md.append(f"| {k} | {s['n']} | {fmt(s['first_pick'])} | {s['mention'][0]}% | {s['head_to_head_first_pick']['Firebase']}% |")
    md += ["", "| Prompt group | n | First pick | Mentioned |", "| --- | --- | --- | --- |"]
    for k, s in summary["by_group"].items():
        md.append(f"| {k} | {s['n']} | {fmt(s['first_pick'])} | {s['mention'][0]}% |")
    md += ["", "## Hypotheses", "", "```json", json.dumps(summary["hypotheses"], indent=1), "```"]
    (RES / "summary.md").write_text("\n".join(md))
    print("\n".join(md[:14]))


if __name__ == "__main__":
    main()
