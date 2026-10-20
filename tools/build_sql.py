"""Generate supabase/migrations/*.sql for the Supabase Schema Teardown from one source of truth.

Every chapter of the page is a real table. Every SQL block shown on the page is stored in
public.case_queries and executed by public.run_case_query(id), which returns rows + real execution time.

Run:  python3 tools/build_sql.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
RESEARCH = json.loads((ROOT / "research" / "supabase-research.json").read_text())


def q(v):
    """SQL literal."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def inserts(table, cols, rows):
    vals = ",\n".join("  (" + ", ".join(q(r[i]) for i in range(len(cols))) + ")" for r in rows)
    return f"insert into public.{table} ({', '.join(cols)}) values\n{vals};\n"


def public_read(*tables):
    out = []
    for t in tables:
        out.append(f"alter table public.{t} enable row level security;")
        out.append(f'create policy "Public read" on public.{t} for select to anon, authenticated using (true);')
    return "\n".join(out) + "\n"


def register(rows):
    """rows: (id, chapter, sort, sql, columns, footer_right, chart)"""
    cols = ["id", "chapter", "sort", "sql", "columns", "footer_right", "chart"]
    fixed = [(i, c, s, sql, json.dumps(colspec), fr, json.dumps(chart) if chart else None) for i, c, s, sql, colspec, fr, chart in rows]
    vals = ",\n".join("  (" + ", ".join([q(r[0]), q(r[1]), q(r[2]), q(r[3]), q(r[4]) + "::jsonb", q(r[5]), (q(r[6]) + "::jsonb") if r[6] else "null"]) + ")" for r in fixed)
    return f"insert into public.case_queries ({', '.join(cols)}) values\n{vals};\n"


def C(name, typ, fmt=None, **kw):
    d = {"name": name, "type": typ}
    if fmt:
        d["format"] = fmt
    d.update(kw)
    return d


FILES = {}

# ------------------------------------------------------------------ 0000: the query runner
FILES["0000_case_queries.sql"] = """-- Every SQL block on the page lives here. run_case_query() executes only these stored
-- statements, so the SQL a reader sees is exactly the SQL that ran, and readers can't send their own.

create table public.case_queries (
  id           text primary key,
  chapter      text not null,
  sort         int  not null default 0,
  sql          text not null,
  columns      jsonb not null default '[]',   -- display hints: name, type, format
  footer_right text,
  chart        jsonb                          -- optional: {"bar": "<column>", "max": n}
);
""" + public_read("case_queries") + """
create or replace function public.run_case_query(p_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set statement_timeout = '2s'
as $$
declare
  v_sql  text;
  v_t0   timestamptz;
  v_rows jsonb;
begin
  select sql into v_sql from public.case_queries where id = p_id;
  if v_sql is null then
    raise exception 'unknown case query: %', p_id using errcode = 'P0002';
  end if;
  v_t0 := clock_timestamp();
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', rtrim(v_sql, E'; \\n'))
    into v_rows;
  return jsonb_build_object(
    'id', p_id,
    'rows', v_rows,
    'row_count', jsonb_array_length(v_rows),
    'ms', round((extract(epoch from clock_timestamp() - v_t0) * 1000)::numeric, 3)
  );
end;
$$;

revoke all on function public.run_case_query(text) from public;
grant execute on function public.run_case_query(text) to anon, authenticated;

-- The real columns of the case study's tables, so the page's column strips show the actual schema.
create or replace function public.case_schema()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_object_agg(t.table_name, t.cols), '{}'::jsonb)
  from (
    select c.table_name,
           jsonb_agg(jsonb_build_object(
             'name', c.column_name,
             'type', c.udt_name,
             'pk', exists (
               select 1 from information_schema.key_column_usage k
               join information_schema.table_constraints tc
                 on tc.constraint_name = k.constraint_name and tc.table_schema = k.table_schema
               where tc.constraint_type = 'PRIMARY KEY' and k.table_schema = 'public'
                 and k.table_name = c.table_name and k.column_name = c.column_name),
             'fk', exists (
               select 1 from information_schema.key_column_usage k
               join information_schema.table_constraints tc
                 on tc.constraint_name = k.constraint_name and tc.table_schema = k.table_schema
               where tc.constraint_type = 'FOREIGN KEY' and k.table_schema = 'public'
                 and k.table_name = c.table_name and k.column_name = c.column_name)
           ) order by c.ordinal_position) as cols
    from information_schema.columns c
    where c.table_schema = 'public' and c.table_name <> 'case_queries'
    group by c.table_name
  ) t;
$$;

revoke all on function public.case_schema() from public;
grant execute on function public.case_schema() to anon, authenticated;
"""

# ------------------------------------------------------------------ 0001 origins (+ metrics)
FILES["0001_origins.sql"] = """create table public.metrics (
  as_of               date primary key,
  developers          bigint,
  valuation_usd       numeric,
  databases_per_month bigint,
  agent_share_pct     numeric,
  github_stars        bigint,
  source              text
);

create table public.origins (
  at        date primary key,
  at_label  text not null,
  event     text not null,
  highlight boolean not null default false
);
""" + public_read("metrics", "origins") + "\n" + inserts("metrics", ["as_of", "developers", "valuation_usd", "databases_per_month", "agent_share_pct", "github_stars", "source"], [
    ("2025-10-03", 4000000, 5000000000, None, None, None, "Series E announcement"),
    ("2026-06-04", 9000000, 10500000000, None, None, None, "Series F announcement"),
    ("2026-10-16", 13000000, 10500000000, 4000000, 70, 111659, "Turso announcement; GitHub API"),
]) + "\n" + inserts("origins", ["at", "at_label", "event", "highlight"], [
    ("2019-12-01", "Dec 2019", "Pitches Ant Wilson, met through Entrepreneur First", False),
    ("2020-01-01", "Jan 2020", "Founded; a month of developer interviews", False),
    ("2020-02-01", "Feb 2020", "Start building", False),
    ("2020-05-27", "27 May 2020", "Show HN hits #1 (1,120 points). 522 new GitHub stars that day, still the repo's biggest day ever", True),
    ("2020-07-01", "Summer 2020", "YC S20; COVID makes them fully remote and async", False),
    ("2020-12-15", "Dec 2020", "$6M seed", False),
]) + "\n" + register([
    ("hero_metrics", "hero", 0,
     "select developers, valuation_usd, databases_per_month, agent_share_pct, github_stars\nfrom metrics where as_of = '2026-10-16';",
     [C("developers", "int8", "compact", suffix="+", key=True), C("valuation_usd", "numeric", "usd_compact"), C("databases_per_month", "int8", "compact"), C("agent_share_pct", "numeric", "pct"), C("github_stars", "int8", "compact")],
     "Company-reported; valuation is Series F post-money, Jun 2026", None),
    ("origins_timeline", "origins", 1,
     "select at_label, event, highlight as _hot from origins order by at;",
     [C("at_label", "text", "mono"), C("event", "text")], None, None),
    ("developers_growth", "ai_waves", 3,
     "select as_of, developers from metrics where as_of >= '2025-10-01' order by as_of;",
     [C("as_of", "date", "month_year"), C("developers", "int8", "compact")], "Company-reported", {"bar": "developers"}),
])

# ------------------------------------------------------------------ 0002 taglines
FILES["0002_taglines.sql"] = """create table public.taglines (
  captured       timestamptz primary key,
  captured_label text not null,
  copy           text not null,
  note           text,
  state          text not null default 'normal' check (state in ('normal', 'hot', 'dead')),
  archive_url    text
);
""" + public_read("taglines") + "\n" + inserts("taglines", ["captured", "captured_label", "copy", "note", "state", "archive_url"], [
    ("2020-05-25 09:07:56+00", "25 May 2020", "realtime postgres.", "Sold as an add-on to \"your existing PostgreSQL database\". 8 databases", "dead", "https://web.archive.org/web/20200525090756/https://supabase.io/"),
    ("2020-05-27 07:15:40+00", "27 May 2020 07:15 UTC", "The opensource Firebase alternative.", "Captured an hour after the Show HN went up. Typo and all. 800 databases in 3 days", "hot", "https://web.archive.org/web/20200527071540/https://supabase.io/"),
    ("2020-06-15 04:00:43+00", "15 Jun 2020", "The open source Firebase alternative.", "Typo fixed", "normal", "https://web.archive.org/web/20200615040043/https://supabase.io/"),
    ("2022-07-01 00:00:00+00", "Jul 2022", "Build in a weekend. Scale to millions.", "New headline. Page title still says Firebase", "normal", "https://web.archive.org/web/20220701/https://supabase.com/"),
    ("2025-07-01 01:22:42+00", "Jul 2025", "The Postgres Development Platform.", "Page title finally drops Firebase, five years on", "normal", "https://web.archive.org/web/20250701012242/https://supabase.com/"),
]) + "\n" + register([
    ("taglines_history", "taglines", 1,
     "select captured_label, copy, note, state = 'hot' as _hot, state = 'dead' as _dead\nfrom taglines order by captured;",
     [C("captured_label", "timestamptz", "mono"), C("copy", "text"), C("note", "text")], "Firebase stayed in the page title for 5 years", None),
])

# ------------------------------------------------------------------ 0003 postgres_bet (+ hn)
hn = RESEARCH["hn_100plus"]
FILES["0003_postgres_bet.sql"] = """create table public.onboarding_benchmarks (
  id                int primary key,
  stack             text not null,
  time_to_first_row interval not null,
  source            text
);

create table public.hn_stories (
  hn_id          bigint primary key,
  posted         date not null,
  title          text not null,
  points         int  not null,
  comments       int  not null,
  author         text not null,
  names_supabase boolean not null
);
comment on table public.hn_stories is 'Every Hacker News story with Supabase in the title or link that reached 100+ points, 2020 to Oct 2026 (Algolia API).';
""" + public_read("onboarding_benchmarks", "hn_stories") + "\n" + inserts("onboarding_benchmarks", ["id", "stack", "time_to_first_row", "source"], [
    (1, "AWS RDS: launch, connect, insert a row", "8 minutes 30 seconds", "Paul Copplestone, YC Startup School Paris"),
    (2, "Supabase target, 2020 (under a minute)", "1 minute", "Paul Copplestone, YC Startup School Paris"),
    (3, "Supabase today", "5 seconds", "Paul Copplestone, YC Startup School Paris"),
]) + "\n" + inserts("hn_stories", ["hn_id", "posted", "title", "points", "comments", "author", "names_supabase"],
    [(int(h["id"]), h["date"], h["title"], h["points"], h["comments"], h["author"], h["kind"] == "supabase") for h in hn]
) + "\n" + register([
    ("time_to_first_row", "postgres_bet", 1,
     "select stack, time_to_first_row, id = 3 as _hot\nfrom onboarding_benchmarks order by time_to_first_row desc;",
     [C("stack", "text"), C("time_to_first_row", "interval", "interval_human")], "Source: Paul Copplestone, YC Startup School Paris", {"bar": "time_to_first_row"}),
    ("hn_split", "postgres_bet", 2,
     "select case when names_supabase then 'Names Supabase' else 'About Postgres' end as headline,\n       count(*) as stories, sum(points) as points, not bool_or(names_supabase) as _hot\nfrom hn_stories where points >= 100 group by 1 order by 1;",
     [C("headline", "text"), C("stories", "int8", "big"), C("points", "int8", "thousands")], "Source: Hacker News Algolia API", {"bar": "points"}),
    ("hn_top_postgres", "postgres_bet", 3,
     "select posted, title, points, hn_id as _hn_id\nfrom hn_stories where not names_supabase order by points desc limit 5;",
     [C("posted", "date", "mono"), C("title", "text", "hn_link"), C("points", "int4", "mono")], "Borrowed trust, in data", None),
])

# ------------------------------------------------------------------ 0004 launch weeks
lift = RESEARCH["launch_weeks"]
FILES["0004_launch_weeks.sql"] = """create table public.launch_weeks (
  week      text not null,
  day_index int  not null,
  day       text not null,
  shipped   text not null,
  primary key (week, day_index)
);

create table public.launch_week_star_lift (
  week                 text primary key,
  started              date not null,
  stars_per_day_before numeric not null,
  stars_per_day_during numeric not null,
  lift                 numeric generated always as (round(stars_per_day_during / nullif(stars_per_day_before, 0), 1)) stored
);
comment on table public.launch_week_star_lift is 'New GitHub stars per day during each launch week vs the 4 weeks before it (excluding the week just before). Source: OSS Insight / GH Archive.';
""" + public_read("launch_weeks", "launch_week_star_lift") + "\n" + inserts("launch_weeks", ["week", "day_index", "day", "shipped"], [
    ("2021-03", 1, "Mon", "Pricing, with a generous free plan"),
    ("2021-03", 2, "Tue", "Storage v1"),
    ("2021-03", 3, "Wed", "The CLI: local dev, migrations, self-hosting"),
    ("2021-03", 4, "Thu", "Open source UI library"),
    ("2021-03", 5, "Fri", "One more thing"),
]) + "\n" + inserts("launch_week_star_lift", ["week", "started", "stars_per_day_before", "stars_per_day_during"],
    [(l["name"], l["start"], l["base_per_day"], l["week_per_day"]) for l in lift]
) + "\n" + register([
    ("launch_week_2021", "launch_weeks", 1,
     "select day, shipped from launch_weeks where week = '2021-03' order by day_index;",
     [C("day", "text", "mono"), C("shipped", "text")], None, None),
    ("launch_week_lift", "launch_weeks", 2,
     "select week, started, lift, lift >= 2 as _hot\nfrom launch_week_star_lift order by started;",
     [C("week", "text", "mono"), C("started", "date", "mono"), C("lift", "numeric", "multiplier")], "Source: OSS Insight (GH Archive)", {"bar": "lift", "max": 5}),
])

