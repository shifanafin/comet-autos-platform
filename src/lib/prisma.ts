import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';

// Standard Next.js dev-mode singleton guard: without this, every hot reload
// would open a new pool of Postgres connections against the same process.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL ?? throwMissingDatabaseUrl(),
  });
  return new PrismaClient({
    adapter,
    // Every money change is booked to the ledger in the same transaction as
    // the change itself (lib/accounting/journal.ts), so a sale paid on the
    // spot is one transaction of a few dozen queries. Against a hosted
    // database each query is a network round-trip; Prisma's default of 5 s
    // is too tight for that. A transaction still can't run away: 20 s, and
    // no more than 10 s waiting for a connection. PRISMA_TRANSACTION_TIMEOUT_MS
    // lengthens it where the database is far away — the integration tests run
    // from a laptop, every query a round-trip to another country.
    transactionOptions: { timeout: transactionTimeout(), maxWait: 10_000 },
  });
}

/** 20 s, or PRISMA_TRANSACTION_TIMEOUT_MS when set (never less, never over 2 minutes). */
function transactionTimeout() {
  const wanted = Number(process.env.PRISMA_TRANSACTION_TIMEOUT_MS);
  return Number.isFinite(wanted) && wanted > 20_000 ? Math.min(wanted, 120_000) : 20_000;
}

function throwMissingDatabaseUrl(): never {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill in real values.');
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
