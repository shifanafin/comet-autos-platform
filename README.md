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

### Database

The app connects straight to the hosted PostgreSQL (Supabase) named in
`.env` — there is no local database. `DATABASE_URL` is the pooled
connection the app uses; `DIRECT_URL` is the direct one the Prisma CLI uses
for migrations.

Apply any new migrations to the hosted database before deploying code that
needs them:

```bash
npm run prisma:deploy
```

This only applies migrations that haven't run yet, in order, and never
resets data. Don't point `npm run prisma:migrate` (`prisma migrate dev`)
at a database with real data: when it finds drift it offers to reset the
database.

Generate the Prisma Client:

```bash
npm run prisma:generate
```

### Run the app

```bash
npm run dev
```

Runs on `http://localhost:3000`, against the hosted database in `.env`.

### Tests

`npm run test:integration` runs against the database in `.env`, creating
its own test organizations there. Run it against a separate test database
(for example a second Supabase project), never the live one.

## Other scripts

| Script                     | Description                                  |
| -------------------------- | --------------------------------------------- |
| `npm run build`            | Production build                              |
| `npm run start`            | Run the production build                      |
| `npm run lint`              | Lint the app                                  |
| `npm run format` / `format:check` | Prettier across the whole repo         |
| `npm run prisma:validate`  | Validate `prisma/schema.prisma`               |
| `npm run prisma:deploy`    | Apply pending migrations (safe on live data)  |
| `npm run prisma:migrate`   | Create a new migration (development only)     |
| `npm run db:seed`          | Seed the database (`prisma/seed.ts`)          |

## Environment variables

See `.env.example`. Never commit `.env` or any file containing real
credentials.