# ------------------------------------------------------------------ 0005 sales motion (+ revenue)
FILES["0005_sales_motion.sql"] = """create table public.sales_motion (
  cohort     text primary key,
  qoq_growth numeric not null,
  source     text
);

create table public.revenue (
  sort    int  primary key,
  period  text not null,
  arr_usd numeric not null,
  source  text not null
);
""" + public_read("sales_motion", "revenue") + "\n" + inserts("sales_motion", ["cohort", "qoq_growth", "source"], [
    ("PLG account, left alone", 25, "First Round Review"),
    ("PLG account, spoke to a rep", 125, "First Round Review"),
]) + "\n" + inserts("revenue", ["sort", "period", "arr_usd", "source"], [
    (1, "First ~18 months", 0, "Paul Copplestone, YC Startup School Paris"),
    (2, "End of first revenue year", 1000000, "Paul Copplestone, YC Startup School Paris (approximate)"),
    (3, "Year after", 7500000, "Paul Copplestone, YC Startup School Paris (approximate)"),
    (4, "May 2026", 170000000, "Sacra estimate"),
]) + "\n" + register([
    ("sales_cohorts", "sales_motion", 1,
     "select cohort, avg(qoq_growth) as qoq_growth from sales_motion group by cohort order by 2;",
     [C("cohort", "text"), C("qoq_growth", "numeric", "pct_big")], "Source: First Round Review", {"bar": "qoq_growth"}),
    ("revenue", "sales_motion", 2,
     "select period, arr_usd from revenue order by sort;",
     [C("period", "text", "mono"), C("arr_usd", "numeric", "usd_compact")], "Early years: Copplestone, YC talk. 2026: Sacra estimate", {"bar": "arr_usd"}),
])

# ------------------------------------------------------------------ 0006 ai waves
FILES["0006_ai_waves.sql"] = """create table public.ai_waves (
  id     int primary key,
  wave   text not null,
  period text not null,
  driver text not null
);

create table public.developer_experience (
  id                int primary key,
  era               text not null,
  primary_interface text not null
);
""" + public_read("ai_waves", "developer_experience") + "\n" + inserts("ai_waves", ["id", "wave", "period", "driver"], [
    (1, "Vectors", "2023", "Early pgvector support kept AI embeddings in the same Postgres as everything else."),
    (2, "App builders", "Late 2024 to 2025", "Bolt.new and Lovable made Supabase their default backend. Database creation spiked like a DDoS."),
    (3, "Coding agents", "2026", "Claude Code, Codex and others create databases straight from the CLI and MCP. Claude Code is the largest single source."),
]) + "\n" + inserts("developer_experience", ["id", "era", "primary_interface"], [
    (1, "Humans, 2020", "A click-around dashboard, built for discovery"),
    (2, "LLMs", "Dashboard stripped back to a SQL editor and a chat box"),
    (3, "Agents, now", "CLI and MCP. Declarative schemas in Git, every environment branchable"),
]) + "\n" + register([
    ("ai_waves", "ai_waves", 1,
     "select wave, period, driver, id = 3 as _hot from ai_waves order by id;",
     [C("wave", "text", "bold"), C("period", "text", "mono"), C("driver", "text")], None, None),
    ("developer_experience", "ai_waves", 4,
     "select era, primary_interface, id = 3 as _hot from developer_experience order by id;",
     [C("era", "text", "bold"), C("primary_interface", "text")], "Agents don't care about dashboards", None),
])

# ------------------------------------------------------------------ 0007 rounds
FILES["0007_rounds.sql"] = """create table public.rounds (
  closed        date primary key,
  closed_label  text not null,
  round         text not null,
  amount_usd    numeric not null,
  valuation_usd numeric,
  lead          text,
  note          text
);
comment on column public.rounds.valuation_usd is 'Post-money; null where not disclosed.';
""" + public_read("rounds") + "\n" + inserts("rounds", ["closed", "closed_label", "round", "amount_usd", "valuation_usd", "lead", "note"], [
    ("2026-10-02", "Oct 2026", "Growth + Turso", 150000000, None, "GIC", None),
    ("2026-06-04", "Jun 2026", "Series F", 500000000, 10500000000, "GIC", None),
    ("2025-10-03", "Oct 2025", "Series E", 100000000, 5000000000, "Accel, Peak XV", None),
    ("2025-04-22", "Apr 2025", "Series D", 200000000, 2000000000, "Accel", None),
    ("2024-09-01", "~Sep 2024", "Series C", 80000000, None, "Peak XV, Craft", "Date inferred: reported as seven months before the Series D"),
    ("2022-05-10", "May 2022", "Series B", 80000000, None, "Felicis", None),
    ("2021-09-01", "Sep 2021", "Series A", 30000000, None, "Coatue", None),
    ("2020-12-15", "Dec 2020", "Seed", 6000000, None, "Coatue", "Per Paul Copplestone, YC Startup School Paris"),
]) + "\n" + register([
    ("rounds", "rounds", 1,
     "select closed_label, round, amount_usd, valuation_usd, lead, closed >= '2026-01-01' as _hot\nfrom rounds order by closed desc;",
     [C("closed_label", "date", "mono"), C("round", "text"), C("amount_usd", "numeric", "usd_compact"), C("valuation_usd", "numeric", "usd_compact", null="n/d"), C("lead", "text")],
     "Series C date inferred", {"bar": "valuation_usd"}),
])

# ------------------------------------------------------------------ 0008 known issues
FILES["0008_known_issues.sql"] = """create table public.known_issues (
  id       int primary key,
  severity text not null default 'warning',
  title    text not null,
  detail   text not null,
  hint     text
);
""" + public_read("known_issues") + "\n" + inserts("known_issues", ["id", "title", "detail", "hint"], [
    (1, "insecure defaults in AI-built apps", "In 2025 a researcher scanned 1,645 Lovable showcase apps and found about 170 with Supabase tables open to anyone holding the public key, because Row Level Security was never switched on (CVE-2025-48757). The flaw was in how apps were generated, but anyone who can ship a backend can ship an open one. On Hacker News, \"Supabase MCP can leak your entire SQL database\" (July 2025) drew 848 points and 470 comments, more discussion than almost anything Supabase posted itself.", "HINT: enable RLS on every table. Yes, every one."),
    (2, "concentration risk", "If agents create most new databases and one agent is the biggest source, growth depends on another company's roadmap. App builders are launching their own backends: Bolt Cloud, Replit, Lovable Cloud (which runs on Supabase today).", None),
    (3, "free databases are not revenue", "Millions of agent-created databases are free and short-lived. The business depends on converting a small slice into paid production workloads.", None),
    (4, "developer experience gaps", "Drift between local and hosted environments, migrations, auth edge cases, and no long-running client transactions, which pushes logic into database functions.", None),
    (5, "becoming the default is partly luck", "Copplestone's own view: if agents settle on two or three defaults per category, most dev tools won't be one of them, and you can't plan for that. You do the fundamentals for word of mouth and ease of use, and hope. Against AWS, the last advantage may simply be the vibes.", "HINT: he's not joking about the vibes."),
])

# ------------------------------------------------------------------ 0009 principles (+ ticks)
FILES["0009_principles.sql"] = """create table public.principles (
  id    int primary key,
  title text not null,
  body  text not null,
  how   text not null
);

-- One row per reader per principle. Readers sign in anonymously; RLS lets each reader see,
-- add and remove only their own ticks. Totals come from the principle_counts case query
-- (aggregates only), so nobody can see who ticked what.
create table public.principle_ticks (
  principle_id int  not null references public.principles (id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (principle_id, user_id)
);
""" + public_read("principles") + """
alter table public.principle_ticks enable row level security;
create policy "Readers see their own ticks" on public.principle_ticks
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Readers add their own ticks" on public.principle_ticks
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Readers remove their own ticks" on public.principle_ticks
  for delete to authenticated using (user_id = (select auth.uid()));
""" + "\n" + inserts("principles", ["id", "title", "body", "how"], [
    (1, "Test positioning like a feature", "Same product: 8 databases with one tagline, 800 with another.", "Write three taglines, test each with real developers, keep the one that drives signups."),
    (2, "Borrow a category", "\"X alternative\" is clarity, not weakness.", "Name the tool your ICP already uses and say what you fix about it."),
    (3, "Own day zero", "Get chosen when the project starts. Build the scale story behind it.", "Time your onboarding against the incumbent with a stopwatch. Supabase went from 8.5 minutes to 5 seconds and never advertised it."),
    (4, "Make leaving easy", "Open standards and portability lower the fear of trying you.", "Document the exit as clearly as the entrance."),
    (5, "Make shipping an event", "Launch weeks turned releases into roughly 20% growth bumps.", "Batch a quarter's releases into one named week. Expect it to win attention early; at scale it serves the users you already have."),
    (6, "Mean it on open source", "Permissive licenses, no tracking, maintainers on payroll.", "Don't open source a crippled core as a lead magnet. Developers can tell."),
    (7, "Free until it's real", "Charge when the app has users, not while the developer is exploring.", "Put the paid line at production usage and keep pricing predictable."),
    (8, "Sales as support", "Usage-triggered help turned 25% growth into 125%.", "Trigger on limits, errors and spikes. Pay reps on uplift against a control group."),
    (9, "Be legible to AI", "The LLMs slurped up Supabase's Reddit threads, GitHub discussions and docs.", "Clean docs, llms.txt, an MCP server, a CLI agents can drive."),
    (10, "Stay frugal longer", "Money won't solve your problems. Supabase exists despite AWS having far more cash.", "Before every hire, name the problem that's burning without it."),
]) + "\n" + register([
    ("principle_counts", "principles", 1,
     "select principle_id, count(*) as shipped from principle_ticks group by principle_id order by principle_id;",
     [C("principle_id", "int4"), C("shipped", "int8")], None, None),
])

# ------------------------------------------------------------------ 0010 sources + faq
FILES["0010_seed_sources.sql"] = """create table public.sources (
  n     int primary key,
  label text not null,
  href  text not null
);

create table public.faq (
  n int primary key,
  q text not null,
  a text not null
);
""" + public_read("sources", "faq") + "\n" + inserts("sources", ["n", "label", "href"], [
    (1, "Contrary Research: Supabase", "https://research.contrary.com/company/supabase"),
    (2, "First Round Review: Paul Copplestone", "https://review.firstround.com/how-supabase-became-the-essential-infrastructure-for-the-ai-era-paul-copplestone-co-founder-ceo/"),
    (3, "Hacker News: Show HN, May 2020", "https://news.ycombinator.com/item?id=23319901"),
    (4, "Supabase blog: Launch Week, March 2021", "https://supabase.com/blog/2021/03/25/launch-week"),
    (5, "github.com/supabase/supabase", "https://github.com/supabase/supabase"),
    (6, "Fortune: Series D", "https://www.fortune.com/2025/04/22/exclusive-supabase-raises-200-million-series-d-at-2-billion-valuation"),
    (7, "BigDATAwire: Series C context", "https://www.bigdatawire.com/2025/04/24/supabases-200m-raise-signals-big-ambitions"),
    (8, "PR Newswire: Series E", "https://www.prnewswire.com/news-releases/supabase-raises-100m-at-5b-valuation-co-led-by-accel-and-peak-xv-302573153.html"),
    (9, "PR Newswire: Series F", "https://www.prnewswire.com/news-releases/supabase-raises-500m-at-10-5b-to-accelerate-lead-in-agentic-infrastructure-302791787.html"),
    (10, "CNBC: $10.5B valuation", "https://www.cnbc.com/2026/06/04/database-startup-supabase-raises-500-million-10point5-billion-valuation.html"),
    (11, "Verdict: $150M and Turso", "https://www.verdict.co.uk/supabase-150m-funding-turso-acquisition/"),
    (12, "Sacra: revenue estimates", "https://sacra.com/c/supabase/"),
    (13, "CVE-2025-48757", "https://cvemon.intruder.io/cves/CVE-2025-48757"),
    (14, "YC Startup School Paris: Paul Copplestone", "https://www.ycombinator.com/library/ax-how-supabase-became-one-of-the-fastest-growing-devtool-companies-in-the-world"),
    (15, "OSS Insight: supabase/supabase star history", "https://ossinsight.io/analyze/supabase/supabase"),
    (16, "Hacker News search API (Algolia)", "https://hn.algolia.com/api"),
    (17, "Wayback Machine: supabase.io, 2020", "https://web.archive.org/web/2020*/supabase.io"),
    (18, "Supabase blog RSS (launch week dates)", "https://supabase.com/rss.xml"),
]) + "\n" + inserts("faq", ["n", "q", "a"], [
    (1, "How did Supabase grow so fast?", "Three compounding moves. A five-word positioning change, \"the open source Firebase alternative\", took databases from 8 to 800 in three days. Relentless shipping, packaged as Launch Weeks, added roughly 20% growth each time. Then AI app builders and coding agents adopted Supabase as their default backend, and agents now launch most new databases on the platform."),
    (2, "Should my dev tool position itself as an alternative to a bigger competitor?", "If developers already know the incumbent and dislike something specific about it, yes. \"X alternative\" borrows a category people already understand and names the reason to switch in the same breath. Supabase later outgrew the comparison and became \"the Postgres development platform\". Treat your tagline as an experiment, not a brand asset."),
    (3, "How did Supabase grow without a marketing budget?", "The product did the marketing. They timed the incumbent (about 8.5 minutes from a new AWS database to a first row) and got Supabase to about 5 seconds. They polled developers constantly on Hacker News, Reddit and Twitter, and turned releases into Launch Weeks. Copplestone would rather give a developer a free database than spend the money on ads."),
    (4, "Does going fully open source hurt revenue?", "Not for Supabase. Almost everything can be self-hosted for free; the only closed code is what it takes to run a million databases, which is tangled up with billing. Customers pay for hosting, scale and not being on call. Revenue took about 18 months to start, reached roughly $1M ARR, then $7.5M the year after."),
    (5, "Why do AI coding tools default to Supabase?", "One setup step gives a full Postgres database with auth, APIs and storage, and years of Reddit threads, GitHub discussions and docs meant models already knew it well. Supabase then built for that traffic: Supabase for Platforms for app builders, and a CLI and MCP server for agents. About 70% of new databases are now created by agents or AI tools."),
    (6, "How do I get AI agents to recommend my dev tool?", "There's no trick, and Supabase's CEO admits part of it is luck: agents may settle on two or three defaults per category. What you control: get to value fast with minimal input, make the product fully operable from a CLI and MCP, publish clean docs, and build a community whose questions and answers end up in training data."),
    (7, "Can a startup really compete with AWS?", "Supabase's CEO puts it bluntly: \"We should not exist if AWS are so good.\" AWS had far more cash, but cash wasn't the deciding factor. Developer experience, open source trust and community were. By Copplestone's estimate, AWS still takes minutes to get a new database to a first row; Supabase takes seconds."),
    (8, "What should a dev-tool founder copy first?", "Time your onboarding against your main competitor with a stopwatch, then cut it until you're an order of magnitude faster. It's cheap, it compounds, and Supabase never even advertised theirs. Second: batch your next quarter's releases into one named launch week, with one post and one demo a day."),
])

