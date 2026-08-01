const { api } = require("../client");
const { promptText, promptPassword } = require("../prompt");
const { printJson } = require("../output");

async function loginCommand(options) {
  const username = options.username || (await promptText("Username: "));
  const password = options.password || (await promptPassword("Password: "));

  try {
    const user = await api.login(username, password);

    if (options.json)
      printJson({ ok: true, username: user.username, role: user.role });
    else
      console.log(`Logged in as ${user.username} (${user.role}).`);
  } catch (err) {
    if (options.json)
      printJson({ ok: false, error: err.message });
    else
      console.error(`Login failed: ${err.message}`);

    process.exitCode = 1;
  }
}

module.exports = { loginCommand };
