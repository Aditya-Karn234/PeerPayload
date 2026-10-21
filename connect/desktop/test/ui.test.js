const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");

const { createMailbox } = require("../../mailbox/src/server");

// Drives two real Connect app windows (Alice and Bob) end to end: first-run
// setup, settings, invite link, pairing, safety codes, a file transfer and
// a declined one. Needs `npm run build` first (tests the built out/), the
// engine built, and a display.

const APP = path.resolve(__dirname, "..");
const ELECTRON = require(path.join(APP, "node_modules", "electron"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-connect-ui-"));
const shots = process.env.SCREENSHOT_DIR;

let mailbox, mailboxUrl;
const apps = [];

before(async () => {
  assert.ok(fs.existsSync(path.join(APP, "out", "main", "index.js")), "run `npm run build` first");
  mailbox = createMailbox({ log: { warn() {} } });
  mailboxUrl = `http://127.0.0.1:${await mailbox.listen(0, "127.0.0.1")}`;
});

after(async () => {
  for (const app of apps) {
    try {
      // The window closing quits the app; kill as a fallback.
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]);
    } catch {}
    try {
      process.platform === "win32" ? execSync(`taskkill /PID ${app.__pid} /T /F`, { stdio: "ignore" }) : process.kill(app.__pid);
    } catch {}
  }
  await mailbox.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// Each instance gets its own profile: identity/contacts/settings
// (CONNECT_USER_DATA) and a home directory, so received files land in
// <profile>/home/Downloads/PeerPayload and nothing touches the real user's.
async function launch(name, env = {}) {
  const profile = path.join(tmp, name);
  const home = path.join(profile, "home");
  fs.mkdirSync(path.join(home, "Downloads"), { recursive: true });

  const fullEnv = {
    // Inherited from editors' terminals; it makes Electron run as plain Node.
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "ELECTRON_RUN_AS_NODE" && !k.startsWith("PEERPAYLOAD_"))),
    CONNECT_USER_DATA: path.join(profile, "userdata"),
    HOME: home,
    USERPROFILE: home,
    ...env,
  };
  const app = await electron.launch({
    executablePath: ELECTRON,
    // --disable-gpu: the GPU process can fail to start on test machines.
    args: [APP, "--disable-gpu"],
    cwd: APP,
    env: fullEnv,
    timeout: 60000,
  });

  app.__pid = app.process().pid;
  apps.push(app);

  const page = await app.firstWindow();

  return { app, page, home, name, env: fullEnv };
}

// The native file picker can't be clicked by a test: make it return these paths.
const pickWillReturn = (app, paths) =>
  app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
  }, paths);

async function shot(page, name) {
  if (shots)
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}

async function setUp(page, name) {
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Create my device identity" }).click();
  await page.getByRole("heading", { name: "PeerPayload Connect" }).waitFor();
}

const tab = (page, name) => page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: new RegExp(`^${name}`) }).click();

