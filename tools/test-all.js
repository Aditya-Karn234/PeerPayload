#!/usr/bin/env node
// One command for every automated test in the repo: builds the engine,
// installs what the test suites need, runs each suite and prints a summary.
// Exit code is non-zero if anything failed. Used locally (`npm test` at the
// root) and by CI (.github/workflows/test.yml).
//
//   node tools/test-all.js                  build + all suites
//   node tools/test-all.js --no-build       use the existing build/
//   node tools/test-all.js --only relay,connect-core
//   node tools/test-all.js --ui             also the opt-in UI suites
//   node tools/test-all.js --list           suite names
//
// No dependencies of its own. Adding a suite = one line in SUITES.
// optIn suites (real app windows: need a display, and Electron's download)
// run only with --ui or when named in --only.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const win = process.platform === "win32";
const exe = win ? ".exe" : "";
const buildDir = path.join(root, "build");

// Packages whose node_modules the suites load (directly, or through
// require() of another package's source).
const NODE_PACKAGES = ["client-core", "relay", "connect/core", "connect/mailbox"];

// A hung test fails with its name after this long instead of stalling
// the whole run (CI would otherwise sit until the job timeout).
const TEST_TIMEOUT = "--test-timeout=120000";

const SUITES = [
  { name: "engine-lib", cwd: ".", cmd: [path.join(buildDir, "engine", `engine_lib_test${exe}`)] },
  { name: "engine", cwd: ".", cmd: ["node", "--test", TEST_TIMEOUT, "tests/engine/*.test.js"] },
  { name: "protocol", cwd: "protocol", cmd: ["node", "--test", TEST_TIMEOUT, "test/*.test.js"] },
  { name: "relay", cwd: "relay", cmd: ["node", "--test", TEST_TIMEOUT, "test/*.test.js"] },
  { name: "connect-mailbox", cwd: "connect/mailbox", cmd: ["node", "--test", TEST_TIMEOUT, "test/*.test.js"] },
  { name: "connect-core", cwd: "connect/core", cmd: ["node", "--test", TEST_TIMEOUT, "test/*.test.js"] },
  { name: "connect-desktop-ui", cwd: "connect/desktop", cmd: "npm run test:ui", optIn: true, packages: ["connect/desktop"] },
];

function parseArgs(argv) {
  const opts = { build: true, only: null, list: false, ui: false };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--no-build") opts.build = false;
    else if (argv[i] === "--list") opts.list = true;
    else if (argv[i] === "--ui") opts.ui = true;
    else if (argv[i] === "--only") opts.only = (argv[++i] || "").split(",").filter(Boolean);
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }

  return opts;
}

// MinGW's bin must be on PATH on Windows, for both the compiler (gcc fails
// silently without it) and the test binaries. MINGW_BIN overrides.
function withToolchainPath(env) {
  if (!win)
    return env;

  const mingw = env.MINGW_BIN || "C:\\msys64\\mingw64\\bin";
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";

  return fs.existsSync(mingw) ? { ...env, [key]: `${mingw};${env[key] || ""}` } : env;
}

const env = withToolchainPath({ ...process.env });

// cmd: [file, ...args], or one command line (run through the shell).
function run(cmd, cwd) {
  const options = { cwd: path.join(root, cwd), env, stdio: "inherit" };
  const res = typeof cmd === "string" ? spawnSync(cmd, { ...options, shell: true }) : spawnSync(cmd[0], cmd.slice(1), options);

  if (res.error)
    console.error(`could not run ${[].concat(cmd)[0]}: ${res.error.message}`);

  return res.status ?? 1;
}

function step(title) {
  console.log(`\n=== ${title} ${"=".repeat(Math.max(0, 70 - title.length))}`);
}

function buildEngine() {
  step("build engine");

  if (!fs.existsSync(path.join(buildDir, "CMakeCache.txt"))) {
    const generator = env.CMAKE_GENERATOR || (win ? "MinGW Makefiles" : null);
    const configure = ["cmake", "-S", ".", "-B", "build", ...(generator ? ["-G", generator] : [])];

    if (run(configure, ".") !== 0)
      return false;
  }

  return run(["cmake", "--build", "build", "--parallel", String(os.availableParallelism?.() || os.cpus().length)], ".") === 0;
}

// Installed, and not older than the lockfile (npm records what it
// installed in node_modules/.package-lock.json).
function depsUpToDate(pkg) {
  try {
    return fs.statSync(path.join(root, pkg, "node_modules", ".package-lock.json")).mtimeMs >= fs.statSync(path.join(root, pkg, "package-lock.json")).mtimeMs;
  } catch {
    return false;
  }
}

function installNodeDeps(packages) {
  for (const pkg of packages) {
    if (depsUpToDate(pkg))
      continue;

    step(`npm ci (${pkg})`);

    // A command line, not [file, args]: npm is npm.cmd on Windows, which
    // only runs through a shell.
    if (run("npm ci --no-audit --no-fund", pkg) !== 0)
      return false;
  }

  return true;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.list) {
    for (const s of SUITES) console.log(`${s.name}${s.optIn ? " (opt-in)" : ""}`);
    return 0;
  }

  const unknown = (opts.only || []).filter((n) => !SUITES.some((s) => s.name === n));

  if (unknown.length) {
    console.error(`unknown suite(s): ${unknown.join(", ")} (see --list)`);
    return 2;
  }

  const selected = SUITES.filter((s) => (opts.only ? opts.only.includes(s.name) : !s.optIn || opts.ui));

  if (opts.build && !buildEngine()) {
    console.error("\nengine build failed");
    return 1;
  }

  if (!installNodeDeps([...NODE_PACKAGES, ...selected.flatMap((s) => s.packages ?? [])])) {
    console.error("\nnpm ci failed");
    return 1;
  }

  const results = [];

  for (const suite of selected) {
    step(suite.name);

    const started = Date.now();
    const code = run(suite.cmd, suite.cwd);

    results.push({ name: suite.name, ok: code === 0, seconds: ((Date.now() - started) / 1000).toFixed(1) });
  }

  step("summary");

  for (const r of results)
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(18)} ${r.seconds}s`);

  const failed = results.filter((r) => !r.ok);

  console.log(failed.length ? `\n${failed.length} suite(s) failed` : "\nall suites passed");

  return failed.length ? 1 : 0;
}

process.exitCode = main();