# ------------------------------------------------------------------ 0011 founder playbook
# The founder-facing layer: each chapter closes with a "Run this on your company" block read from
# public.lessons. lessons.id = principles.id, so the shared checklist (principle_ticks) carries over.
# Plain text and int columns only (steps are newline-separated) so the PGlite console can copy them.
LESSONS = [
    # id, chapter, stage, title, move, evidence_query, evidence, mechanism, steps, metric, dont_copy_if
    (1, "taglines", "pre-launch", "Test positioning like a feature",
     "Supabase changed one line of homepage copy two days before the Show HN, from \"realtime postgres.\" to \"The opensource Firebase alternative.\" Same product.",
     "taglines_history",
     "8 databases in the weeks under the old line, 800 in the three days after the new one. Firebase stayed in the page title for five years.",
     "The first line was a feature attached to a technology. The second named a tool the reader already used and a reason to switch. Four words moved it from feature differentiation to a specific segment: people who like Firebase but fear lock-in.",
     "Write three one-line positionings: a feature line, a category line (\"the open source X alternative\") and a problem line.\n"
     "Put each in front of 10 developers who match your ideal customer. Ask only: \"What do you think this does, and who's it for?\" Count correct answers.\n"
     "Ship the winner to your homepage for two weeks, then the runner-up for two weeks. Compare signups per unique visitor.\n"
     "Keep the losing lines in a file. Positioning is a backlog, not a decision.",
     "Signup rate per unique visitor (homepage to account created).",
     "You change the line every week. Supabase kept one line for years once it worked. Testing is for finding the line, not for avoiding commitment."),
    (2, "taglines", "pre-launch", "Borrow a category before you build one",
     "\"Firebase alternative\" borrowed a category developers already understood instead of inventing one.",
     "taglines_history",
     "Five years later, Claude still names Supabase first in about 80% of \"Firebase alternative\" answers (our AI study).",
     "A new category costs you a paragraph of education per reader. A borrowed one costs two words. Early on, clarity beats differentiation: nobody can prefer what they can't classify.",
     "Finish the sentence \"We're the ____ alternative\" with a tool your ideal customers know. If none fits, try \"____ for ____\": an incumbent plus a segment it ignores.\n"
     "Add one reason to switch that hits the incumbent's known weakness (Supabase: lock-in).\n"
     "Build an honest \"You vs Incumbent\" page that admits where the incumbent wins. It earns trust and ranks for the exact search people type.\n"
     "Plan your exit from the borrowed category. Supabase moved to \"Build in a weekend. Scale to millions.\" in 2022 and \"The Postgres Development Platform.\" in 2025.",
     "Share of signups from comparison or \"alternative\" searches.",
     "The incumbent is loved and has no obvious weakness. \"Alternative\" only pulls people who already want to leave."),
    (3, "postgres_bet", "pre-launch", "Own day zero",
     "Get chosen when the project starts, then never give the project a reason to leave.",
     "time_to_first_row",
     "AWS RDS: 8.5 minutes to launch, connect and insert a row. Supabase's 2020 target: under a minute. Today: 5 seconds.",
     "Developers pick a backend once per project, in the first hour. Whoever wins that hour wins the customer for years. Supabase didn't need to win the scale argument on day one, only to not lose it later, which is what the Postgres choice guaranteed.",
     "Stopwatch audit: three people who have never used your product, screen recorded, from your homepage to the first moment of real value. Do the same for your top competitor.\n"
     "Log every step: each click, form field, email verification, docs page and error. Mark each one remove, defer or keep.\n"
     "Defer everything that isn't needed for first value: credit card, team setup, SSO, onboarding surveys.\n"
     "Set a target in seconds or minutes, put it on the wall, and re-run the stopwatch every month.",
     "Median time to first value for new signups, and the share who reach it in their first session.",
     "Your value genuinely needs integration work (a scanner on a real codebase, observability on production traffic). Then shrink time to first proof instead: a demo dataset, a sandbox, a sample repo."),
    (4, "postgres_bet", "launch", "Build on something you don't own",
     "Supabase bet on Postgres instead of building its own database, and made leaving easy: it's just Postgres, take your data and go.",
     "hn_split",
     "Of the 61 Hacker News stories over 100 points that link to or name Supabase, 29 (almost half) never say Supabase in the headline. They're about Postgres.",
     "Nobody owns Postgres, so everyone improves it, and every hyperscaler has to offer a good one: Supabase gets a better engine every year for free. Portability lowers the fear of trying. Content about the standard reaches people who would never click a vendor post.",
     "Name the open standard under or next to your product. If there isn't one, name the open format your users' data lives in.\n"
     "Write the exit doc, \"How to leave us\", as clearly as your quickstart. Link it from pricing.\n"
     "Plan 10 posts that teach the standard itself, with your product in the last paragraph or not at all.\n"
     "Contribute upstream, visibly. One merged PR to the standard is worth ten posts about your product.",
     "Share of content traffic from posts that don't name your product, and the signups they drive.",
     "Your moat is the proprietary format. Then portability is a giveaway: borrow trust another way (compliance, benchmarks, named customers)."),
    (5, "launch_weeks", "launch", "Make shipping an event, while it still works",
     "Batch a quarter's releases into one named Launch Week, one launch a day.",
     "launch_week_fade",
     "Average star lift per launch week fell every year: 3.8x in 2021, then 2.0x, 1.5x, 1.2x, and 1.0x in 2025.",
     "Five launches in five days gives the community a reason to look every morning and gives newsletter writers a story instead of a changelog line. Early on, attention is the scarce resource and the format concentrates it. At scale it stops acquiring and becomes a ritual for existing users.",
     "Keep a running list of everything you ship. At quarter end, pick the five best. If you can't find five, run a launch day.\n"
     "One item per day: a post, a demo under 60 seconds, and docs live before the post goes out.\n"
     "Pre-brief 10 friendly developers and 3 newsletter writers a week ahead.\n"
     "Measure lift against your own baseline (the 28 days before). Change the format when lift drops below 1.5x twice running.",
     "Signups per day during the week divided by the daily average of the prior 28 days.",
     "You ship once a quarter anyway, or your launches are invisible to users. Five weak launches teach your audience to ignore you."),
    (6, "origins", "launch", "Mean it on open source",
     "Permissive licenses, no telemetry tricks, maintainers of the tools they depend on on payroll.",
     "origins_timeline",
     "The Show HN on 27 May 2020 drove 522 stars in a day, still the repo's best day. 111K+ stars now.",
     "Developers trust code they can read and self-host. That trust is what lets a four-person company get adopted by teams that would never buy from a startup.",
     "Decide what's open by one rule: is the open part useful on its own? If it's a crippled demo of the paid product, keep it closed. Developers will find out.\n"
     "Charge for operations (hosting, scale, compliance, support), not for features ripped out of the core.\n"
     "Make self-hosting documented and boring. Most people who can self-host won't, and those who do become your loudest advocates.",
     "Outside contributors per month, and self-host to cloud conversions.",
     "Open source isn't table stakes in your category. It's a distribution and trust strategy, not a moral requirement, and it costs real support time."),
    (7, "sales_motion", "early-revenue", "Free until it's real",
     "A generous free tier, with pricing that starts when the app has users, not while the developer is exploring.",
     "revenue",
     "Roughly $0 for the first 18 months, about $1M ARR by the end of the first revenue year, about $7.5M the year after.",
     "Developers explore with side projects. Charging during exploration kills adoption; charging at production captures value when the user has budget and a reason to pay.",
     "Find your production signal: the usage pattern that means \"this is real\" (traffic, team size, uptime needs, data volume).\n"
     "Put your first paid line just past it. Everything before it is free.\n"
     "Make the bill predictable: caps, spend alerts, no surprise invoices. One surprise bill on Hacker News costs more than a year of upgrades.\n"
     "List the free projects that cross the production signal and don't upgrade. That's your sales pipeline.",
     "Free to paid conversion among projects past the production signal (not among all signups).",
     "You can't afford 18 months of free-tier infrastructure. Supabase could because an idle database cost it almost nothing. Do the maths before copying the generosity."),
    (8, "sales_motion", "early-revenue", "Sales as support",
     "Reps reach out when usage says the customer needs help (limits, errors, spikes), not when a lead score says they might buy.",
     "sales_cohorts",
     "Product-led accounts left alone grew 25% quarter on quarter. Accounts that spoke to a rep grew 125%.",
     "The message lands at the moment the developer has a problem, so it reads as help, not a pitch. Reps were measured on uplift against accounts nobody contacted, so they couldn't claim growth that would have happened anyway.",
     "Pick three triggers: near a plan limit, an error spike, usage doubling week on week.\n"
     "When one fires, a founder sends a plain-text note: what you noticed, one specific suggestion, an offer to talk. No deck.\n"
     "Hold back a random 20% of triggered accounts as a control group. Compare 90-day expansion.\n"
     "Hire a rep only once the founder-run version beats the control. Pay them on that lift.",
     "90-day expansion of contacted accounts vs the control group.",
     "Fewer than about 50 accounts hit a trigger each month. Then just talk to all of them: a control group that small tells you nothing."),
    (9, "ai_waves", "scale", "Be legible to AI",
     "Supabase became the default backend for AI app builders and coding agents, which now create most of its new databases.",
     "ai_waves",
     "In our study, Claude names Supabase first in about 90% of generic \"database plus login\" answers, and in 0 of 124 control prompts.",
     "Years of public Reddit threads, GitHub discussions and clear docs became training data. Then Supabase built for agents directly: a CLI and MCP server an agent can drive, and declarative schemas in Git.",
     "Ask three AI models the question your ideal customer would ask, 10 times each. Count how often you're named, and first. That's your baseline (our prompts and scripts are open source).\n"
     "Publish llms.txt and make docs readable as plain text, one concept per page.\n"
     "Make the product drivable without a browser: a CLI with clear errors, an OpenAPI spec, an MCP server if agents would use it.\n"
     "Answer questions in public (GitHub discussions, Stack Overflow, Reddit), not only in a Discord no model will ever read.\n"
     "Re-run the baseline every quarter.",
     "Share of AI answers that name you first, across your 10 most important prompts.",
     "You think it's a trick. Models recommend what the public internet already recommends. This is the teach-the-standard strategy with a new reader."),
    (10, "rounds", "always", "Stay frugal longer",
     "Supabase raised a $6M seed and stayed small and remote. Copplestone's rule: money doesn't solve your problems.",
     "rounds",
     "A month of developer interviews before writing code (January 2020), and a team kept small through the first revenue years.",
     "A small team keeps the founders close to users, which is where every other lesson came from.",
     "Before every hire, write one sentence: \"This is burning, and it will keep burning without this person.\" If you can't, don't hire.\n"
     "Fix founder hours on user calls each week (start with five), however big you get.\n"
     "Pick investors whose interest grows as you do.",
     "Month-3 retention: of developers active in their first month, how many are still active in month 3?",
     "A competitor is buying the category and the window is closing. Frugality is a default, not a religion."),
]

DIAGNOSTIC = [
    # n, question, why, lesson_id (read its "don't copy if" first when the answer is no)
    (1, "Is there an incumbent your buyer already knows by name?", "\"X alternative\" only works if X is famous.", 2),
    (2, "Can a developer get value in under 10 minutes without talking to you?", "Winning day zero needs self-serve.", 3),
    (3, "Is your product built on an open standard you don't own?", "You can borrow its trust and offer portability.", 4),
    (4, "Does usage grow on its own once a project succeeds?", "Free-until-production pricing needs usage that compounds.", 7),
    (5, "Do you ship something users notice at least monthly?", "Launch weeks need a backlog worth batching.", 5),
    (6, "Is your core genuinely useful as open source, or could it be?", "Open source as a lead magnet gets punished.", 6),
    (7, "Would an AI coding agent ever need to pick a tool in your category?", "AI legibility is a channel, not a nice-to-have.", 9),
    (8, "Does the developer make the decision, not procurement?", "Bottom-up only works if the user holds the pen.", 8),
]

