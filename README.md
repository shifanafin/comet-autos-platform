# Comet Autos

Workshop Management System for Comet Autos (Al Qusais, Dubai) — a dedicated
internal application for one workshop, not a multi-tenant SaaS platform.

See [PROJECT-STATUS.md](./PROJECT-STATUS.md) for what has been built so far
and [docs/08-architecture/architecture-principles.md](./docs/08-architecture/architecture-principles.md)
for the architectural rules this codebase follows.



## Architecture

```
Browser → Next.js (Server Components / Server Actions / Route Handlers) → Prisma → PostgreSQL
```

One deployable application. Prisma is called directly from Server
Actions/Route Handlers — there is no separate API layer. See
[ADR-008](./docs/11-decisions/ADR-008-single-nextjs-application.md).

- **src/** — the Next.js application: UI, Server Actions, Route Handlers,
  and business logic (`src/lib/`).
- **prisma/** — Prisma schema (source of truth for the database) and
  migrations.
- **docs/** — business, architecture, and decision documentation.

## Prerequisites

- Node.js >= 20
- npm >= 10
- A PostgreSQL database (local or cloud) — see below for a local option

## Getting started

```bash
npm install
```

Copy the environment template and fill in real values:

```bash
cp .env.example .env
```

`.env` is read by both the Next.js server runtime and the Prisma CLI. Never
commit it.

### Local PostgreSQL

If you don't already have PostgreSQL running locally, start the bundled
development instance (a real native Postgres binary, not a system install):

```bash
npm run db:start
```

Leave this running in its own terminal. It listens on `localhost:5433` and
creates the `comet_autos_dev` database automatically. Data persists under
`.local-postgres-data/` (gitignored) between restarts. Stop it with
`npm run db:stop` (or Ctrl+C in its terminal). This is local-development-only
tooling — production environments use a real managed PostgreSQL instance.

If you have your own PostgreSQL (local install, Docker, or cloud), just point
`DATABASE_URL` in `.env` at it instead and skip this step.

Generate the Prisma Client:

```bash
npm run prisma:generate
```

### Run the app

```bash
npm run dev
```

Runs on `http://localhost:3000`. This starts the local Postgres instance (if
nothing is already listening on port 5433) and the Next.js dev server
together; use `npm run dev:web` to start only the Next.js dev server.

## Other scripts

| Script                     | Description                                  |
| -------------------------- | --------------------------------------------- |
| `npm run build`            | Production build                              |
| `npm run start`            | Run the production build                      |
| `npm run lint`              | Lint the app                                  |
| `npm run format` / `format:check` | Prettier across the whole repo         |
| `npm run prisma:validate`  | Validate `prisma/schema.prisma`               |
| `npm run prisma:migrate`   | Run Prisma migrations in dev                  |
| `npm run db:seed`          | Seed the database (`prisma/seed.ts`)          |
| `npm run db:start` / `db:stop` | Local embedded PostgreSQL (dev only)      |

## Environment variables

See `.env.example`. Never commit `.env` or any file containing real
credentials.
