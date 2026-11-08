import { loadEnv } from "./load-env";
loadEnv();
import { workerTick } from "../src/server/jobs/worker";
import { closePool } from "../src/server/db";
import { config } from "../src/server/config";

/**
 * Durable background worker. All state (outbox, schedule runs, digest deliveries, quarantine)
 * lives in PostgreSQL, so restarts resume safely and several workers may run concurrently.
 * Background work never touches user sessions, so it cannot reset inactivity timers.
 */
let stopping = false;
async function main() {
  console.log(`[worker] started (poll ${config.workerPollMs}ms, env ${config.appEnv})`);
  while (!stopping) {
    try {
      const r = await workerTick(new Date());
      const o = r.outbox as { sent: number; failed: number };
      if (o.sent || o.failed) console.log(`[worker] outbox sent=${o.sent} failed=${o.failed}`);
      const w = r.weekly as { ran: boolean; sent: number; period: string };
      if (w.ran) console.log(`[worker] weekly digest ${w.period}: ${w.sent} email(s)`);
      const m = r.monthly as { ran: boolean; sent: number; period: string };
      if (m.ran) console.log(`[worker] monthly report ${m.period}: ${m.sent} email(s)`);
    } catch (e) {
      console.error("[worker] tick failed", e);
    }
    await new Promise((res) => setTimeout(res, config.workerPollMs));
  }
  await closePool();
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (stopping = true));
main();
