import { PrismaClient } from '@prisma/client';

// Add connection pool limits if not already specified in DATABASE_URL
const dbUrl = process.env.DATABASE_URL;
const poolUrl = dbUrl && !dbUrl.includes('connection_limit')
  ? `${dbUrl}${dbUrl.includes('?') ? '&' : '?'}connection_limit=10&pool_timeout=10`
  : dbUrl;

const prisma = new PrismaClient({
  ...(poolUrl && { datasourceUrl: poolUrl }),
});

export default prisma;
