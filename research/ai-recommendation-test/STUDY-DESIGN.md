# Which backend does AI pick? Study design

**Question.** When software is started by asking an AI, which backend does the AI choose, and how often is it Supabase?

Supabase's CEO says agents now launch most new databases on the platform and that "the LLM slurped up a lot of Supabase." Nobody has published independent numbers on *why*: whether models recommend Supabase when asked, whether coding agents install it when not asked, and how much that depends on how the question is phrased. This study measures both.

Two arms:

| Arm | What it measures | How |
| --- | --- | --- |
| **A. Ask** | What models *recommend* when a developer asks | 34 prompts × 7 models × 10 samples, scored automatically |
| **B. Build** | What coding agents and app builders *install* when told to build something | 5 build tasks × 8 tools × 3 runs, scored by inspecting the generated project |

Arm B is the one that matches how Supabase actually gets adopted now. Arm A explains it.

---

## Pre-registered hypotheses

Write these down (commit this file) **before** running anything, so the results can't be retrofitted.

| # | Hypothesis | Supports the case study if |
| --- | --- | --- |
| H1 | For generic "database + login for my app" prompts, Supabase is the first recommendation in more than 50% of responses, across all three vendors | It's true for every vendor, not just one |
| H2 | "Firebase alternative" framing makes Supabase the first pick in more than 80% of responses | Borrowed category still works in the model's head, six years later |
| H3 | AI-app prompts (vectors, RAG) show a lower Supabase share than generic prompts, because specialist vector databases compete | The share drops but Supabase still appears in most answers |
| H4 | Control prompts (data warehouse, cache, time series, enterprise Oracle) show Supabase as first pick under 10% of the time | Validity check: the measurement isn't just "Supabase everywhere" |
| H5 | Agents (arm B) choose Supabase more often than chat models recommend it (arm A) | Defaults are stronger than recommendations |
| H6 | Supabase's first-pick share differs by less than 15 points between vendors | It's training-data gravity, not one lab's quirk |

---

## Arm A: Ask

### Prompts (`prompts.json`)

34 prompts in 7 groups. **Supabase is never named** in any prompt. Only one group names a competitor (Firebase), on purpose.

| Group | n | Example | Why |
| --- | --- | --- | --- |
| `generic_backend` | 6 | "I'm building a web app and need a database and user login. What should I use?" | The core day-zero question |
| `firebase_alt` | 5 | "What's a good alternative to Firebase?" | Tests the borrowed category directly (H2) |
| `stack_specific` | 6 | "Best backend for a Next.js SaaS with auth and payments?" | Frameworks Supabase is often paired with |
| `ai_app` | 5 | "I'm building an AI chat app. Where should I store conversations and embeddings?" | The AI wave (H3) |
| `realtime` | 4 | "I need a backend for a realtime multiplayer whiteboard. What would you use?" | Supabase's origin feature |
| `postgres_hosting` | 4 | "Where should a new startup host Postgres?" | Head-to-head with Neon, RDS and others |
| `control` | 4 | "I need a data warehouse for 10 TB of event data." | Validity (H4) |

Each non-control group mixes three personas in the wording: a beginner building with AI tools, a senior engineer, and a startup CTO. Persona is tagged per prompt so it can be analysed.

### Models (`models.json`)

