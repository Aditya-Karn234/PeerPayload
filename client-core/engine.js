const { spawn } = require("child_process");
const readline = require("readline");
const { EventEmitter } = require("events");

// Spawns sender.exe/receiver.exe and re-emits its stdout as parsed JSON
// 'event' objects — that newline-delimited stream is the entire contract
// with the engine (see shared/include/json_event.hpp on the C++ side).
// stderr is forwarded as raw 'log' lines for a human to read; it is never
// parsed, since it isn't part of the machine-readable contract.
//
// Identical to backend/src/engineRunner.js's spawnEngineProcess — this is
// the client-side copy so the CLI and desktop app share one implementation
// of "how to run the engine and read its events," same as they share one
// apiClient for talking to the backend.
function spawnEngineProcess(exePath, args) {
  const child = spawn(exePath, args, { windowsHide: true });
  const emitter = new EventEmitter();

  emitter.pid = child.pid;
  emitter.exited = false;

  const stdoutReader = readline.createInterface({ input: child.stdout });

  stdoutReader.on("line", (line) => {
    const trimmed = line.trim();

    if (!trimmed)
      return;

    let parsed;

    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      emitter.emit("log", `[unparsed stdout] ${line}`);
      return;
    }

    emitter.emit("event", parsed);
  });

  const stderrReader = readline.createInterface({ input: child.stderr });

  stderrReader.on("line", (line) => {
    emitter.emit("log", line);
  });

  child.on("exit", (code, signal) => {
    emitter.exited = true;
    emitter.emit("exit", { code, signal });
  });

  child.on("error", (err) => {
    emitter.exited = true;
    emitter.emit("error", err);
  });

  emitter.kill = () => {
    if (!emitter.exited)
      child.kill();
  };

  return emitter;
}

module.exports = { spawnEngineProcess };
