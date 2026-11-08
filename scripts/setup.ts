import { copyFileSync, existsSync } from "node:fs";
import { Client } from "pg";

/**
 * One-time local setup (development, synthetic data only):
 *   1. creates .env from .env.example if missing
 *   2. waits for PostgreSQL (docker compose up -d postgres)
 *   3. resets, migrates and seeds the development database
 */
async function main() {
  if (!existsSync(".env")) {
    copyFileSync(".env.example", ".env");
    console.log("Created .env from .env.example");
  }
  const { loadEnv } = await import("./load-env");
  loadEnv();
  const url = process.env.DATABASE_URL!;
  for (let i = 1; ; i++) {
    const c = new Client({ connectionString: url });
    try {
      await c.connect();
      await c.end();
      break;
    } catch {
      if (i === 30) {
        console.error("\nCould not reach PostgreSQL at", url.replace(/:[^:@/]+@/, ":***@"));
        console.error("Start it with:  docker compose up -d postgres   (and make sure Docker Desktop is running)\n");
        process.exit(1);
      }
      if (i === 1) console.log("Waiting for PostgreSQL…");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const { migrate } = await import("../src/server/migrate");
  await migrate(url, { reset: true, log: true });
  console.log("Database ready. Seeding synthetic data…");
  await import("./seed");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
