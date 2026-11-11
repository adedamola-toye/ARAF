import { spawn } from "node:child_process";

/** Runs the Next.js dev server and the background worker together (Windows, macOS, Linux). */
const shell = process.platform === "win32";
const procs = [
  spawn("npx", ["next", "dev", "-p", "3000"], { stdio: "inherit", shell }),
  spawn("npx", ["tsx", "scripts/worker.ts"], { stdio: "inherit", shell }),
];
const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
procs.forEach((p) => p.on("exit", (code) => code && stop()));
console.log("\nRetail Asset Factory is starting at http://localhost:3000 (press Ctrl+C to stop)\n");
