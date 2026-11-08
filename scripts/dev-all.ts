import { spawn } from "node:child_process";

/** Runs the Next.js dev server and the background worker together for local development. */
const procs = [
  spawn("npx", ["next", "dev", "-p", "3000"], { stdio: "inherit" }),
  spawn("npx", ["tsx", "scripts/worker.ts"], { stdio: "inherit" }),
];
const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
procs.forEach((p) => p.on("exit", (code) => code && stop()));
