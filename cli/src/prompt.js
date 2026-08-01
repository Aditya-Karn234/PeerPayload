const readline = require("readline");

function promptText(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// No masked-input library dependency — a password typed at a CLI prompt is
// common enough to warrant not echoing it, so this does the minimal raw-mode
// version by hand: read bytes directly, print nothing back, resolve on
// Enter. Falls back to a plain (echoed) prompt if stdin isn't a TTY (e.g.
// piped input in a test/CI context), since raw mode requires one.
function promptPassword(question) {
  if (!process.stdin.isTTY)
    return promptText(question);

  return new Promise((resolve) => {
    process.stdout.write(question);

    const chars = [];

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    function onData(char) {
      if (char === "\r" || char === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(chars.join(""));
      } else if (char === "") {
        // Ctrl+C
        process.stdout.write("\n");
        process.exit(130);
      } else if (char === "" || char === "\b") {
        chars.pop();
      } else {
        chars.push(char);
      }
    }

    process.stdin.on("data", onData);
  });
}

module.exports = { promptText, promptPassword };
