import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default function globalSetup() {
  const backendDir = path.resolve(__dirname, '../../backend');

  // Load backend .env so Prisma can find DATABASE_URL (worktree path resolution fix)
  const envPath = path.join(backendDir, '.env');
  const envVars: Record<string, string> = { ...process.env } as Record<string, string>;
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        envVars[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }

  execSync('npx tsx prisma/seed.ts', { cwd: backendDir, stdio: 'inherit', env: envVars });
}