DIAGNOSTIC_BANDS = [
    # min_score, max_score, verdict, advice
    (6, 8, "Supabase-shaped", "Most lessons apply nearly as written. Start with your stage in the playbook below."),
    (3, 5, "Partly Supabase-shaped", "Take the mechanisms, change the tactics. Read the \"Don't copy this if\" line of every lesson you answered no to."),
    (0, 2, "Not Supabase-shaped", "You're probably sales-led or selling infrastructure to enterprises. Read lessons 1, 3, 8 and 10 and skip the rest."),
]

STAGES = [
    # sort, stage, period, supabase, you, lessons
    (1, "Pre-launch", "Dec 2019 to May 2020", "A month of developer interviews, then building. Tested the tagline before the Show HN.", "Interview 20 developers before writing code. Run the tagline test. Run the stopwatch on the incumbent.", "1, 2, 3"),
    (2, "Launch to first traction", "May 2020 to 2021", "Show HN #1, YC S20, $6M seed, first launch week.", "One big launch moment built around the borrowed category. Teach the standard. Start a launch cadence.", "2, 4, 5, 6"),
    (3, "Early revenue", "2021 to 2023", "Free until production, usage-triggered sales, launch weeks at peak lift.", "Find your production signal. Run founder-led triggered outreach with a control group.", "7, 8"),
    (4, "Scale", "2023 onward", "pgvector, AI app builders, coding agents. Launch weeks turn into retention.", "Measure your AI visibility, build for agents, check which rituals still acquire users.", "5, 9"),
    (5, "Always", "Every stage", "Small team, founders close to users.", "Retention is the north star until it holds.", "10"),
]

DONT_COPY = [
    (1, "The luck", "Copplestone says it himself: if agents settle on two or three defaults per category, most tools won't be one of them, and you can't plan for that. Do the fundamentals; don't build a plan that needs lightning to strike."),
    (2, "The insecure defaults", "About 170 of 1,645 AI-built apps had tables open to the world because RLS was never switched on. Speed to value without safe defaults becomes someone else's breach and your headline. Make the safe path the fast path."),
    (3, "Concentration risk", "If one partner sends most of your users, your growth sits on their roadmap. App builders are now launching their own backends."),
    (4, "Free usage as revenue", "Millions of free agent-created databases are a vanity number until a slice converts."),
    (5, "Launch weeks forever", "Measure the lift, and change the format when it stops working. Supabase's fell every year."),
]

TEMPLATES = [
    ("tagline_test", 1, "Tagline test", "1 week", """# Tagline test (1 week)

| Line | Type | 10 devs: described correctly | Signups per unique visitor (2 weeks live) |
| --- | --- | --- | --- |
| | Feature | /10 | |
| | Category ("X alternative") | /10 | |
| | Problem | /10 | |

Ask: "What do you think this does, and who's it for?" Don't explain. Don't defend.
"""),
    ("stopwatch_audit", 3, "Stopwatch onboarding audit", "Half a day", """# Stopwatch onboarding audit (half a day)

| Step | Seconds | Needed for first value? | Remove / defer / keep |
| --- | --- | --- | --- |
| Land on homepage | | | |
| Sign up | | | |
| ... | | | |
| **First value** | **total** | | |

Run it for your product and your top competitor. Same tester, same machine. Supabase's benchmark: 8.5 minutes on AWS RDS, 5 seconds on Supabase.
"""),
    ("launch_week", 5, "Launch week planner", "1 quarter", """# Launch week planner

| Day | What ships | Post | Demo (60s) | Docs live | Who's briefed |
| --- | --- | --- | --- | --- | --- |
| Mon | The biggest thing | | | | |
| Tue | | | | | |
| Wed | Something for the community (OSS, free) | | | | |
| Thu | | | | | |
| Fri | One more thing | | | | |

Baseline: signups per day for the prior 28 days = ____
Lift = average signups per day during the week / baseline. Change the format when lift drops below 1.5x twice running.
"""),
    ("teach_the_standard", 4, "Teach the standard: 10 posts", "1 quarter", """# Teach the standard: 10 posts

Ten posts about the open standard your product sits on, widest audience first:

1. The thing most people get wrong about [standard]
2. [Standard] vs [alternative]: an honest comparison
3. How [standard] actually works under the hood
4. 5 features of [standard] nobody uses
5. How we'd set up [standard] for a team of 5
6. Performance: what we measured
7. Security defaults you should change today
8. [Standard] in production: a user's story (they're the hero)
9. Where [standard] is going next
10. Why we built on [standard] (the only post about you)
"""),
    ("triggered_outreach", 8, "Usage-triggered outreach", "Ongoing", """# Usage-triggered outreach

| Trigger | Threshold | Message (plain text, from a founder) | Control group |
| --- | --- | --- | --- |
| Near plan limit | 80% of limit | "Noticed you're close to the X limit. Here's how teams your size usually handle it..." | 20% random |
| Error spike | 3x baseline in 24h | "Saw a jump in Y errors on your project. Looks like Z; here's the fix..." | 20% random |
| Usage doubling | 2x week on week | "Your usage doubled this week. Anything we can unblock?" | 20% random |

Report monthly: 90-day expansion, contacted vs control.
"""),
    ("ai_legibility", 9, "AI legibility checklist", "1 day, then quarterly", """# AI legibility checklist

- [ ] Baseline: 10 prompts your ideal customer would ask x 3 models x 10 runs. How often are you named first?
- [ ] llms.txt at your docs root
- [ ] Docs readable as plain text, one concept per page, code examples that run
- [ ] CLI with clear errors and non-interactive flags
- [ ] OpenAPI spec published
- [ ] MCP server (if agents would use your product)
- [ ] Support answers in public places, not only Discord
- [ ] Safe defaults when an agent sets you up with zero configuration
- [ ] Re-run the baseline quarterly
"""),
]

FILES["0011_playbook.sql"] = """create table public.lessons (
  id              int primary key references public.principles (id),
  chapter         text not null,   -- the page chapter this lesson closes
  stage           text not null check (stage in ('pre-launch', 'launch', 'early-revenue', 'scale', 'always')),
  title           text not null,
  move            text not null,
  evidence_query  text references public.case_queries (id),
  evidence        text not null,
  mechanism       text not null,
  steps           text not null,   -- one step per line
  metric          text not null,
  dont_copy_if    text not null
);

create table public.diagnostic_questions (
  n         int primary key,
  question  text not null,
  why       text not null,
  lesson_id int not null references public.lessons (id)   -- answered no: read this lesson's dont_copy_if first
);

create table public.diagnostic_bands (
  min_score int primary key,
  max_score int not null,
  verdict   text not null,
  advice    text not null
);

create table public.stage_playbook (
  sort     int primary key,
  stage    text not null,
  period   text not null,
  supabase text not null,
  you      text not null,
  lessons  text not null   -- lesson ids, comma separated
);

create table public.dont_copy (
  n     int primary key,
  title text not null,
  body  text not null
);

create table public.templates (
  id        text primary key,
  lesson_id int references public.lessons (id),
  title     text not null,
  takes     text not null,
  body_md   text not null
);
""" + public_read("lessons", "diagnostic_questions", "diagnostic_bands", "stage_playbook", "dont_copy", "templates") + "\n" + register([
    ("launch_week_fade", "launch_weeks", 0,
     "select extract(year from started)::int as year, count(*) as weeks, round(avg(lift), 1) as avg_lift,\n       extract(year from started)::int = 2021 as _hot\nfrom launch_week_star_lift group by 1, 4 order by 1;",
     [C("year", "int4", "mono"), C("weeks", "int8", "mono"), C("avg_lift", "numeric", "multiplier", key=True)], "Same data, grouped by year. Source: OSS Insight (GH Archive)", {"bar": "avg_lift", "max": 5}),
    ("lessons_index", "principles", 0,
     "select id, title, stage, metric from lessons order by id;",
     [C("id", "int4", "mono"), C("title", "text", "bold"), C("stage", "text", "mono"), C("metric", "text")], None, None),
    ("stage_playbook", "stages", 1,
     "select stage, period, you, lessons from stage_playbook order by sort;",
     [C("stage", "text", "bold"), C("period", "text", "mono"), C("you", "text"), C("lessons", "text", "mono")], None, None),
]) + "\n" + inserts("lessons", ["id", "chapter", "stage", "title", "move", "evidence_query", "evidence", "mechanism", "steps", "metric", "dont_copy_if"], LESSONS) \
  + "\n" + inserts("diagnostic_questions", ["n", "question", "why", "lesson_id"], DIAGNOSTIC) \
  + "\n" + inserts("diagnostic_bands", ["min_score", "max_score", "verdict", "advice"], DIAGNOSTIC_BANDS) \
  + "\n" + inserts("stage_playbook", ["sort", "stage", "period", "supabase", "you", "lessons"], STAGES) \
  + "\n" + inserts("dont_copy", ["n", "title", "body"], DONT_COPY) \
  + "\n" + inserts("templates", ["id", "lesson_id", "title", "takes", "body_md"], TEMPLATES) \
  + "\n-- Keep the shared checklist in step with the lessons (same ids, so existing ticks carry over).\n" \
  + "".join(f"update public.principles set title = {q(l[3])}, body = {q(l[4])}, how = {q(l[8].splitlines()[0])} where id = {l[0]};\n" for l in LESSONS)

# ------------------------------------------------------------------ 0012 playbook v2 (audit fixes)
# Applied on top of 0011: corrects overclaims, adds two lessons (ICP, the CEO as the channel),
# reframes lesson 10, adds a target to every metric and a "start here" block. Upserts, so a fresh
# install that runs 0011 then 0012 ends in the same state as the live project.
STAGE_ORDER = "array['pre-launch', 'launch', 'early-revenue', 'scale', 'always']"
RULE = "Our rule of thumb"
LESSONS_V2 = {
    # id: dict of changed or new fields (new lessons give every field)
    1: dict(evidence="8 databases in the weeks under the old line, 800 in the three days after the new one. Caveat: the new line shipped the same morning as the Show HN, so the two effects can't be separated. Copplestone credits the positioning: product-positioning fit can matter as much as product-market fit.",
            target="7 of 10 developers describe it correctly in one sentence. Below 5, the line isn't working yet.", target_source=RULE),
    2: dict(evidence="Five years later, Claude models still name Supabase first in about 80% of \"Firebase alternative\" answers. Preliminary: our study, Claude models only, still running.",
            target="Your comparison page ranks on page one for \"<incumbent> alternative\" within six months.", target_source=RULE),
    3: dict(target="Under 10 minutes from your homepage to first value, with no help from you. Supabase got it to seconds.", target_source=RULE),
    4: dict(target="A third of your content traffic comes from posts that don't name your product.", target_source=RULE),
    5: dict(evidence="Average star lift per launch week fell every year: 3.8x in 2021, then 2.0x, 1.5x, 1.2x, and 1.0x in 2025. Copplestone still credits each launch with roughly a 20% growth bump, so the ritual kept paying; it stopped moving stars.",
            mechanism="Five launches in five days gives the community a reason to look every morning and gives newsletter writers a story instead of a changelog line. Early on, attention is scarce and the format concentrates it. Stars also flatten as a repo gets big, so measure what you sell: signups and activations, not stars.",
            target="1.5x your 28-day signup baseline during the week. Below that twice running, change the format.", target_source=RULE),
    6: dict(move="Open source the real product, not a demo. Almost all of Supabase can be self-hosted; the only closed code is what it takes to run a million databases, which is tangled up with billing.",
            target="Outside contributors every month, and every issue answered within a working day.", target_source=RULE),
    7: dict(dont_copy_if="You can't fund 18 months without revenue. Supabase did it on 2020 and 2021 money; in 2026 a seed-to-Series A raise typically expects $100K to $500K ARR. Keep the free tier generous, but find your production signal early and charge from it.",
            target="Supabase's pace: about $1M ARR by the end of its first year of charging.", target_source="Copplestone, YC Startup School"),
    8: dict(evidence="Accounts that spoke to a rep grew 125% quarter on quarter; accounts left alone grew 25% (First Round Review). Read it with care: reps reached the accounts already showing signals, so part of that gap is selection. That's exactly why Supabase paid reps on uplift against a control group.",
            target="Contacted accounts expand at least twice as much as the control group at 90 days.", target_source=RULE),
    9: dict(evidence="In our preliminary study (Claude models only, still running), Claude names Supabase first in about 90% of generic \"database plus login\" answers, and in 0 of 124 control prompts.",
            target="Named first in at least half of your 10 core prompts, on the model your users use most.", target_source=RULE),
    10: dict(title="Raise for leverage, operate like you didn't",
             move="Supabase raised over $1B and ran it like $100K in the bank: no offices, no real ad budget, every decision written down. Copplestone's rule: the money changes nothing about how you operate.",
             evidence="A $6M seed from Coatue, a hedge fund that only gets more interested as you approach public markets. Six years on: 360 people in 60+ countries, and Pro still starts at $25 a month.",
             mechanism="Money buys runway and options, not product-market fit. Keeping a small team's habits (founders on user calls, written decisions, no paid acquisition until retention holds) is what kept every other lesson working at scale.",
             steps="Before every hire, write one sentence: \"This is burning, and it will keep burning without this person.\" If you can't, don't hire.\n"
                   "Keep founder hours on user calls fixed each week (start with five), however much you raise.\n"
                   "Pick investors whose interest grows with you. Supabase's seed lead was a late-stage fund.\n"
                   "No paid acquisition until month-3 retention holds.",
             dont_copy_if="A competitor is buying the category and the window is closing. Then speed beats thrift.",
             target="Month-3 retention steady or rising for three cohorts in a row before you spend on acquisition.", target_source=RULE),
    11: dict(chapter="origins", stage="pre-launch", title="Pick an ideal customer that grows into big bills",
             move="Supabase targeted high-growth, venture-backed startups from day one: the companies whose free projects become big production databases.",
             evidence_query="origins_timeline",
             evidence="One company in their own YC batch trusted them, by Copplestone's count. Today over 60% of every YC batch builds on Supabase.",
             mechanism="Startups adopt fast, decide without procurement and grow their usage on their own. Pick the segment whose success becomes your revenue, and your best customers arrive with the next batch, not the next sales hire.",
             steps="Describe your ideal customer in one sentence: who they are, the trigger that makes them look, and why their usage grows without you.\n"
                   "Name 20 teams that fit. If you can't name 20, the description is too narrow or too vague.\n"
                   "Find where they gather (an accelerator batch, a framework community, a Discord) and show up there every week.\n"
                   "Track which of the 20 adopt, and which of those grow. Rewrite the sentence every quarter.",
             metric="Share of new signups that match your ideal-customer sentence, and their usage growth after 90 days.",
             dont_copy_if="Your best-fit buyer churns as it grows (it graduates to building in house). Then pick the segment that stays, even if it adopts more slowly.",
             target="Within six months, 10 of your 20 named teams have tried it and 3 run it in production.", target_source=RULE),
    12: dict(chapter="postgres_bet", stage="launch", title="The CEO is the channel",
             move="Copplestone read Hacker News three times a day, posted Supabase's biggest stories himself, and kept polling developers in public.",
             evidence_query="hn_split",
             evidence="Of the 61 Hacker News stories over 100 points that link to or name Supabase, Copplestone posted 18 himself, as kiwicopple. Nobody else posted more than 4.",
             mechanism="Early on, nobody trusts a company account; they trust a builder who shows up. A founder posting the real work and answering every reply is the cheapest distribution a two-person team has, and it doubles as customer research.",
             steps="Pick the one place your ideal customers read every day (Hacker News, a subreddit, X, a Discord) and read it daily.\n"
                   "Post three times a week as yourself: what you built, what broke, what you learned. Not announcements.\n"
                   "Answer every reply within a day. The replies are your customer research.\n"
                   "Once a quarter, post something genuinely useful about the standard, not the product, and aim it at the front page.",
             metric="Signups attributed to founder posts, and replies per post.",
             dont_copy_if="You hate writing in public and it shows. Then make your most credible engineer the voice: authenticity matters more than the title.",
             target="Three real posts a week, and one front-page attempt a quarter.", target_source=RULE),
}
_L1 = {l[0]: dict(zip(["id", "chapter", "stage", "title", "move", "evidence_query", "evidence", "mechanism", "steps", "metric", "dont_copy_if"], l)) for l in LESSONS}
LESSON_COLS = ["id", "chapter", "stage", "title", "move", "evidence_query", "evidence", "mechanism", "steps", "metric", "dont_copy_if", "target", "target_source"]
LESSON_ROWS = []
for i in range(1, 13):
    row = dict(_L1.get(i, {}))
    row.update(LESSONS_V2[i])
    row["id"] = i
    LESSON_ROWS.append(tuple(row[c] for c in LESSON_COLS))

