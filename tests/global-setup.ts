import { loadEnv } from "../scripts/load-env";
import { migrate } from "../src/server/migrate";

export default async function setup() {
  loadEnv();
  const url = process.env.TEST_DATABASE_URL ?? "postgres://wakeel:wakeel@localhost:5432/wakeel_test";
  await migrate(url, { reset: true });
}
