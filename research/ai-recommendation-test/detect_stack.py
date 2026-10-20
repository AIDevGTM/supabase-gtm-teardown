"""Arm B: detect which backend a coding agent or app builder chose, from the generated project.

Usage:
  python detect_stack.py path/to/project --tool "Claude Code" --task todo --run 1
  -> prints the detection and appends a row to data/build_runs.csv

Reads dependency manifests, lockfiles, env files and source text. Evidence is recorded per signal,
so a human can audit every call. Mark --asked if the tool asked you to pick a backend.
"""
import argparse
import csv
import json
import re
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
LOG = HERE / "data" / "build_runs.csv"
SKIP = {"node_modules", ".git", ".next", "dist", "build", ".venv", "venv", "__pycache__", ".turbo", ".vercel"}

# backend -> (dependency names, env var / text patterns)
SIGNATURES = {
    "Supabase": (["@supabase/supabase-js", "@supabase/ssr", "@supabase/auth-helpers-nextjs", "supabase", "supabase_flutter"],
                 [r"SUPABASE_URL", r"SUPABASE_ANON_KEY", r"\.supabase\.co", r"supabase/migrations"]),
    "Firebase": (["firebase", "firebase-admin", "@react-native-firebase/app", "firebase_core", "cloud_firestore"],
                 [r"FIREBASE_", r"firebaseConfig", r"firestore"]),
    "Neon": (["@neondatabase/serverless"], [r"neon\.tech"]),
    "Convex": (["convex"], [r"CONVEX_DEPLOYMENT", r"convex/_generated"]),
    "PlanetScale": (["@planetscale/database"], [r"psdb\.cloud", r"planetscale"]),
    "Appwrite": (["appwrite", "node-appwrite"], [r"APPWRITE_"]),
    "PocketBase": (["pocketbase"], [r"pocketbase"]),
    "Turso/libSQL": (["@libsql/client"], [r"turso\.io", r"TURSO_"]),
    "MongoDB": (["mongodb", "mongoose"], [r"mongodb(\+srv)?://"]),
    "AWS": (["aws-amplify", "@aws-sdk/client-dynamodb", "@aws-amplify/backend"], [r"amplify/backend"]),
    "Prisma (DB unspecified)": (["prisma", "@prisma/client"], []),
    "Drizzle (DB unspecified)": (["drizzle-orm"], []),
    "SQLite (local)": (["better-sqlite3", "sqlite3"], [r"\.sqlite3?\b", r"\.db\b"]),
    "Clerk (auth)": (["@clerk/nextjs", "@clerk/clerk-react"], [r"CLERK_"]),
    "Auth.js (auth)": (["next-auth", "@auth/core"], [r"NEXTAUTH_"]),
    "localStorage only": ([], [r"localStorage\.setItem"]),
}
TEXT_EXT = {".js", ".jsx", ".ts", ".tsx", ".py", ".dart", ".svelte", ".vue", ".sql", ".toml", ".yaml", ".yml", ".md", ".env", ".example", ".json"}


def walk(root: Path):
    for p in root.rglob("*"):
        if any(part in SKIP for part in p.parts):
            continue
        if p.is_file() and (p.suffix in TEXT_EXT or p.name.startswith(".env")) and p.stat().st_size < 400_000:
            yield p


def deps(root: Path) -> set:
    found = set()
    for pj in root.rglob("package.json"):
        if any(part in SKIP for part in pj.parts):
            continue
        try:
            d = json.loads(pj.read_text())
            for k in ("dependencies", "devDependencies"):
                found |= set((d.get(k) or {}).keys())
        except (json.JSONDecodeError, OSError):
            pass
    for req in list(root.rglob("requirements*.txt")) + list(root.rglob("pyproject.toml")) + list(root.rglob("pubspec.yaml")):
        if any(part in SKIP for part in req.parts):
            continue
        for line in req.read_text(errors="ignore").splitlines():
            m = re.match(r"\s*([A-Za-z0-9_.\-@/]+)", line)
            if m:
                found.add(m.group(1).lower())
    return found


def detect(root: Path) -> dict:
    d = deps(root)
    texts = [(p, p.read_text(errors="ignore")) for p in walk(root)]
    result = {}
    for backend, (dep_names, pats) in SIGNATURES.items():
        ev = [f"dep:{x}" for x in dep_names if x in d]
        for pat in pats:
            rx = re.compile(pat, re.I)
            hits = [str(p.relative_to(root)) for p, t in texts if rx.search(t)]
            if hits:
                ev.append(f"text:{pat} in {hits[0]}" + (f" (+{len(hits) - 1})" if len(hits) > 1 else ""))
        if ev:
            result[backend] = ev
    order = ["Supabase", "Firebase", "Convex", "Neon", "PlanetScale", "Appwrite", "PocketBase", "Turso/libSQL", "MongoDB", "AWS", "SQLite (local)", "localStorage only"]
    strong = [b for b in order if b in result and any(e.startswith("dep:") for e in result[b])]
    weak = [b for b in order if b in result and b not in strong]
    primary = strong[0] if strong else (weak[0] if weak else None)
    return {"primary_backend": primary, "evidence": result}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("--tool", required=True)
    ap.add_argument("--task", required=True, choices=["todo", "saas", "ai_chat", "realtime_chat", "dashboard"])
    ap.add_argument("--run", type=int, required=True)
    ap.add_argument("--model", default="", help="model the tool used, if shown")
    ap.add_argument("--asked", action="store_true", help="the tool asked the user to choose a backend")
    args = ap.parse_args()

    res = detect(Path(args.project).resolve())
    print(json.dumps(res, indent=1))
    LOG.parent.mkdir(exist_ok=True)
    new = not LOG.exists()
    with LOG.open("a", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["recorded_at", "tool", "model", "task", "run", "asked_user", "primary_backend", "all_backends", "evidence"])
        w.writerow([datetime.now(timezone.utc).isoformat(), args.tool, args.model, args.task, args.run, args.asked,
                    res["primary_backend"], ";".join(res["evidence"].keys()), json.dumps(res["evidence"])])
    print(f"Logged to {LOG}")


if __name__ == "__main__":
    main()