START_HERE = [
    (1, "Run the stopwatch audit on your product and your top competitor.", "Half a day, the cheapest growth lever you have, and the result tells you what to fix first.", 3, "Half a day"),
    (2, "Write your ideal-customer sentence and name 20 teams that fit.", "If you can't name 20, nothing downstream (positioning, content, outreach) has a target.", 11, "1 hour"),
    (3, "Post three times this week as the founder, in the one place your ideal customers read daily.", "Free distribution and free customer research, and it compounds.", 12, "30 minutes a day"),
]

STAGES_V2 = [
    (1, "Pre-launch", "Dec 2019 to May 2020", "A month of developer interviews and an ideal customer of VC-backed startups, then building. Tested the tagline before the Show HN.", "Interview 20 developers before writing code. Write your ideal-customer sentence and name 20 teams. Run the tagline test and the stopwatch on the incumbent.", "11, 1, 2, 3"),
    (2, "Launch to first traction", "May 2020 to 2021", "Show HN #1, YC S20, $6M seed, first launch week. The CEO posted the big stories himself.", "One big launch moment built around the borrowed category. Post in public as the founder every week. Teach the standard. Start a launch cadence and measure signups, not stars.", "12, 2, 4, 5, 6"),
    (3, "Early revenue", "2021 to 2023", "Free until production, usage-triggered sales, launch weeks at peak lift.", "Find your production signal and charge from it. Run founder-led triggered outreach with a control group. Know the 2026 bar: $100K to $500K ARR before a Series A.", "7, 8"),
    (4, "Scale", "2023 onward", "pgvector, AI app builders, coding agents. Launch weeks turn into retention.", "Measure your AI visibility, build for agents, check which rituals still acquire users.", "5, 9"),
    (5, "Always", "Every stage", "Raised over $1B and still ran it like $100K in the bank.", "Retention before acquisition. Founder hours on user calls, however much you raise.", "10"),
]

TEMPLATES_V2 = [
    ("icp_list", 11, "ICP sentence and 20 teams", "1 hour", """# ICP sentence and 20 teams

ICP: [who] who [trigger that makes them look], and whose usage grows because [reason].

| # | Team | Why they fit | Where they gather | Contacted | Adopted | Usage after 90 days |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| ... | | | | | | |
| 20 | | | | | | |

Can't name 20? The ICP is too narrow or too vague. Rewrite the sentence every quarter.
"""),
    ("founder_channel", 12, "Founder channel: weekly cadence", "30 minutes a day", """# Founder channel: weekly cadence

Where my ideal customers read daily: ____

| Day | Read (15 min) | Post (as yourself) | Replies answered |
| --- | --- | --- | --- |
| Mon | | What I built | |
| Tue | | | |
| Wed | | What broke and why | |
| Thu | | | |
| Fri | | What I learned | |

Monthly: signups attributed to founder posts = ____ · replies per post = ____
Quarterly: one genuinely useful post about the standard, aimed at the front page.
"""),
]

BAND0 = "You're probably sales-led or selling infrastructure to enterprises. Read lessons 11, 1, 3 and 8 and skip the rest."
FAQ1 = "Three compounding moves. A positioning change that shipped with the Show HN, \"the open source Firebase alternative\", took databases from 8 to 800 in three days. Relentless shipping, packaged as Launch Weeks, which Copplestone credits with roughly a 20% growth bump each (their effect on GitHub stars faded every year). Then AI app builders and coding agents adopted Supabase as their default backend, and agents now launch most new databases on the platform."
FAQ8 = "Time your onboarding against your main competitor with a stopwatch, then cut it until you're an order of magnitude faster. It's cheap, it compounds, and Supabase never even advertised theirs. Second: describe the ideal customer whose usage grows into big bills, and name 20 of those teams. Launch weeks come later, and measure them in signups, not stars."
LESSONS_INDEX_SQL = "select id, title, stage, target\nfrom lessons order by array_position(" + STAGE_ORDER + ", stage), id;"
LESSONS_INDEX_COLS = json.dumps([C("id", "int4", "mono"), C("title", "text", "bold"), C("stage", "text", "mono"), C("target", "text")])

FILES["0012_playbook_v2.sql"] = """-- Audit fixes: honest evidence, two new lessons, a target for every metric, and a start-here block.
alter table public.lessons add column if not exists target text;
alter table public.lessons add column if not exists target_source text;

create table if not exists public.start_here (
  n         int primary key,
  action    text not null,
  why       text not null,
  lesson_id int not null references public.lessons (id),
  takes     text not null
);
alter table public.start_here enable row level security;
drop policy if exists "Public read" on public.start_here;
create policy "Public read" on public.start_here for select to anon, authenticated using (true);

-- New principles first (lessons.id references principles.id); titles are synced below.
""" + inserts("principles", ["id", "title", "body", "how"], [(i, LESSONS_V2[i]["title"], LESSONS_V2[i]["move"], LESSONS_V2[i]["steps"].splitlines()[0]) for i in (11, 12)]).rstrip(";\n") + "\non conflict (id) do nothing;\n\n" \
  + inserts("lessons", LESSON_COLS, LESSON_ROWS).rstrip(";\n") + "\non conflict (id) do update set " + ", ".join(f"{c} = excluded.{c}" for c in LESSON_COLS[1:]) + ";\n\n" \
  + "".join(f"update public.principles set title = {q(r[3])}, body = {q(r[4])}, how = {q(r[8].splitlines()[0])} where id = {r[0]};\n" for r in LESSON_ROWS) + "\n" \
  + inserts("start_here", ["n", "action", "why", "lesson_id", "takes"], START_HERE).rstrip(";\n") + "\non conflict (n) do update set action = excluded.action, why = excluded.why, lesson_id = excluded.lesson_id, takes = excluded.takes;\n\n" \
  + inserts("stage_playbook", ["sort", "stage", "period", "supabase", "you", "lessons"], STAGES_V2).rstrip(";\n") + "\non conflict (sort) do update set stage = excluded.stage, period = excluded.period, supabase = excluded.supabase, you = excluded.you, lessons = excluded.lessons;\n\n" \
  + inserts("templates", ["id", "lesson_id", "title", "takes", "body_md"], TEMPLATES_V2).rstrip(";\n") + "\non conflict (id) do update set lesson_id = excluded.lesson_id, title = excluded.title, takes = excluded.takes, body_md = excluded.body_md;\n\n" \
  + inserts("dont_copy", ["n", "title", "body"], [
      (5, "Launch weeks forever", "Measure the lift in signups, not stars, and change the format when it stops working. Supabase's star lift fell every year."),
      (6, "Free until real, in 2026 money", "Supabase earned roughly nothing for 18 months on 2020 and 2021 money. Today a seed-to-Series A raise typically expects $100K to $500K ARR. Keep the free tier generous, but charge from your production signal early."),
  ]).rstrip(";\n") + "\non conflict (n) do update set title = excluded.title, body = excluded.body;\n\n" \
  + "update public.diagnostic_bands set advice = " + q(BAND0) + " where min_score = 0;\n\n" \
  + "update public.faq set a = " + q(FAQ1) + " where n = 1;\n" \
  + "update public.faq set a = " + q(FAQ8) + " where n = 8;\n\n" \
  + "-- The lessons index now runs in reading order (by stage) and shows each lesson's target.\n" \
  + "update public.case_queries set\n  sql = " + q(LESSONS_INDEX_SQL) + ",\n  columns = " + q(LESSONS_INDEX_COLS) + "::jsonb\nwhere id = 'lessons_index';\n"

# ------------------------------------------------------------------ 0013 shorter page: per-stage start here + signups
# "Start here" becomes three things per stage, picked by the reader. Signups for the next teardown are
# insert-only for the public: nobody can read the list back through the API.
START_HERE_V3 = [
    # n, stage, action, why, lesson_id, takes
    (1, "pre-launch", START_HERE[0][1], START_HERE[0][2], 3, "Half a day"),
    (2, "pre-launch", START_HERE[1][1], START_HERE[1][2], 11, "1 hour"),
    (3, "pre-launch", START_HERE[2][1], START_HERE[2][2], 12, "30 minutes a day"),
    (4, "launch", "Run the tagline test with 10 developers who match your ideal customer.", "One question, ten answers, and you'll know if your homepage line works before you spend a launch on it.", 1, "1 week"),
    (5, "launch", "Write the first of ten posts that teach your standard, and post it yourself.", "Content about the standard reaches people who would never click a vendor post.", 4, "1 day"),
    (6, "launch", "Plan one launch week from this quarter's shipped list, and record the signup baseline first.", "Without the baseline you can't tell a launch that worked from one that didn't.", 5, "2 hours"),
    (7, "early-revenue", "Define your production signal and list the free projects past it that don't pay.", "That list is your sales pipeline, and it costs nothing to build.", 7, "2 hours"),
    (8, "early-revenue", "Set up three usage triggers and send founder notes, holding back 20% as a control.", "Help at the moment of pain reads as support, and the control tells you if it works.", 8, "1 day"),
    (9, "early-revenue", "Measure month-3 retention for your last three monthly cohorts.", "Until retention holds, more acquisition just leaks.", 10, "2 hours"),
    (10, "scale", "Run the AI visibility baseline: 10 prompts, 3 models, 10 runs each.", "Agents now pick the tools. Know whether they pick you.", 9, "1 day"),
    (11, "scale", "Measure your last launch's lift in signups against its 28-day baseline.", "Supabase's star lift fell from 3.8x to 1.0x. Check whether your ritual still acquires anyone.", 5, "1 hour"),
    (12, "scale", "Re-run the stopwatch against today's fastest competitor.", "Day zero never stops mattering: Supabase went from under a minute to 5 seconds.", 3, "Half a day"),
]

_cs = FILES["0000_case_queries.sql"]
CASE_SCHEMA_V2 = _cs[_cs.index("create or replace function public.case_schema()"):].replace(
    "c.table_name <> 'case_queries'", "c.table_name not in ('case_queries', 'subscribers')")
assert "'subscribers'" in CASE_SCHEMA_V2

