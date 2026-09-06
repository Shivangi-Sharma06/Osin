# OSIN — OSINT Confidence-Scoring Tool

Full-stack OSINT correlation tool. Every result carries a **confidence score + reasoning
breakdown** — raw collector output is never shown to the user unscored.

- Relational Postgres only (no graph database; graph shape is derived on demand via recursive CTEs)
- Redis + BullMQ job queue (async, never blocking)
- Rate-limited, individually togglable collectors
- No login-wall bypass / anti-bot evasion anywhere

## Layout

```
server/   Node + TypeScript + Fastify API, worker, scoring engine, collectors
web/      Vite + React dashboard (added in Task 5)
```

## Local infrastructure (no root required)

Postgres 18 user-space cluster on port 5433:

```bash
mkdir -p ~/.local/share/osin
initdb -D ~/.local/share/osin/pg -U osin --auth=trust --no-locale --encoding=UTF8
pg_ctl -D ~/.local/share/osin/pg -o "-p 5433 -c listen_addresses=127.0.0.1" -l ~/.local/share/osin/pg-server.log start
createdb -h 127.0.0.1 -p 5433 -U osin osin
```

Redis (built from source into ~/.local/share/osin/redis/bin):

```bash
~/.local/share/osin/redis/bin/redis-server --port 6379 --daemonize yes --dir /tmp
```

## Setup

```bash
cp .env.example .env    # adjust if needed (GITHUB_TOKEN recommended for real rate limits)
npm install
npm run db:migrate      # applies server/migrations/*.sql
npm run db:verify       # inserts+queries a dummy row in every table, then rolls back
npm run dev:server      # API on http://127.0.0.1:4000
npm test                # scoring engine unit tests
```
