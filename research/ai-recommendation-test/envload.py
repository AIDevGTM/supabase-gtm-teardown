"""Load KEY=value lines from .env into the environment (values are never printed)."""
import os
from pathlib import Path


def load_env(path: Path = Path(__file__).parent / ".env") -> list:
    loaded = []
    if not path.exists():
        return loaded
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if v and not v.startswith("paste-"):
            os.environ.setdefault(k, v)
            loaded.append(k)
    return loaded