FILES["0013_start_here_by_stage.sql"] = """alter table public.start_here add column if not exists stage text not null default 'pre-launch'
  check (stage in ('pre-launch', 'launch', 'early-revenue', 'scale'));

""" + inserts("start_here", ["n", "stage", "action", "why", "lesson_id", "takes"], START_HERE_V3).rstrip(";\n") \
  + "\non conflict (n) do update set stage = excluded.stage, action = excluded.action, why = excluded.why, lesson_id = excluded.lesson_id, takes = excluded.takes;\n" + """
-- "Get the next teardown": the public can add an email, and nothing else. No select policy,
-- so the list can't be read back through the API; read it in the dashboard.
create table if not exists public.subscribers (
  id         bigint generated always as identity primary key,
  email      text not null unique check (length(email) <= 254 and email ~* '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'),
  source     text not null default 'supabase-teardown' check (length(source) <= 64),
  created_at timestamptz not null default now()
);
alter table public.subscribers enable row level security;
drop policy if exists "Anyone can subscribe" on public.subscribers;
create policy "Anyone can subscribe" on public.subscribers for insert to anon, authenticated with check (true);
revoke all on public.subscribers from anon, authenticated;
grant insert (email, source) on public.subscribers to anon, authenticated;

-- Keep subscribers out of case_schema, so the column strips and the in-browser console never touch it.
""" + CASE_SCHEMA_V2

# ------------------------------------------------------------------ 0014 audit fixes
# Every change here comes from the line-by-line audit in research/AUDIT-FINDINGS.md: claims now match their
# sources (YC Startup School transcript, First Round Review, Contrary Research, press releases, our own data),
# and targets we can't trace to a public source are labelled as our rule of thumb.
YC, FRR, CON = "YC Startup School", "First Round Review", "Contrary Research"
RULE = "Our rule of thumb"
LESSON_FIX = {
    1: dict(move="Copplestone changed one line of homepage copy, from \"realtime postgres.\" to \"The opensource Firebase alternative.\" The next day an early user posted Supabase to Hacker News, and it reached the top.",
            evidence="8 hosted databases before the change, 800 within three days (Contrary Research). The new line and the Hacker News post came a day apart, so the credit can't be split. Copplestone credits the positioning: \"product-market fit often is just like a product-positioning fit\" (First Round Review).",
            dont_copy_if="You change the line every week. Supabase kept \"Firebase alternative\" in its page title for five years."),
    2: dict(evidence="Six years later, AI models still make the link. Asked for a Firebase alternative, three Claude models named Supabase in all 143 answers and as the first alternative in 120 (84%). Preliminary: our own study, Claude models only."),
    3: dict(evidence="Copplestone timed AWS himself: launching an RDS instance, connecting a tool and inserting one row took about 8.5 minutes. The early target was under a minute; today it's about 5 seconds. They never said the number out loud (YC Startup School).",
            mechanism="Developers usually pick a backend at the start of a project, in the first hour of trying things. Being fastest then is how you get picked. Building on Postgres meant Supabase didn't lose the project later, when it needed to scale.",
            target="Under 10 minutes from your homepage to first value, with no help from you. Supabase got it to seconds.", target_source=RULE),
    4: dict(mechanism="Nobody owns Postgres, so everyone contributes to it, and every hyperscaler has to offer a strong Postgres. Copplestone calls it game theory. The engine keeps improving without Supabase paying for it. Portability lowers the fear of trying, and content about the standard reaches people who would never click a vendor post."),
    5: dict(evidence="Average star lift per launch week fell every year we measured: 3.8x in 2021, then 2.0x, 1.5x, 1.2x, and 1.0x in 2025 (data to July 2025). Copplestone still saw \"these 20% bumps each time\" (First Round Review), so the ritual kept paying; it stopped moving stars."),
    6: dict(move="Open source the real product, not a demo. Everything Supabase builds is MIT, Apache 2 or PostgreSQL licensed, except the platform and billing code (First Round Review).",
            evidence="The May 2020 Hacker News post brought 522 new stars in a day, still the repo's best day in our data (to September 2025). The repo has about 112K stars today.",
            mechanism="Developers trust code they can read and self-host. That trust is what let a team of about three get adopted by teams that would never buy from a startup."),
    7: dict(evidence="No revenue for about 18 months, then roughly $1M ARR by the end of the first year of charging and about $7.5M the year after, by Copplestone's rough recollection (YC Startup School).",
            target="Supabase's pace: about $1M ARR by the end of its first year of charging.", target_source="Copplestone, YC Startup School",
            dont_copy_if="You can't fund 18 months without revenue. Supabase did it on 2020 and 2021 money. Check what your next investors expect to see, and start charging from your production signal early."),
    8: dict(move="Sales reach out when usage says the customer needs help (disk thrashing, CPU limits), not when a lead score says they might buy. Copplestone: \"our sales actually just looks like support.\"",
            evidence="Product triggers send an automated email to accounts that fit. Accounts that talked to the success team grew usage 125% quarter on quarter; accounts that didn't reply grew 25% (First Round Review). The groups choose themselves, so treat the gap as a direction, not proof. The team is paid only on the incremental uplift over the non-responders.",
            mechanism="The message lands when the developer has a problem, so it reads as help, not a pitch. Paying on incremental uplift stops the team claiming growth that would have happened anyway.",
            steps="Pick three triggers: near a plan limit, an error spike, usage doubling week on week.\n"
                  "When one fires, a founder sends a plain-text note: what you noticed, one specific suggestion, an offer to talk. No deck.\n"
                  "Hold back a random 20% of triggered accounts and don't contact them. That's a stricter control than Supabase's, and it tells you what the outreach is worth.\n"
                  "Hire for this only once the founder-run version beats the control. Pay on that uplift."),
    9: dict(evidence="In our preliminary study of three Claude models, Supabase was the first backend named in 160 of 180 generic \"database plus login\" answers (89%) and in 0 of 84 control prompts. Copplestone: \"The LLM slurped up a lot of Supabase.\"",
            mechanism="Years of open source code, Reddit threads and GitHub discussions became training data. Then Supabase built for agents directly: a CLI and an MCP server an agent can drive.",
            steps="Ask three AI models the question your ideal customer would ask, 10 times each. Count how often you're named, and first. That's your baseline (our prompts and scripts are open source).\n"
                  "Publish llms.txt (a proposed standard) and make your docs readable as plain text, one concept per page.\n"
                  "Make the product drivable without a browser: a CLI with clear errors, an OpenAPI spec, an MCP server if agents would use it.\n"
                  "Answer questions in public (GitHub discussions, Stack Overflow, Reddit), not only in a Discord no model will ever read.\n"
                  "Re-run the baseline every quarter."),
    10: dict(move="Supabase raised over $1B and still runs fully remote, with no offices, little marketing spend and decisions written down in Slack and Notion. Copplestone: \"the money shouldn't change how you operate.\"",
             evidence="The $6M seed came from Coatue, a hedge fund that barely cared at that size and got much more interested as public markets came into view. Today: about 350 people in 60+ countries, and Pro still starts at $25 a month.",
             steps="Before every hire, write one sentence: \"This is burning, and it will keep burning without this person.\" If you can't, don't hire.\n"
                   "Keep founder hours on user calls fixed each week (start with five), however much you raise.\n"
                   "Pick investors whose interest grows as you do.\n"
                   "No paid acquisition until month-3 retention holds.",
             metric="Month-3 retention: of developers active in their first month, how many are still active in month 3?",
             target="Steady or rising for three cohorts in a row before you spend on acquisition.", target_source=RULE),
    11: dict(evidence="Copplestone on their own YC batch: \"I think there was zero. Uh well there was one company.\" He now puts it at over 60% of each batch; Supabase's last published count was 55% of the most recent batch (October 2025).",
             target="Within six months, 10 of your 20 named teams have tried it and 3 run it in production.", target_source=RULE),
    12: dict(move="Copplestone read Hacker News about three times a day, watched the Show HNs, and posted many of Supabase's biggest stories himself.",
             evidence="Of the 61 Hacker News stories over 100 points that link to or name Supabase, he posted 18, including two of the top three. 13 of his 18 never mention Supabase in the headline. Nobody else posted more than 4.",
             target="Three real posts a week, and one front-page attempt a quarter.", target_source=RULE),
}
_cols = LESSON_COLS
LESSON_ROWS_V3 = []
for r in LESSON_ROWS:
    d = dict(zip(_cols, r)); d.update(LESSON_FIX.get(d["id"], {})); LESSON_ROWS_V3.append(tuple(d[c] for c in _cols))

