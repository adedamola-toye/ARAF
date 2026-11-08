import { loadEnv } from "./load-env";
loadEnv();
import { migrate } from "../src/server/migrate";

const reset = process.argv.includes("--reset");
if (reset && process.env.APP_ENV === "production") {
  console.error("Refusing to reset a production database.");
  process.exit(1);
}
migrate(process.env.DATABASE_URL!, { reset, log: true })
  .then(() => console.log(reset ? "Database reset and migrated." : "Migrations up to date."))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
