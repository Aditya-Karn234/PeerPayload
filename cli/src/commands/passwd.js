const { api } = require("../client");
const { promptPassword } = require("../prompt");
const { printJson } = require("../output");

// Changes your own password. Prompts only: a password on the command line
// would end up in shell history. Other signed-in devices are signed out;
// this CLI session stays.
async function passwdCommand(options) {
  const current = await promptPassword("Current password: ");
  const next = await promptPassword("New password (at least 8 characters): ");
  const again = await promptPassword("New password again: ");

  const fail = (message) => {
    if (options.json)
      printJson({ ok: false, error: message });
    else
      console.error(`Password not changed: ${message}`);

    process.exitCode = 1;
  };

  if (next !== again)
    return fail("the new passwords don't match");

  try {
    await api.changePassword(current, next);

    if (options.json)
      printJson({ ok: true });
    else
      console.log("Password changed. Your other signed-in devices have been signed out.");
  } catch (err) {
    fail(err.message);
  }
}

module.exports = { passwdCommand };