test("ui: two devices pair with an invite link and send a file", { timeout: 180000 }, async () => {
  const alice = await launch("alice");
  const bob = await launch("bob", { PEERPAYLOAD_MAILBOX: mailboxUrl });

  // First run.
  await alice.page.getByRole("heading", { name: "Welcome to PeerPayload Connect" }).waitFor();
  await shot(alice.page, "1-setup");
  await setUp(alice.page, "Alice");
  await setUp(bob.page, "Bob");

  // Alice has no mailbox yet: invites are disabled until she sets one.
  await alice.page.getByTestId("connection").getByText("No mailbox set").waitFor();
  assert.equal(await alice.page.getByRole("button", { name: "Create invite link" }).isDisabled(), true);

  await tab(alice.page, "Settings");
  await alice.page.getByLabel("Mailbox").fill("ftp://nope");
  await alice.page.getByRole("button", { name: "Save" }).click();
  await alice.page.getByRole("alert").getByText("must start with http").waitFor();
  await alice.page.getByLabel("Mailbox").fill(mailboxUrl);
  await alice.page.getByRole("button", { name: "Save" }).click();
  await alice.page.getByRole("status").getByText("Saved").waitFor();
  await alice.page.getByTestId("connection").getByText("Connected").waitFor();
  await bob.page.getByTestId("connection").getByText("Connected").waitFor();

  // Alice invites; Bob pastes the link.
  await tab(alice.page, "Contacts");
  await alice.page.getByRole("button", { name: "Create invite link" }).click();
  await alice.page.getByRole("img", { name: "QR code of the invite link" }).waitFor();
  const link = await alice.page.getByTestId("invite-link").inputValue();
  assert.match(link, /^peerpayload:\/\/pair#/);
  await shot(alice.page, "2-invite");

  await bob.page.getByLabel("Invite link").fill(link);
  await bob.page.getByRole("button", { name: "Add contact" }).click();
  await bob.page.getByTestId("contact-Alice").getByText(/^Paired/).waitFor({ timeout: 15000 });
  await alice.page.getByText("You and Bob are now paired.").waitFor();
  await alice.page.getByTestId("contact-Bob").getByText(/^Paired/).waitFor();

  // Both sides show the same safety code.
  const code = async (page, who) => {
    const row = page.getByTestId(`contact-${who}`);
    await row.getByRole("button", { name: "Safety code" }).click();
    return row.locator("p.font-mono").innerText();
  };
  const aliceCode = await code(alice.page, "Bob");
  assert.match(aliceCode, /^\d{5}( \d{5}){5}$/);
  assert.equal(await code(bob.page, "Alice"), aliceCode);
  await shot(bob.page, "3-paired");

  // Bob sends Alice a file; she accepts.
  const file = path.join(tmp, "holiday.jpg");
  fs.writeFileSync(file, crypto.randomBytes(2_500_000));
  await pickWillReturn(bob.app, [file]);
  await bob.page.getByTestId("contact-Alice").getByRole("button", { name: "Send files" }).click();
  await bob.page.getByTestId("transfer-out").getByText("Waiting for Alice to accept").waitFor();

  const offer = alice.page.getByRole("region", { name: "Offer from Bob" });
  await offer.getByText("Bob wants to send you “holiday.jpg” (2.4 MB)").waitFor();
  await shot(alice.page, "4-offer");
  await offer.getByRole("button", { name: "Accept" }).click();

  await alice.page.locator('[data-testid="transfer-in"][data-state="complete"]').waitFor({ timeout: 30000 });
  await bob.page.locator('[data-testid="transfer-out"][data-state="complete"]').waitFor({ timeout: 30000 });
  const received = path.join(alice.home, "Downloads", "PeerPayload", "holiday.jpg");
  assert.ok(fs.readFileSync(received).equals(fs.readFileSync(file)), "received file is identical");
  await alice.page.getByText(/^Saved to /).waitFor();
  await shot(alice.page, "5-received");

  // Background receiving: Alice closes her window; the app stays in the
  // tray, gets Bob's next offer and says so with a notification.
  await alice.app.evaluate(({ Notification, BrowserWindow }) => {
    // Record notifications instead of showing them.
    const shown = (globalThis.__notifications = []);
    Notification.isSupported = () => true;
    Notification.prototype.show = function () { shown.push(this.title); };
    BrowserWindow.getAllWindows()[0].close();
  });
  const aliceWindowVisible = () => alice.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
  const aliceNotifications = () => alice.app.evaluate(() => globalThis.__notifications);
  assert.equal(await aliceWindowVisible(), false, "closing hides the window; the app keeps running");

  const file2 = path.join(tmp, "notes.txt");
  fs.writeFileSync(file2, "sent while Alice's window was closed");
  await pickWillReturn(bob.app, [file2]);
  await tab(bob.page, "Contacts");
  await bob.page.getByTestId("contact-Alice").getByRole("button", { name: "Send files" }).click();
  for (let i = 0; !(await aliceNotifications()).some((t) => t.startsWith("Bob wants to send you “notes.txt”")); i++) {
    assert.ok(i < 100, `no offer notification; got ${JSON.stringify(await aliceNotifications())}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok((await aliceNotifications()).includes("PeerPayload Connect is still running"), "told once that it's still running");

  // Clicking the notification (or the tray icon) brings the window back.
  await alice.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await alice.page.getByRole("region", { name: "Offer from Bob" }).getByRole("button", { name: "Accept" }).click();
  await bob.page.locator('[data-testid="transfer-out"][data-state="complete"]').first().waitFor({ timeout: 30000 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.readFileSync(path.join(alice.home, "Downloads", "PeerPayload", "notes.txt"), "utf8"), "sent while Alice's window was closed");

  // Launching again with the same data folder (a second click on the
  // shortcut) doesn't start a second copy: it exits and the running one
  // comes back to the front.
  await alice.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  const second = require("child_process").spawn(ELECTRON, [APP, "--disable-gpu"], { cwd: APP, env: alice.env, stdio: "ignore" });
  const secondExit = await Promise.race([new Promise((r) => second.on("exit", r)), new Promise((r) => setTimeout(() => r("still running"), 20000))]);
  assert.equal(secondExit, 0, "the second copy exits");
  for (let i = 0; !(await aliceWindowVisible()); i++) {
    assert.ok(i < 50, "the running copy's window came back");
    await new Promise((r) => setTimeout(r, 100));
  }

  // A third offer, declined.
  await tab(bob.page, "Contacts");
  await bob.page.getByTestId("contact-Alice").getByRole("button", { name: "Send files" }).click();
  await alice.page.getByRole("region", { name: "Offer from Bob" }).getByRole("button", { name: "Decline" }).click();
  await bob.page.getByText("Alice declined").waitFor({ timeout: 15000 });
  await shot(bob.page, "6-declined");
});
