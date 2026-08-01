const { api, tokenStore } = require("../client");
const { ACTIVE_STATUSES, formatTransferLine, printJson } = require("../output");

async function statusCommand(options) {
  try {
    const stored = tokenStore.get();

    if (!stored) {
      if (options.json)
        printJson({ error: "not logged in" });
      else
        console.error("Not logged in. Run `peerpayload login` first.");

      process.exitCode = 1;
      return;
    }

    const transfers = await api.listTransfers();
    const active = transfers.filter((t) => ACTIVE_STATUSES.has(t.status));

    if (options.json) {
      printJson(active);
      return;
    }

    if (active.length === 0) {
      console.log("No active transfers.");
      return;
    }

    for (const t of active)
      console.log(formatTransferLine(t, stored.username));
  } catch (err) {
    if (options.json)
      printJson({ error: err.message });
    else
      console.error(`status failed: ${err.message}`);

    process.exitCode = 1;
  }
}

module.exports = { statusCommand };
