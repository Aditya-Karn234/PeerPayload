const { api, tokenStore } = require("../client");
const { formatTransferLine, printJson } = require("../output");

async function historyCommand(options) {
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

    if (options.json) {
      printJson(transfers);
      return;
    }

    if (transfers.length === 0) {
      console.log("No transfers yet.");
      return;
    }

    for (const t of transfers)
      console.log(formatTransferLine(t, stored.username));
  } catch (err) {
    if (options.json)
      printJson({ error: err.message });
    else
      console.error(`history failed: ${err.message}`);

    process.exitCode = 1;
  }
}

module.exports = { historyCommand };
