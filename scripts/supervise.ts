/**
 * Supervisor do worker: religa o processo automaticamente se ele encerrar com erro
 * (queda de rede, falha inesperada). Backoff de 5 s até 2 min; zera após 10 min estável.
 *   npm run worker -- --unit carros-online
 * Ctrl+C encerra o supervisor e o worker.
 */
import { spawn, type ChildProcess } from "node:child_process";

const args = process.argv.slice(2);
let child: ChildProcess | null = null;
let stopping = false;
let failures = 0;

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", svc: "supervisor", msg, ...extra }));

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, ["--env-file=.env.local", "src/worker/main.ts", ...args], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return process.exit(0);
    if (Date.now() - startedAt > 10 * 60_000) failures = 0;
    failures++;
    const wait = Math.min(120_000, 5_000 * 2 ** (failures - 1));
    log("worker encerrou; religando", { code, signal, failures, retryInMs: wait });
    setTimeout(start, wait);
  });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { stopping = true; log("encerrando"); child ? child.kill(sig) : process.exit(0); });
}

log("supervisor iniciado", { args });
start();
