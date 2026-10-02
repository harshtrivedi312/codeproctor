// The only place that constructs a Prisma client (ADR 0009 section 4.2). Prisma 7 needs a driver
// adapter. Callers pass the connection string: the API passes DATABASE_URL (app_user), the seed
// passes the URL its own guard has checked. Never log the connection string.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
