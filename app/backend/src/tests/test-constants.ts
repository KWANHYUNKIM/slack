if (!process.env.SEED_PASSWORD) {
  throw new Error('Missing SEED_PASSWORD in environment. Check your .env file.');
}
export const TEST_PASSWORD = process.env.SEED_PASSWORD;
