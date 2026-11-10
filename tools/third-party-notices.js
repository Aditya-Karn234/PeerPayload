#!/usr/bin/env node
// Writes legal/THIRD_PARTY_NOTICES.md: every third-party component the apps
// ship, with its licence, and the licence texts their terms require to
// travel with them. Regenerate after dependency changes:
//
//   node tools/third-party-notices.js [--android-deps <gradle dependency tree file>]
//
// The Android list comes from `gradle :app:dependencies --configuration
// releaseRuntimeClasspath` (written to a file and passed with
// --android-deps), with licences read from the libraries' own POM files in
// the Gradle cache. Without it, the Android section from the existing file
// is kept.

const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const out = path.join(repo, "legal", "THIRD_PARTY_NOTICES.md");

// ---- npm: what each desktop app ships (production dependencies only) ----

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i;

function npmComponents(appDir) {
  const lock = JSON.parse(fs.readFileSync(path.join(repo, appDir, "package-lock.json"), "utf8"));
  const found = new Map();

  for (const [key, entry] of Object.entries(lock.packages)) {
    // "" is the app itself; links are this repository's own packages.
    if (!key || entry.dev || entry.link || !key.includes("node_modules/"))
      continue;

    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    const dir = path.join(repo, appDir, key);

    // Builds for other systems (macOS, Linux, ARM...) are in the lockfile
    // but not installed here, so they don't ship.
    if (!fs.existsSync(dir))
      continue;

    const file = fs.readdirSync(dir).find((f) => LICENSE_FILE.test(f));
    let text = file ? fs.readFileSync(path.join(dir, file), "utf8").trim() : null;

    // A few MIT packages ship no licence file: the MIT terms still require
    // the text and the copyright line, so write them from package.json.
    if (!text && entry.license === "MIT") {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      const author = typeof meta.author === "string" ? meta.author : meta.author?.name;
      text = `Copyright (c) ${author || `the ${name} authors`}

${MIT_TERMS}`;
    }

    found.set(`${name}@${entry.version}`, { name, version: entry.version, license: entry.license || "see text", text });
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Android: resolved libraries and their POM licences ----

function pomLicences(cache, g, a, v, depth = 0) {
  const base = path.join(cache, g, a, v);

  if (!fs.existsSync(base))
    return null;

  for (const hash of fs.readdirSync(base)) {
    const pom = path.join(base, hash, `${a}-${v}.pom`);

    if (!fs.existsSync(pom))
      continue;

    const xml = fs.readFileSync(pom, "utf8");
    const names = [...xml.matchAll(/<license>[\s\S]*?<name>([^<]+)<\/name>/g)].map((m) => m[1].trim());

    if (names.length)
      return names;

    const parent = xml.match(/<parent>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<version>([^<]+)<\/version>/);

    if (parent && depth < 4)
      return pomLicences(cache, parent[1], parent[2], parent[3], depth + 1);
  }

  return null;
}

function androidComponents(treeFile) {
  const cache = path.join(os.homedir(), ".gradle", "caches", "modules-2", "files-2.1");
  const seen = new Map();

  for (const line of fs.readFileSync(treeFile, "utf8").split(/\r?\n/)) {
    const m = line.includes("---") && line.match(/([\w.-]+):([\w.-]+):([\w.-]+)(?: -> ([\w.-]+))?/);

    if (!m)
      continue;

    const [, g, a, v, resolved] = m;
    const version = resolved || v;
    const names = pomLicences(cache, g, a, version);
    // BouncyCastle publishes no licence in its POMs; its jars carry it.
    const license = names ? names.join(" OR ") : g === "org.bouncycastle" ? "Bouncy Castle Licence (MIT)" : "unknown";

    seen.set(`${g}:${a}`, { name: `${g}:${a}`, version, license });
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const BOUNCY_CASTLE = `Copyright (c) 2000-2026 The Legion of the Bouncy Castle Inc. (https://www.bouncycastle.org)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

// ---- write ----

function table(components) {
  return ["| Component | Version | Licence |", "|---|---|---|", ...components.map((c) => `| ${c.name} | ${c.version} | ${c.license} |`)].join("\n");
}

function texts(components) {
  // Apache-2.0 texts are all the same licence: the full text is in LICENSE
  // at the top of this repository (and next to this file in each app).
  return components
    .filter((c) => c.text && !/^apache-2\.0$/i.test(c.license))
    .map((c) => `### ${c.name} ${c.version} (${c.license})\n\n\`\`\`\n${c.text}\n\`\`\``)
    .join("\n\n");
}

const args = process.argv.slice(2);
const treeArg = args.indexOf("--android-deps");
let android;

if (treeArg >= 0) {
  android = table(androidComponents(args[treeArg + 1]));
} else if (fs.existsSync(out)) {
  const m = fs.readFileSync(out, "utf8").match(/## PeerPayload Connect for Android\n\n[\s\S]*?\n\n(\|[\s\S]*?)\n\n/);
  android = m ? m[1] : "(not generated: pass --android-deps)";
} else {
  android = "(not generated: pass --android-deps)";
}

const connectDesktop = npmComponents("connect/desktop");
const enterpriseDesktop = npmComponents("desktop");

const doc = `# Third-party notices

PeerPayload is licensed under the Apache License 2.0 (see LICENSE and
NOTICE). The apps include the third-party software below, under the
licences shown. Generated by \`tools/third-party-notices.js\`; don't edit by
hand.

## Every app: the transfer engine

The engine (sender, receiver, and libpeerpayload on Android) links
**OpenSSL** statically. OpenSSL is licensed under the Apache License 2.0
(the same text as LICENSE). https://www.openssl.org/

## Desktop apps: Electron and Chromium

The desktop apps are built on **Electron** (MIT licence), which includes
Chromium and other components. Their licences are in \`LICENSES.chromium.html\`
and \`LICENSE.electron.txt\`, installed next to the app's executable.

## PeerPayload Connect for Android

Libraries in the release APK, and their licences. The Apache License 2.0
text is in LICENSE.

${android}

### Bouncy Castle (bcprov, bcpkix, bcutil)

\`\`\`
${BOUNCY_CASTLE}
\`\`\`

## PeerPayload Connect desktop

${table(connectDesktop)}

## PeerPayload Enterprise desktop

${table(enterpriseDesktop)}

## Licence texts for the desktop apps' npm packages

Except Apache-2.0 (see LICENSE). Each package's own licence file, as it
ships with the package.

${texts([...new Map([...connectDesktop, ...enterpriseDesktop].map((c) => [`${c.name}@${c.version}`, c])).values()])}
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, doc);
console.log(`wrote ${path.relative(repo, out)}: Connect desktop ${connectDesktop.length}, Enterprise desktop ${enterpriseDesktop.length} npm packages`);
