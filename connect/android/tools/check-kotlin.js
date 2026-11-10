#!/usr/bin/env node
// The reverse of make-vectors.js: opens envelopes the Kotlin port sealed
// (written by VectorsTest to app/build/kotlin-sealed.json) with the
// JavaScript reference, and parses their messages, exactly as the desktop
// app does on receipt. Run after `gradlew testDebugUnitTest`:
//
//   node connect/android/tools/check-kotlin.js

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const repo = path.resolve(__dirname, "..", "..", "..");
const core = require(path.join(repo, "connect", "core"));
const p = require(path.join(repo, "protocol"));

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "test", "resources", "vectors.json"), "utf8"));
const sealed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "build", "kotlin-sealed.json"), "utf8"));
const bob = {
  fingerprint: vectors.bob.fingerprint,
  boxPrivateKey: crypto.createPrivateKey({ key: Buffer.from(vectors.bob.boxPrivatePkcs8, "base64"), format: "der", type: "pkcs8" }),
};

let failed = 0;

for (const envelope of sealed) {
  try {
    const opened = core.open(envelope, bob);
    const message = p.parseMessage(opened.payload);

    if (!message)
      throw new Error(`message rejected: ${JSON.stringify(opened.payload).slice(0, 200)}`);

    console.log(`ok   ${message.type}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${err.message}`);
  }
}

process.exit(failed ? 1 : 0);
