import { loadEnv } from "../scripts/load-env";
loadEnv();
process.env.APP_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://wakeel:wakeel@localhost:5432/wakeel_test";
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_LOCAL_DIR = ".data/test-objects";
process.env.MAIL_DRIVER = "dev";
process.env.SCANNER_DRIVER = "dev";
process.env.APR_CALCULATOR = "altbank-apr-2024@1.0";
