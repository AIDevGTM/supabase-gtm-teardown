# Steal Supabase's GTM

A go-to-market case study of Supabase for early-stage dev tool founders, built as a real Postgres database on Supabase.

Every chapter of the page is a table, and every number comes from a query that runs live against this database; the page shows each query's real execution time. There are 12 lessons, each with the evidence, the steps, a target and when not to copy it, plus templates, a stage-based playbook and a pre-registered study of which backends Claude models recommend.

**Read it:** https://steal-supabase-gtm.lovable.app

**Author:** Shane O'Connor, GTM Lead @ QC Growth. Independent analysis, not affiliated with Supabase.

## What's in here

| Path | What it is |
| --- | --- |
| `supabase/migrations/0000_case_queries.sql` | The query runner. `case_queries` holds every SQL block shown on the page, and `run_case_query(id)` runs only those, with a 2-second timeout, returning rows plus execution time |
| `supabase/migrations/0001` … `0010` | One migration per original chapter: schema, Row Level Security policies and data |
| `supabase/migrations/0011` … `0021` | The founder playbook (lessons, diagnostic, stages, templates), the fact-check fixes, the AI study results and copy changes, in the order they were applied |
| `supabase/ALL-MIGRATIONS.sql` | All migrations in one file, for pasting into the Supabase SQL Editor |
| `public/console/case-study.sql` | The bundle the in-browser SQL console loads into PGlite |
| `tools/build_sql.py` | Generates every file above from one source of truth |
| `research/supabase-research.json` | Our own data: daily GitHub star history, launch week lift, every Hacker News story over 100 points that links to or names Supabase, and homepage taglines from the Wayback Machine |
| `research/ai-recommendation-test/` | The pre-registered AI recommendation study: design, pre-registration, 34 prompts, scripts, all 1,020 raw and scored answers, the 15 Claude Code builds and the results ([results/RESULTS.md](research/ai-recommendation-test/results/RESULTS.md)) |

## Run it yourself

1. Create a Supabase project.
2. Run `supabase/ALL-MIGRATIONS.sql` in the SQL Editor.
3. If you want the shared checklist, turn on anonymous sign-ins (Authentication → Sign In / Providers).
4. Query it:

```sql
select extract(year from started)::int as year, round(avg(lift), 1) as avg_lift
from launch_week_star_lift group by 1 order by 1;
```

To regenerate the SQL after editing content, run `python3 tools/build_sql.py`.

## Re-run the AI study

```bash
cd research/ai-recommendation-test
cp .env.example .env   # add your Anthropic API key
python run_ask.py --samples 10
python score.py
python analyze.py
python export_headline.py
```

`run_build_claude.py` repeats the Claude Code build test (it needs Claude Code installed and an API key). The study covers Claude models only, and its judge validation was done by a second blind Claude reader rather than a human. Both points are recorded as amendments and deviations in `PREREGISTRATION.txt`.

## Security model

The browser only ever has the public anon key, and every table has Row Level Security enabled. Content tables are read-only for the public. The page can't send SQL to the server: `run_case_query(id)` only executes statements stored in `case_queries`, which the public can't write to. Checklist ticks belong to an anonymous user and are protected by RLS, with totals returned as counts only. The `subscribers` table accepts inserts and nothing else, so the list can't be read back through the API. The SQL console runs in PGlite in the reader's tab, against a copy, so nothing a reader types reaches the server.

## Sources and caveats

- Usage metrics are company-reported.
- Revenue figures are third-party estimates (Sacra) or the CEO's rough recollection from a public talk.
- Star history comes from OSS Insight (GH Archive), Hacker News data from the Algolia API, and taglines from the Wayback Machine, all collected 17 October 2026.
- Every factual claim on the page was checked against a primary source; the full source list is in the `sources` table.

## License

MIT. Use the method, the code and the data. If you write your own teardown with it, a link back is appreciated.