STAGES_V3 = [
    (1, "Pre-launch", "Supabase: Dec 2019 to May 2020", "Interviewed developers, picked VC-backed startups as the ideal customer, then built. Changed the tagline the day before the Hacker News post that put them on the map.", STAGES_V2[0][4], STAGES_V2[0][5]),
    (2, "Launch to first traction", "Supabase: May 2020 to 2021", "Top of Hacker News, YC S20, $6M seed, first Launch Week. The CEO posted many of the big stories himself.", STAGES_V2[1][4], STAGES_V2[1][5]),
    (3, "Early revenue", "Supabase: 2021 to 2023", "Free until production, usage-triggered outreach, launch weeks at peak lift.", "Find your production signal and charge from it. Run founder-led triggered outreach with a control group. Check what your next investors expect to see in revenue.", "7, 8"),
    (4, "Scale", "Supabase: 2023 onward", STAGES_V2[3][3], STAGES_V2[3][4], STAGES_V2[3][5]),
    (5, "Always", "Every stage", "Raised over $1B and still runs remote, frugal and written down.", STAGES_V2[4][4], STAGES_V2[4][5]),
]
DONT_COPY_V3 = [
    (1, "The luck", "Copplestone assumes agents will settle on about three defaults per category, and says getting picked takes a lot of luck: \"I don't like betting on luck.\" Do the fundamentals, and don't build a plan that needs lightning to strike."),
    (2, "The insecure defaults", "A 2025 scan of 1,645 apps built with Lovable found 170 (10.3%) exposing data through missing or misconfigured Row Level Security (CVE-2025-48757, which Lovable disputes). Fast setup without safe defaults becomes someone else's breach and your headline. Make the safe path the fast path."),
    (3, "Concentration risk", "If one partner sends most of your users, your growth depends on their roadmap. Supabase turned that risk into a product: Lovable Cloud and Bolt Cloud both run on Supabase."),
    (4, "Free usage as revenue", "4 million new databases a month is a vanity number until a slice of them pays."),
    (5, "Launch weeks forever", "Measure the lift in signups, not stars, and change the format when it stops working. Supabase's star lift fell every year we measured."),
    (6, "Free until real, in 2026 money", "Supabase earned nothing for about 18 months on 2020 and 2021 money. Before you copy that, check what your next investors expect to see in revenue, and charge from your production signal early."),
]
FAQ_V3 = {
    1: "Three compounding moves. A new tagline, \"the open source Firebase alternative\", went live the day before an early user's Hacker News post reached the top, and hosted databases went from 8 to 800 in three days. Relentless shipping, packaged as Launch Weeks, which Copplestone saw give \"20% bumps each time\" (their effect on GitHub stars faded every year). Then AI app builders and coding agents adopted Supabase as their default backend; by October 2026, 70% of new databases were created by agents or AI tools.",
    3: "The product did the marketing. Copplestone timed AWS (about 8.5 minutes from a new database to a first row) and got Supabase to about 5 seconds. The team polled developers on Hacker News, Reddit and Twitter, and turned releases into Launch Weeks. In his words: \"if I could give a free database, I'd rather give that to developers than spending on marketing.\"",
    4: "Not for Supabase. Everything it builds is open source except the platform and billing code, the part it takes to host millions of databases. Customers pay for hosting, scale and not being on call. By Copplestone's rough recollection, revenue took about 18 months to start, reached roughly $1M ARR by the end of the first year of charging, then about $7.5M the year after.",
    5: "One setup step gives a full Postgres database with auth, APIs and storage, and years of open source code, Reddit threads and GitHub discussions meant models already knew it well. Supabase then built for that traffic: Supabase for Platforms for app builders, and a CLI and MCP server for agents. By October 2026, Supabase said 70% of new databases were created by agents or AI tools.",
    6: "There's no trick, and Supabase's CEO says part of it is luck: if agents settle on about three defaults per category, most tools won't be one. What you control: get developers to a result fast with as little input as possible, make the product fully operable from a CLI and MCP, publish clean docs, and answer questions in public where models can learn from them.",
    7: "Supabase's CEO puts it bluntly: \"we should not exist if AWS are so good. They've got way more cash than us.\" Cash wasn't the deciding factor. Developer experience, open source trust and community were. When Copplestone timed it at the start, AWS took about 8.5 minutes from a new database to a first row; Supabase now takes about 5 seconds.",
}
SOURCES_V3 = [
    (1, "Contrary Research: Supabase", "https://research.contrary.com/company/supabase"),
    (2, "First Round Review: Paul Copplestone (Jun 2026)", "https://review.firstround.com/how-supabase-became-the-essential-infrastructure-for-the-ai-era-paul-copplestone-co-founder-ceo/"),
    (3, "YC Startup School Paris: Paul Copplestone (2026)", "https://www.ycombinator.com/library/ax-how-supabase-became-one-of-the-fastest-growing-devtool-companies-in-the-world"),
    (4, "Hacker News: the May 2020 post", "https://news.ycombinator.com/item?id=23319901"),
    (5, "Supabase blog: Alpha launch postmortem (Jul 2020)", "https://supabase.com/blog/alpha-launch-postmortem"),
    (6, "Supabase blog: Launch Week, March 2021", "https://supabase.com/blog/2021/03/25/launch-week"),
    (7, "Supabase blog: How we launch", "https://supabase.com/blog/supabase-how-we-launch"),
    (8, "Supabase blog: 1,000 YC companies (Oct 2025)", "https://supabase.com/blog/1000-yc-companies"),
    (9, "TechCrunch: $6M seed (Dec 2020)", "https://techcrunch.com/?p=2200170"),
    (10, "TechCrunch: Series C (Sep 2024)", "https://techcrunch.com/2024/09/25/supabase-a-postgres-centric-developer-platform-raises-80m-series-c"),
    (11, "Fortune: Series D (Apr 2025)", "https://www.fortune.com/2025/04/22/exclusive-supabase-raises-200-million-series-d-at-2-billion-valuation"),
    (12, "PR Newswire: Series E (Oct 2025)", "https://www.prnewswire.com/news-releases/supabase-raises-100m-at-5b-valuation-co-led-by-accel-and-peak-xv-302573153.html"),
    (13, "PR Newswire: Series F (Jun 2026)", "https://www.prnewswire.com/news-releases/supabase-raises-500m-at-10-5b-to-accelerate-lead-in-agentic-infrastructure-302791787.html"),
    (14, "TechCrunch: Series F and Claude Code (Jun 2026)", "https://techcrunch.com/2026/06/05/supabase-doubles-valuation-to-10b-in-8-months/"),
    (15, "PR Newswire: $150M and Turso (Oct 2026)", "https://www.prnewswire.com/news-releases/supabase-announces-150m-in-new-funding-and-turso-acquisition-302896752.html"),
    (16, "Sacra: revenue estimates", "https://sacra.com/c/supabase/"),
    (17, "Matt Palmer: statement on CVE-2025-48757", "https://mattpalmer.io/posts/statement-on-CVE-2025-48757/"),
    (18, "Stack Overflow Developer Survey 2026", "https://survey.stackoverflow.co/2026/technology"),
    (19, "OSS Insight: supabase/supabase star history", "https://ossinsight.io/analyze/supabase/supabase"),
    (20, "Hacker News search API (Algolia)", "https://hn.algolia.com/api"),
    (21, "Wayback Machine: supabase.io, 2020", "https://web.archive.org/web/2020*/supabase.io"),
    (22, "Supabase blog RSS (launch week dates)", "https://supabase.com/rss.xml"),
    (23, "github.com/supabase/supabase", "https://github.com/supabase/supabase"),
]
COLUMN_FIXES = {
    "taglines_history": [C("captured_label", "text", "mono"), C("copy", "text"), C("note", "text")],
    "rounds": [C("closed_label", "text", "mono"), C("round", "text"), C("amount_usd", "numeric", "usd_compact"), C("valuation_usd", "numeric", "usd_compact", null="n/d"), C("lead", "text")],
}
FOOTER_FIXES = {
    "rounds": "n/d = not disclosed. Series E and F valuations are post-money",
    "launch_week_lift": "lift = stars/day in the week ÷ stars/day in the 4 weeks before it, skipping the week just before. Source: OSS Insight (GH Archive)",
    "sales_cohorts": "Usage growth, quarter on quarter. Self-selected groups. Source: First Round Review",
    "time_to_first_row": "Source: Paul Copplestone, YC Startup School",
    "revenue": "Early years: Copplestone's rough recollection, YC Startup School. 2026: Sacra estimate",
}
_sql = []
TAGLINE_NOTE_1 = 'Sold as an add-on to "your existing PostgreSQL database". 8 hosted databases'
KNOWN_ISSUE_1 = 'A 2025 scan of 1,645 apps built with Lovable found 170 (10.3%) exposing data through missing or misconfigured Row Level Security (CVE-2025-48757, which Lovable disputes). On Hacker News, "Supabase MCP can leak your entire SQL database" (July 2025) drew 848 points and 470 comments.'
_sql.append(inserts("lessons", _cols, LESSON_ROWS_V3).rstrip(";\n") + "\non conflict (id) do update set " + ", ".join(f"{c} = excluded.{c}" for c in _cols[1:]) + ";\n")
_sql.append("".join(f"update public.principles set title = {q(r[3])}, body = {q(r[4])}, how = {q(r[8].splitlines()[0])} where id = {r[0]};\n" for r in LESSON_ROWS_V3))
_sql.append(inserts("stage_playbook", ["sort", "stage", "period", "supabase", "you", "lessons"], STAGES_V3).rstrip(";\n") + "\non conflict (sort) do update set stage = excluded.stage, period = excluded.period, supabase = excluded.supabase, you = excluded.you, lessons = excluded.lessons;\n")
_sql.append(inserts("dont_copy", ["n", "title", "body"], DONT_COPY_V3).rstrip(";\n") + "\non conflict (n) do update set title = excluded.title, body = excluded.body;\n")
_sql.append("".join(f"update public.faq set a = {q(a)} where n = {n};\n" for n, a in FAQ_V3.items()))
_sql.append("delete from public.sources where n > " + str(len(SOURCES_V3)) + ";\n" + inserts("sources", ["n", "label", "href"], SOURCES_V3).rstrip(";\n") + "\non conflict (n) do update set label = excluded.label, href = excluded.href;\n")
_sql.append(f"""update public.diagnostic_questions set question = {q("Can a developer get value in under 10 minutes without talking to you?")} where n = 2;
update public.start_here set why = {q("Half a day, one of the cheapest growth levers you have, and the result tells you what to fix first.")} where n = 1;
update public.start_here set why = {q("Day zero never stops mattering: Supabase went from an early target of under a minute to about 5 seconds.")} where n = 12;
update public.templates set body_md = replace(body_md, {q("Supabase's benchmark: 8.5 minutes on AWS RDS, 5 seconds on Supabase.")}, {q("Copplestone's numbers: about 8.5 minutes on AWS RDS when he timed it at the start, about 5 seconds on Supabase today.")}) where id = 'stopwatch_audit';
update public.templates set body_md = replace(body_md, '- [ ] llms.txt at your docs root', '- [ ] llms.txt (a proposed standard) at your docs root') where id = 'ai_legibility';

update public.origins set event = {q("Copplestone pitches the idea to Ant Wilson (they met through Entrepreneur First, per Contrary Research)")} where at = '2019-12-01';
update public.origins set event = {q("Founded; January spent interviewing developers")} where at = '2020-01-01';
update public.origins set event = {q("An early user's Hacker News post reaches the top: 1,120 points, 366 comments. 522 new GitHub stars that day, still the repo's biggest day in our data")} where at = '2020-05-27';
update public.origins set event = {q("YC S20; fully remote from the start")} where at = '2020-07-01';
update public.origins set event = {q("$6M seed led by Coatue")} where at = '2020-12-15';

update public.taglines set note = {q(TAGLINE_NOTE_1)} where captured = '2020-05-25 09:07:56+00';
update public.taglines set note = {q("Captured an hour after an early user's Hacker News post went up. Typo and all. 800 hosted databases within 3 days")} where captured = '2020-05-27 07:15:40+00';

update public.onboarding_benchmarks set stack = {q("Supabase early target (under a minute)")} where id = 2;

update public.launch_weeks set shipped = 'Storage' where week = '2021-03' and day_index = 2;
update public.launch_weeks set shipped = 'Three more things: connection pooling, workflows, and supabase.io becomes supabase.com' where week = '2021-03' and day_index = 5;

update public.sales_motion set cohort = {q("Emailed by a trigger, didn't reply")} where cohort = 'PLG account, left alone';
update public.sales_motion set cohort = {q("Talked to the success team")} where cohort = 'PLG account, spoke to a rep';

update public.revenue set period = 'First ~18 months', source = 'Paul Copplestone, YC Startup School (rough recollection)' where sort = 1;
update public.revenue set period = 'End of first year of charging', source = 'Paul Copplestone, YC Startup School (rough recollection)' where sort = 2;
update public.revenue set source = 'Paul Copplestone, YC Startup School (rough recollection)' where sort = 3;

update public.ai_waves set driver = {q("Bolt.new and Lovable made Supabase their default backend. By late December 2024, Supabase said it was getting DDoSed by the databases they created.")} where id = 2;
update public.ai_waves set driver = {q("Claude Code, Codex and others create databases straight from the CLI and MCP. Claude Code has been the largest contributor since the start of 2026 (Series F announcement).")} where id = 3;
update public.developer_experience set primary_interface = {q("CLI and MCP, heading toward declarative schemas in Git and branchable environments")} where id = 3;

update public.rounds set closed = '2024-09-25', closed_label = 'Sep 2024', note = null where closed = '2024-09-01';
update public.rounds set round = 'Growth round + Turso deal', note = 'Not a named series; no valuation disclosed; Turso terms undisclosed' where closed = '2026-10-02';
update public.rounds set note = 'Led by Coatue with Y Combinator, Mozilla and angels (TechCrunch)' where closed = '2020-12-15';

update public.known_issues set detail = {q(KNOWN_ISSUE_1)} where id = 1;
""")
_sql.append("".join(f"update public.case_queries set columns = {q(json.dumps(cols))}::jsonb where id = {q(i)};\n" for i, cols in COLUMN_FIXES.items()))
_sql.append("".join(f"update public.case_queries set footer_right = {q(t)} where id = {q(i)};\n" for i, t in FOOTER_FIXES.items()))
FILES["0014_audit_fixes.sql"] = "-- Line-by-line audit fixes. See research/AUDIT-FINDINGS.md for the source behind each change.\n\n" + "\n".join(_sql)


# ------------------------------------------------------------------ 0015 no third-party benchmarks
# Removes every benchmark we couldn't trace to a public source (time-to-value, retention,
# hiring order, revenue milestones). Targets are now Supabase's own numbers or labelled as our rule of thumb.
_s15 = [inserts("lessons", _cols, LESSON_ROWS_V3).rstrip(";\n") + "\non conflict (id) do update set " + ", ".join(f"{c} = excluded.{c}" for c in _cols[1:]) + ";\n",
        "".join(f"update public.principles set title = {q(r[3])}, body = {q(r[4])}, how = {q(r[8].splitlines()[0])} where id = {r[0]};\n" for r in LESSON_ROWS_V3),
        f"update public.stage_playbook set you = {q(STAGES_V3[4][4])} where sort = 5;\n",
        "update public.diagnostic_questions set question = " + q("Can a developer get value in under 10 minutes without talking to you?") + " where n = 2;\n",
        "update public.start_here set action = " + q(START_HERE_V3[8][2]) + ", why = " + q(START_HERE_V3[8][3]) + " where n = 9;\n"]
FILES["0015_no_third_party_benchmarks.sql"] = "-- Targets are Supabase's own numbers or our rule of thumb. No unsourced third-party benchmarks.\n\n" + "\n".join(_s15)

# ------------------------------------------------------------------ 0016 AI recommendation study (final)
# Numbers come from research/ai-recommendation-test/results/*.json (export_headline.py and the build log).
_AI = json.loads((ROOT / "research" / "ai-recommendation-test" / "results" / "headline.json").read_text())
_BUILDS = json.loads((ROOT / "research" / "ai-recommendation-test" / "results" / "builds.json").read_text())
_g = {g["prompt_group"]: g for g in _AI["groups"]}
LESSON_AI = {
    2: dict(evidence="Six years later, AI models still make the link. Asked for a Firebase alternative, three Claude models recommended Supabase first in 77 to 82% of 150 answers, depending on how you count. Asked for Postgres hosting, they picked Neon in 93 of 120 answers and Supabase in 16. Models file you under the category you borrowed, not the one you claim later (our pre-registered study, October 2026)."),
    4: dict(mechanism=LESSON_FIX[4]["mechanism"] + " The trade-off shows up in AI answers: asked about AI apps, Claude models recommended plain Postgres with pgvector in 91 of 150 answers and Supabase in 29. When the question is about the standard, the standard gets the credit."),
    9: dict(evidence="In our pre-registered study of 1,020 answers from three Claude models, Supabase was the first recommendation in 83 to 86% of generic \"database plus login\" answers and in none of 120 control answers. But when Claude Code built 15 apps in an empty folder with no network, it never chose a hosted backend: 12 used SQLite and 3 kept data in memory. Copplestone: \"The LLM slurped up a lot of Supabase.\"",
            mechanism=LESSON_FIX[9]["mechanism"] + " An agent that can't sign up for anything uses whatever runs without an account.",
            steps="Ask three AI models the question your ideal customer would ask, 10 times each. Count how often you're named, and first. That's your baseline (our prompts and scripts are open source).\n"
                  "Publish llms.txt (a proposed standard) and make your docs readable as plain text, one concept per page.\n"
                  "Make the product drivable without a browser: a CLI with clear errors, an OpenAPI spec, an MCP server if agents would use it.\n"
                  "Ship a local mode that works without an account (one command, no keys), so an agent with no credentials can still start with you.\n"
                  "Answer questions in public (GitHub discussions, Stack Overflow, Reddit), not only in a Discord no model will ever read.\n"
                  "Re-run the baseline every quarter."),
}
_rows16 = []
for r in LESSON_ROWS_V3:
    d = dict(zip(_cols, r)); d.update(LESSON_AI.get(d["id"], {})); _rows16.append(tuple(d[c] for c in _cols))
