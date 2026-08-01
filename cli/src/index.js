#!/usr/bin/env node

const { Command } = require("commander");

const { loginCommand } = require("./commands/login");
const { sendCommand } = require("./commands/send");
const { statusCommand } = require("./commands/status");
const { historyCommand } = require("./commands/history");

const program = new Command();

program
  .name("peerpayload")
  .description("Send files directly to a colleague's machine — auth/presence through the org backend, the transfer itself stays direct between the two of you.");

program
  .command("login")
  .description("log in and store a session token locally")
  .option("-u, --username <username>")
  .option("-p, --password <password>")
  .option("--json", "machine-readable output")
  .action(loginCommand);

program
  .command("send")
  .description("send a file or folder to a colleague")
  .argument("<path>", "file or directory to send")
  .requiredOption("--to <username>", "recipient username")
  .option("--chunk-size <bytes>", "engine chunk size in bytes (4096-8388608)")
  .option("--json", "machine-readable output")
  .action(sendCommand);

program
  .command("status")
  .description("show your active (pending/accepted/in-progress) transfers")
  .option("--json", "machine-readable output")
  .action(statusCommand);

program
  .command("history")
  .description("show all of your transfers")
  .option("--json", "machine-readable output")
  .action(historyCommand);

program.parse();
