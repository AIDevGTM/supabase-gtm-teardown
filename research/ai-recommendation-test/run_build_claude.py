"""Arm B, Claude Code part: run each build task in a fresh empty folder with Claude Code, then detect the backend.

Isolation: `claude --bare` skips CLAUDE.md, auto-memory, hooks, plugins and keychain auth, so no personal
context leaks in. Tools are limited to file tools (no shell), so the agent writes its project and manifests
but cannot install or execute anything. That deviation from a normal session is recorded in the output.

Usage: .venv/bin/python run_build_claude.py --runs 3
"""
import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from envload import load_env

HERE = Path(__file__).parent
# Builds run in a neutrally named temp folder: the project path contains "supabase", which the agent can see.
WORK = Path(tempfile.gettempdir()) / "agent-build-study"
BUILDS = HERE / "data" / "builds" / "claude-code"  # archive copy, after detection
TASKS = {
    "todo": "Build a to-do app where users can sign up, log in and save their own tasks.",
    "saas": "Build a SaaS starter with sign-up, a dashboard and a Stripe subscription.",
    "ai_chat": "Build an AI chat app that saves each user's conversation history.",
    "realtime_chat": "Build a realtime chat room that multiple people can join.",
    "dashboard": "Build an internal dashboard that shows sales data from a database.",
}
FOLLOW_UP = "Use your best judgement on any choices and finish the build."


def run(task: str, n: int) -> None:
    archive = BUILDS / f"{task}-{n}"
    if (archive / ".done").exists():
        print(f"skip {archive.name}")
        return
    d = WORK / f"app-{task.replace('_', '-')}-{n}"
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    assert "supabase" not in str(d).lower(), d
    cmd = ["claude", "--bare", "-p", f"{TASKS[task]}\n\n{FOLLOW_UP}",
           "--permission-mode", "acceptEdits",
           "--allowedTools", "Read", "Write", "Edit", "Glob", "Grep",
           "--disallowedTools", "Bash", "WebFetch", "WebSearch",
           "--output-format", "json"]
    print(f"run {d.name} ...", flush=True)
    res = subprocess.run(cmd, cwd=d, capture_output=True, text=True, timeout=1800, env=os.environ.copy())
    (d / ".claude-run.json").write_text(res.stdout or "")
    if res.returncode != 0:
        (d / ".claude-run.err").write_text(res.stderr or "")
        print(f"  failed: exit {res.returncode}: {res.stderr[:200]}")
        return
    model = ""
    try:
        out = json.loads(res.stdout)
        model = ",".join((out.get("modelUsage") or {}).keys())
    except json.JSONDecodeError:
        pass
    asked = "?" in (json.loads(res.stdout).get("result", "")[-300:] if res.stdout.startswith("{") else "") and not any(d.rglob("package.json"))
    args = ["python3", str(HERE / "detect_stack.py"), str(d), "--tool", "Claude Code (bare, file tools only)",
            "--task", task, "--run", str(n), "--model", model]
    if asked:
        args.append("--asked")
    subprocess.run(args, check=False)
    if archive.exists():
        shutil.rmtree(archive)
    shutil.copytree(d, archive)
    (archive / ".done").write_text(f"ok; built in {d}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--tasks", default=",".join(TASKS))
    a = ap.parse_args()
    loaded = load_env()
    if "ANTHROPIC_API_KEY" not in os.environ:
        raise SystemExit("ANTHROPIC_API_KEY missing: add it to .env (claude --bare only accepts an API key).")
    print(f"Loaded from .env: {', '.join(loaded)}")
    for t in a.tasks.split(","):
        for n in range(1, a.runs + 1):
            run(t, n)


if __name__ == "__main__":
    main()