FAQ_AI = {
    5: FAQ_V3[5] + " In our study, Claude models recommended it first in 83 to 86% of generic backend questions.",
    6: FAQ_V3[6] + " In our tests, Claude Code working offline chose SQLite or in-memory storage every time, so give agents a way to start without an account.",
}
FILES["0016_ai_study.sql"] = """-- Final results of the pre-registered AI recommendation study (research/ai-recommendation-test).
create table if not exists public.ai_study (
  sort                   int primary key,
  prompt_group           text not null,
  answers                int  not null,
  supabase_judge         int  not null,   -- primary recommendation per the Claude Sonnet 5.5 judge
  supabase_first_mention int  not null,   -- first product named (Firebase skipped for "Firebase alternative")
  top_pick               text not null,
  top_pick_n             int  not null
);
create table if not exists public.ai_builds (
  sort    int primary key,
  task    text not null,
  runs    int  not null,
  backend text not null
);
""" + public_read("ai_study", "ai_builds").replace('create policy "Public read"', 'drop policy if exists "Public read" on public.ai_study;\ndrop policy if exists "Public read" on public.ai_builds;\ncreate policy "Public read"', 1) + "\n" \
  + inserts("ai_study", ["sort", "prompt_group", "answers", "supabase_judge", "supabase_first_mention", "top_pick", "top_pick_n"],
            [(g["sort"], g["prompt_group"], g["answers"], g["supabase_judge"], g["supabase_first_mention"], g["top_pick"], g["top_pick_n"]) for g in _AI["groups"]]).rstrip(";\n") \
  + "\non conflict (sort) do update set prompt_group = excluded.prompt_group, answers = excluded.answers, supabase_judge = excluded.supabase_judge, supabase_first_mention = excluded.supabase_first_mention, top_pick = excluded.top_pick, top_pick_n = excluded.top_pick_n;\n\n" \
  + inserts("ai_builds", ["sort", "task", "runs", "backend"], [(t["sort"], t["task"], t["runs"], t["backend"]) for t in _BUILDS["tasks"]]).rstrip(";\n") \
  + "\non conflict (sort) do update set task = excluded.task, runs = excluded.runs, backend = excluded.backend;\n\n" \
  + "delete from public.case_queries where id in ('ai_study', 'ai_builds');\n" + register([
    ("ai_study", "ai_waves", 5,
     "select prompt_group, answers,\n       round(100.0 * supabase_judge / answers) as supabase_first_pct,\n       round(100.0 * supabase_first_mention / answers) as by_first_mention_pct,\n       top_pick || ' (' || top_pick_n || ')' as top_pick,\n       sort <= 2 as _hot\nfrom ai_study order by sort;",
     [C("prompt_group", "text"), C("answers", "int4", "mono"), C("supabase_first_pct", "numeric", "pct", key=True), C("by_first_mention_pct", "numeric", "pct"), C("top_pick", "text")],
     "1,020 answers from Claude Opus, Sonnet and Haiku 5.5, Oct 2026. Judge: Claude Sonnet 5.5. Pre-registered", {"bar": "supabase_first_pct", "max": 100}),
    ("ai_builds", "ai_waves", 6,
     "select task, runs, backend from ai_builds order by sort;",
     [C("task", "text"), C("runs", "int4", "mono"), C("backend", "text")],
     "Claude Code (Opus 5.5) in an empty folder, file tools only, no network. 0 of 15 asked a question", None),
]) + "\n" \
  + inserts("lessons", _cols, _rows16).rstrip(";\n") + "\non conflict (id) do update set " + ", ".join(f"{c} = excluded.{c}" for c in _cols[1:]) + ";\n\n" \
  + "".join(f"update public.faq set a = {q(a)} where n = {n};\n" for n, a in FAQ_AI.items()) \
  + inserts("sources", ["n", "label", "href"], [(24, "Our AI recommendation study: prompts, data and scripts (pre-registered, Oct 2026)", "#ai_waves")]).rstrip(";\n") + "\non conflict (n) do update set label = excluded.label, href = excluded.href;\n"


# ------------------------------------------------------------------ 0017 judge check
FILES["0017_ai_study_check.sql"] = "update public.case_queries set footer_right = " + q("1,020 answers from Claude Opus, Sonnet and Haiku 5.5, Oct 2026. Judge: Claude Sonnet 5.5; a blind second Claude reader agreed on 92 of 100. Pre-registered") + " where id = 'ai_study';\n"


# ------------------------------------------------------------------ 0018 clearer ideal-customer template
ICP_TEMPLATE = """# Your ideal customer and 20 teams

## Your ideal customer, in one sentence

We're for **[type of team]** who **[moment that makes them look for a tool like ours]**. Their usage grows on its own because **[reason]**.

*Supabase in 2020, in our words: We're for venture-backed startups who need a backend this week. Their usage grows on its own because their apps grow.*

## 20 teams that fit

| # | Team | Why they fit | Where to find them | Contacted | Tried it | Usage at 90 days |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| ... | | | | | | |
| 20 | | | | | | |

Can't name 20? The sentence is too narrow or too vague. Rewrite it every quarter.
"""
FILES["0018_icp_template.sql"] = "update public.templates set title = " + q("Your ideal customer and 20 teams") + ", body_md = " + q(ICP_TEMPLATE) + " where id = 'icp_list';\n"


# ------------------------------------------------------------------ 0019 "ideal customer" instead of "ICP"
ICP_PAIRS = [["Pick an ICP that grows into big bills", "Pick an ideal customer that grows into big bills"], ["with a tool your ICP knows", "with a tool your ideal customers know"], ["the question your ICP would ask", "the question your ideal customer would ask"], ["Write your ICP in one sentence", "Describe your ideal customer in one sentence"], ["the ICP is too narrow or too vague", "the description is too narrow or too vague"], ["the one place your ICP reads every day", "the one place your ideal customers read every day"], ["the one place your ICP reads daily", "the one place your ideal customers read daily"], ["write down the ICP whose usage grows into big bills", "describe the ideal customer whose usage grows into big bills"], ["picked VC-backed startups as the ICP", "picked VC-backed startups as the ideal customer"], ["Write the ICP sentence and name 20 teams", "Write your ideal-customer sentence and name 20 teams"], ["Write your ICP sentence and name 20 teams", "Write your ideal-customer sentence and name 20 teams"], ["Where my ICP reads daily", "Where my ideal customers read daily"], ["10 ICP prompts", "10 prompts your ideal customer would ask"], ["10 developers from your ICP", "10 developers who match your ideal customer"], ["match the ICP sentence", "match your ideal-customer sentence"], ["an ICP of VC-backed startups", "an ideal customer of VC-backed startups"]]
_ICP_COLS = {"lessons": ["title", "move", "evidence", "mechanism", "steps", "metric", "target", "dont_copy_if"],
             "principles": ["title", "body", "how"], "faq": ["a"], "stage_playbook": ["supabase", "you"],
             "templates": ["title", "body_md"], "start_here": ["action", "why"], "diagnostic_questions": ["question", "why"]}
def _replace_chain(col):
    expr = col
    for a, b in ICP_PAIRS:
        expr = f"replace({expr}, {q(a)}, {q(b)})"
    return expr
FILES["0019_ideal_customer.sql"] = "-- Spell out \"ideal customer\" everywhere instead of the acronym ICP.\n\n" + "".join(
    f"update public.{t} set {c} = {_replace_chain(c)} where {c} like '%ICP%';\n" for t, cols in _ICP_COLS.items() for c in cols)


# ------------------------------------------------------------------ 0020 link the public repo
REPO = "https://github.com/AIDevGTM/supabase-gtm-teardown"
FILES["0020_repo_links.sql"] = inserts("sources", ["n", "label", "href"], [
    (24, "Our AI recommendation study: prompts, data and scripts (pre-registered, Oct 2026)", REPO + "/tree/main/research/ai-recommendation-test"),
    (25, "This case study's code and data (MIT)", REPO),
]).rstrip(";\n") + "\non conflict (n) do update set label = excluded.label, href = excluded.href;\n"


# ------------------------------------------------------------------ 0021 findings block + "why not Appwrite?" comparison
# Rival data collected 20 Oct 2026: GitHub API (stars, repo created), HN Algolia (stories of 100+ points with the name
# in the title or URL), our AI study (first pick and mentions on the 150 "Firebase alternative" answers), READMEs (database).
RIVALS = [
    # sort, product, positioning, database_layer, repo_created, github_stars, hn_100_stories, hn_points, ai_first_pick, ai_named
    (1, "Supabase", "An open source Firebase alternative (Hacker News, 2020)", "Postgres, a full database per project", "2019-10-12", 112224, 61, 17401, 123, 150),
    (2, "Appwrite", "Open-source and self-hosted Firebase alternative (Show HN, 2022)", "Its own database layer; now also managed PostgreSQL and MySQL", "2019-04-08", 57739, 2, 479, 0, 118),
    (3, "Nhost", "Open source Firebase alternative with GraphQL (Show HN, 2020)", "Postgres behind a Hasura GraphQL API", "2021-02-09", 9363, 3, 547, 0, 84),
    (4, "PocketBase", "Open source realtime backend in 1 file", "SQLite, in a single Go binary", "2022-07-05", 61507, 5, 2194, 0, 113),
]
FINDINGS = [
    # sort, number, headline, detail, anchor
    (1, "3.8x → 1.0x", "Launch weeks stopped moving stars.", "Average GitHub star lift per launch week fell every year from 2021 to 2025. The ritual kept paying in growth; it stopped acquiring attention.", "lesson-5"),
    (2, "18 of 61", "The CEO was the channel.", "Copplestone posted 18 of the 61 Hacker News stories over 100 points that link to or name Supabase. 29 of the 61 never say Supabase in the headline: they teach Postgres.", "lesson-12"),
    (3, "0 of 150", "Being in the category isn't owning it.", "Asked for a Firebase alternative, Claude named Appwrite in 118 of 150 answers and never picked it first. Supabase was first in 123.", "rivals"),
    (4, "93 of 120", "Models file you under the category you borrowed.", "Ask Claude for Postgres hosting and it picks Neon in 93 of 120 answers; Supabase gets 16, despite calling itself the Postgres development platform.", "ai_waves"),
]
FILES["0021_findings_and_rivals.sql"] = """create table if not exists public.findings (
  sort     int primary key,
  number   text not null,
  headline text not null,
  detail   text not null,
  anchor   text not null   -- in-page id the card links to
);
create table if not exists public.rivals (
  sort           int primary key,
  product        text not null,
  positioning    text not null,
  database_layer text not null,
  repo_created   date not null,
  github_stars   int  not null,
  hn_100_stories int  not null,
  hn_points      int  not null,
  ai_first_pick  int  not null,   -- of 150 "Firebase alternative" answers
  ai_named       int  not null
);
""" + public_read("findings", "rivals").replace('create policy "Public read"', 'drop policy if exists "Public read" on public.findings;\ndrop policy if exists "Public read" on public.rivals;\ncreate policy "Public read"', 1) + "\n" \
  + inserts("findings", ["sort", "number", "headline", "detail", "anchor"], FINDINGS).rstrip(";\n") \
  + "\non conflict (sort) do update set number = excluded.number, headline = excluded.headline, detail = excluded.detail, anchor = excluded.anchor;\n\n" \
  + inserts("rivals", ["sort", "product", "positioning", "database_layer", "repo_created", "github_stars", "hn_100_stories", "hn_points", "ai_first_pick", "ai_named"], RIVALS).rstrip(";\n") \
  + "\non conflict (sort) do update set product = excluded.product, positioning = excluded.positioning, database_layer = excluded.database_layer, repo_created = excluded.repo_created, github_stars = excluded.github_stars, hn_100_stories = excluded.hn_100_stories, hn_points = excluded.hn_points, ai_first_pick = excluded.ai_first_pick, ai_named = excluded.ai_named;\n\n" \
  + "delete from public.case_queries where id = 'rivals';\n" + register([
    ("rivals", "taglines", 3,
     "select product, database_layer, github_stars, hn_100_stories,\n       ai_first_pick || ' of 150' as claude_first_pick,\n       product = 'Supabase' as _hot\nfrom rivals order by sort;",
     [C("product", "text", "bold"), C("database_layer", "text"), C("github_stars", "int4", "compact"), C("hn_100_stories", "int4", "big"), C("claude_first_pick", "text", "mono")],
     "Collected 20 Oct 2026: GitHub API, Hacker News (Algolia), our AI study, project READMEs", {"bar": "hn_100_stories"}),
]) + "\n-- Lovable's form test left one fake signup; remove only that row.\ndelete from public.subscribers where email = 'qa+teardown-check@example.com';\n"


def main():
    MIG.mkdir(parents=True, exist_ok=True)
    for name, sql in FILES.items():
        header = f"-- {name}\n-- Supabase Schema Teardown. Generated by tools/build_sql.py; edit there, not here.\n\n"
        (MIG / name).write_text(header + sql)
        print(f"wrote supabase/migrations/{name} ({len(sql):,} chars)")

    # One file to paste into the Supabase SQL Editor (same SQL as the migrations, in order).
    allsql = "-- Paste into Supabase > SQL Editor and run once. Same SQL as supabase/migrations/*, in order.\n\n" + "\n".join((MIG / n).read_text() for n in FILES)
    (ROOT / "supabase" / "ALL-MIGRATIONS.sql").write_text(allsql)
    print(f"wrote supabase/ALL-MIGRATIONS.sql ({len(allsql):,} chars)")

    # Browser console bundle: the same migrations, preceded by tiny stand-ins for Supabase's
    # auth schema and roles, so PGlite (Postgres in the browser) can load an identical copy.
    stub = """-- Loaded into PGlite in the reader's browser. Same migrations as the live Supabase project.
create role anon; create role authenticated;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
"""
    bundle = stub + "\n".join((MIG / n).read_text() for n in FILES)
    out = ROOT / "public" / "console" / "case-study.sql"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(bundle)
    print(f"wrote public/console/case-study.sql ({len(bundle):,} chars)")


if __name__ == "__main__":
    main()
