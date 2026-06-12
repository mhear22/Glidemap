import { spawn, type ChildProcess } from "node:child_process";

interface DevProcess {
  name: string;
  command: string;
  args: string[];
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const childProcesses = new Set<ChildProcess>();
let shuttingDown = false;

const apiPort = process.env["MAPANIM_API_PORT"] ?? "4822";
const webappPort = process.env["MAPANIM_WEBAPP_PORT"] ?? "5173";
const adminPort = process.env["MAPANIM_ADMIN_PORT"] ?? "5174";

const processes: DevProcess[] = [
  {
    name: "server",
    command: npmCommand,
    args: ["run", "dev:server"]
  },
  {
    name: "webapp",
    command: npmCommand,
    args: ["run", "dev:webapp"]
  },
  {
    name: "admin",
    command: npmCommand,
    args: ["run", "dev:admin"]
  }
];

function stopChildren(signal: NodeJS.Signals = "SIGTERM"): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const child of childProcesses) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

function maybeExit(): void {
  if (shuttingDown && childProcesses.size === 0) {
    process.exit(process.exitCode ?? 0);
  }
}

function spawnProcess(config: DevProcess): ChildProcess {
  const child = spawn(config.command, config.args, {
    stdio: "inherit",
    env: {
      ...process.env,
      MAPANIM_API_PORT: apiPort,
      MAPANIM_WEBAPP_PORT: webappPort,
      MAPANIM_ADMIN_PORT: adminPort
    }
  });

  childProcesses.add(child);
  child.on("exit", (code, signal) => {
    childProcesses.delete(child);

    if (shuttingDown) {
      maybeExit();
      return;
    }

    if (signal || code !== 0) {
      console.error(`Dev process "${config.name}" exited unexpectedly.`);
      stopChildren();
      process.exitCode = code ?? 1;
      maybeExit();
    }
  });

  return child;
}

process.on("SIGINT", () => {
  process.exitCode = 0;
  stopChildren("SIGINT");
  maybeExit();
});

process.on("SIGTERM", () => {
  process.exitCode = 0;
  stopChildren("SIGTERM");
  maybeExit();
});

console.log(`Starting MapAnim dev services on api:${apiPort}, main:${webappPort}, admin:${adminPort}`);

for (const processConfig of processes) {
  spawnProcess(processConfig);
}
