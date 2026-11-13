import { loadEnv } from "../scripts/load-env";
loadEnv();
process.env.APP_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://wakeel:wakeel@localhost:5432/wakeel_test";
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_LOCAL_DIR = ".data/test-objects";
process.env.MAIL_DRIVER = "dev";
process.env.SCANNER_DRIVER = "dev";
process.env.APR_CALCULATOR = "wakeelboost-pricing@2026.1";
process.env.OFFER_PDF_CONVERTER = "none";
// Tests never call live providers, whatever the local .env holds; they substitute test doubles instead.
process.env.SEEDFI_ENABLED = "false";
process.env.SEEDFI_API_KEY = "";
process.env.PAYSTACK_ENABLED = "false";
process.env.PAYSTACK_SECRET_KEY = "";
process.env.PAYSTACK_TEST_MODE = "false";
process.env.PAYSTACK_DIRECT_DEBIT_ENABLED = "false";