| Vendor | Models | Note |
| --- | --- | --- |
| Anthropic | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` | Default settings: no system prompt, default effort |
| OpenAI | current flagship + current small model | Fill the exact IDs on the run date |
| Google | current Gemini Pro + Flash | Fill the exact IDs on the run date |

**Settings, held constant:** no system prompt, no custom instructions, no memory, provider-default temperature and reasoning effort, **web search off** (this measures what the model learned, which is the "slurped up" claim). An optional second run with web search on shows how much live search changes the answer.

**Samples:** 10 per prompt per model, so 2,380 responses. Ten samples gives a 95% interval of about ±5 points per model on a 34-prompt aggregate (n = 340), which is tight enough for the headline claims.

### Scoring (`score.py`)

Two layers, so the numbers don't depend on a single judge:

1. **Deterministic mention extraction.** A dictionary of about 30 products and aliases (Supabase, Firebase/Firestore, Neon, PlanetScale, Convex, Appwrite, PocketBase, AWS RDS/Aurora/Amplify/DynamoDB, MongoDB Atlas, Turso, Xata, Nhost, Clerk, Auth0, Pinecone, and others). For each response: which products are mentioned, and in what order they first appear. Generic "Postgres" is tracked separately and never credited to Supabase.
2. **LLM judge for the first recommendation.** Claude Sonnet 5.5 reads each response with structured output and returns: the primary recommendation (or none), the ordered recommended list, whether it asked a clarifying question instead of recommending, and the tone toward Supabase if mentioned.
   - The judge only extracts. It never sees which model wrote the response.
   - **Validation:** hand-label 100 random responses (stratified by vendor) and report agreement with the judge. Below 90% agreement, fall back to the deterministic "first product mentioned" as the primary metric.
   - Because the judge is a Claude model and Claude is also a subject, disagreements on Claude-written answers are reported separately.

### Metrics (`analyze.py`)

| Metric | Definition |
| --- | --- |
| **First-pick rate** | % of responses whose primary recommendation is Supabase (headline) |
| **Mention rate** | % of responses that mention Supabase at all |
| **Share of voice** | Supabase mentions ÷ all product mentions |
| **Mean position** | Average rank of Supabase among products named, when present |
| **Head-to-head** | First-pick rate of Supabase vs Firebase, Neon, Convex and others, per group |
| **Clarify rate** | % of responses that asked a question instead of recommending |

Every rate comes with a Wilson 95% confidence interval, broken down by vendor, model, prompt group and persona.

### Cost and time (estimate; measure on a dry run first)

About 2,380 subject calls plus 2,380 judge calls. With short prompts and answers of roughly 600 to 900 tokens, expect **tens of dollars, not hundreds**. Most of that is the judge and the flagship models. Run `run_ask.py --dry-run` (1 sample per prompt per model) first and multiply the logged usage by 10 before the full run. Wall-clock time is about 1 to 2 hours with modest concurrency.

---

## Arm B: Build

### Tools

| Type | Tools | Report as |
| --- | --- | --- |
| Coding agents (CLI or IDE) | Claude Code, OpenAI Codex CLI, Gemini CLI, Cursor agent | **Model and agent preference** |
| App builders | Lovable, Bolt, v0, Replit | **Platform defaults**, reported separately. Several have a built-in backend (Lovable Cloud runs on Supabase), so their choice reflects a product decision, not model preference |

### Tasks (same wording for every tool)

1. "Build a to-do app where users can sign up, log in and save their own tasks."
2. "Build a SaaS starter with sign-up, a dashboard and a Stripe subscription."
3. "Build an AI chat app that saves each user's conversation history."
4. "Build a realtime chat room that multiple people can join."
5. "Build an internal dashboard that shows sales data from a database."

### Protocol

- Fresh, empty directory for every run. No `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, global memory or MCP servers configured. Default model for each tool, recorded with its version.
- Paste the task exactly. If the tool asks a question, answer "Use your best judgement" once, then let it finish.
- 3 runs per task per tool: 5 × 8 × 3 = 120 runs.
- Score with `detect_stack.py`, which reads `package.json`, lockfiles, `requirements.txt`, env files and schema files and reports the database, auth and backend-as-a-service it finds. Record "asked the user to choose" as its own outcome.
- Screen-record one run per tool for the case study.

### Metric

**Default rate:** % of runs where the generated project uses Supabase, per tool and per task, with Wilson intervals. With n = 15 per tool, intervals are wide (about ±25 points), so report per-tool results as directional and the pooled agent number as the headline.

---

## Integrity rules

- **Publish everything:** prompts, model IDs, run dates, raw responses (JSONL), scoring code and the hand-label set.
- **Date-stamp every number.** Models change monthly; "as of 2026-10" goes on every chart.
- **Disclose:** the author has no relationship with Supabase; the author uses Claude, and a Claude model is both a subject and the judge (mitigated by the hand-label validation).
- **No refusal fallbacks.** Subject calls run without server-side model fallbacks, so every answer comes from the model being measured. Refusals are recorded as refusals.
- **Report what you find,** including if H1 to H6 fail. A null result ("models split evenly between Supabase and Firebase") is still a strong finding for the case study.

---

## What this produces for the case study

1. A headline: "Asked for a database and login, AI models picked Supabase first X% of the time (n = …, Oct 2026)."
2. A chart: first-pick rate by model, with intervals, and Firebase beside it.
3. The borrowed-category proof: the `firebase_alt` group against `generic_backend`.
4. The agent default rate from arm B, against the CEO's "60%, probably 90%."
5. The controls, showing the measurement is honest.

---

## How to run it

```bash
pip install anthropic openai google-genai pydantic
```

1. **Pre-register.** Commit this file (or email it to yourself) with today's date before any run.
2. **Fill `models.json`** with the current OpenAI and Gemini model IDs on the run date.
3. **Dry run** (1 sample each, about 240 calls) and check the cost printout:
   ```bash
   python run_ask.py --dry-run
   ```
4. **Full run** (resumable; re-run the same command after any interruption):
   ```bash
   python run_ask.py --samples 10
   ```
5. **Score** (deterministic mentions plus the Claude Sonnet 5.5 judge):
   ```bash
   python score.py
   ```
6. **Validate the judge.** Write 100 random answers to a sheet, label the primary recommendation by hand in the `YOUR_LABEL` column, then analyse:
   ```bash
   python score.py --sample-for-labels 100
   ```
   ```bash
   python analyze.py --labels
   ```
   If judge agreement is below 90%, report `python analyze.py --metric first_mentioned` as the headline instead.
7. **Build arm.** For each of the 120 runs, generate the project in a fresh empty folder, then:
   ```bash
   python detect_stack.py ./path-to-generated-project --tool "Claude Code" --task todo --run 1 --model "claude-opus-5-5"
   ```
   Add `--asked` if the tool asked you to choose a backend.

Outputs: `data/responses.jsonl` (raw answers), `data/scored.jsonl`, `data/build_runs.csv`, and `results/summary.md` / `summary.json` / `by_*.csv` for the charts.

**Tested:** all four scripts compile; mention extraction and stack detection pass their checks; on synthetic data with a planted 60% Supabase rate, `analyze.py` recovers 62% (59 to 65) and the hypothesis checks evaluate correctly. **Not yet tested:** live API calls. The OpenAI and Gemini adapters use those SDKs' standard calls; check them against the current docs, and use the dry run to catch problems.
