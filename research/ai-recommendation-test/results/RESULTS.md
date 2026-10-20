# Results: which backend do Claude models recommend?

Run 17 to 20 October 2026. Pre-registered in [PREREGISTRATION.txt](../PREREGISTRATION.txt) before any model was called, with two recorded amendments: the study covers Claude models only, and build runs execute in a neutrally named folder.

## Arm A: 1,020 answers

There were 34 prompts, each asked 10 times of Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5. Every request used default settings, with no system prompt and no web search. Claude Sonnet 5.5 judged the primary recommendation in each answer. We also report a deterministic count: the first product the answer names (Firebase is skipped on "Firebase alternative" prompts).

| Prompt group | Answers | Supabase first (judge) | Supabase first (first named) | Most common first pick |
| --- | --- | --- | --- | --- |
| Generic backend (database plus login) | 180 | 86% | 83% | Supabase (155) |
| Firebase alternative | 150 | 82% | 77% | Supabase (123) |
| Named stack (Next.js, Vercel, Flutter) | 180 | 43% | 32% | Supabase (77) |
| AI app (chats, embeddings, RAG) | 150 | 19% | 8% | Plain Postgres (91) |
| Realtime (chat, live updates) | 120 | 18% | 17% | Server-Sent Events (23) |
| Postgres hosting | 120 | 13% | 0% | Neon (93) |
| Controls (warehouse, time series, cache, Oracle) | 120 | 0% | 0% | TimescaleDB (29) |

The generic-backend result was consistent across models: Opus 86.7%, Sonnet 86.7%, Haiku 85.0%.

### Hypotheses

| | Hypothesis | Result |
| --- | --- | --- |
| H1 | Generic first pick over 50% for every model | Holds (85 to 87%) |
| H2 | "Firebase alternative" first pick over 80% | Holds on the judge metric (82%, 95% CI 75 to 87); 77% on first-named |
| H3 | AI-app first pick below generic | Holds (19% vs 86%) |
| H4 | Controls under 10% | Holds (0 of 120) |
| H6 | Vendor spread under 15 points | Not tested (Claude only, Amendment 1) |

## Arm B: 15 builds with Claude Code

Claude Code (Opus 5.5) ran in bare mode, with file tools only (no shell, no network), in an empty, neutrally named folder. There were five tasks, three runs each.

| Task | Runs | Storage it chose |
| --- | --- | --- |
| To-do app with sign-up and saved tasks | 3 | SQLite |
| SaaS starter with Stripe subscription | 3 | SQLite (via Prisma) |
| AI chat app that saves history | 3 | SQLite |
| Internal sales dashboard | 3 | SQLite |
| Realtime chat room | 3 | No database: in memory (browser storage in one run) |

None of the 15 runs chose a hosted backend, and none asked a clarifying question. Two realtime runs were classified by hand because the detector found no database; both keep messages in server memory.

## What it means

- Supabase owns the questions it built its name on: generic backend and "Firebase alternative".
- Models file it under the category it borrowed. Asked for Postgres hosting, they pick Neon.
- When the question is about the standard (vectors and AI data), the answer is plain Postgres with pgvector, not Supabase by name.
- An agent that can't sign up for anything uses what runs locally. Being recommended in chat and being chosen in an offline build are different problems.

## Limitations

- **Claude models only.** The results say nothing about GPT, Gemini or other assistants.
- **A Claude model judged Claude answers, and the check was also done by Claude.** The pre-registration called for 100 hand-labelled answers with at least 90% agreement. Instead, two blind second readers (Claude Opus 5.5 subagents that never saw the judge's labels) labelled the same 100 random answers ([data/second_reader_labels.csv](../data/second_reader_labels.csv)). This is a deviation from the protocol: it is not a human check. Results:
  - exact agreement with the judge: 92 of 100, above the 90% bar;
  - agreement on whether the first pick is Supabase: 96 of 100;
  - agreement where the reader was confident: 59 of 59.

  All 8 disagreements are answers that hedge between options. In 4 of them the second reader said Supabase where the judge didn't, so the judge, if anything, undercounts Supabase. A human check of [data/hand_labels.csv](../data/hand_labels.csv) is still open, and the page reports both metrics as a range.
- **Arm B ran without network or shell.** That's a stricter setting than a normal Claude Code session, where an agent could install packages or sign up for services. It measures the default with no accounts, not the best case.
- **Prompts are ours.** The 34 questions are listed in [prompts.json](../prompts.json).

## Cost

The 8 builds run on 20 October cost $9.12, as reported by Claude Code. Token usage for every Arm A answer is recorded in data/responses.jsonl.
