const fs = require("fs");

const path = process.argv[2];
const totalBytes = Number(process.argv[3]);

const csv = fs.readFileSync(path, "utf8");
const lines = csv.trim().split("\n").slice(1);

let readTimeMs = 0, hashTimeMs = 0, sendTimeMs = 0, ackTimeMs = 0, readCount = 0, ackCount = 0;
let firstStart = Infinity, lastEnd = -Infinity;

for (const line of lines) {
  const [, stage, startMs, endMs] = line.split(",");
  const s = parseFloat(startMs), e = parseFloat(endMs);

  if (stage === "read") { readTimeMs += (e - s); readCount++; }
  if (stage === "hash") hashTimeMs += (e - s);
  if (stage === "send") sendTimeMs += (e - s);
  if (stage === "ack") { ackTimeMs += (e - s); ackCount++; }
  if (s < firstStart) firstStart = s;
  if (e > lastEnd) lastEnd = e;
}

function mbps(ms) {
  return (totalBytes / 1e6 / (ms / 1000)).toFixed(2);
}

console.log("chunks:", readCount, "| acks:", ackCount);
console.log("total wall time:", (lastEnd - firstStart).toFixed(1), "ms");
console.log(`sum read:  ${readTimeMs.toFixed(1)} ms -> ${mbps(readTimeMs)} MB/s (isolated disk read)`);
console.log(`sum hash:  ${hashTimeMs.toFixed(1)} ms -> ${mbps(hashTimeMs)} MB/s (isolated SHA-256)`);
console.log(`sum send:  ${sendTimeMs.toFixed(1)} ms -> ${mbps(sendTimeMs)} MB/s (isolated send() call)`);
console.log(`sum ack:   ${ackTimeMs.toFixed(1)} ms -> ${mbps(ackTimeMs)} MB/s equiv (${ackCount ? (ackTimeMs / ackCount).toFixed(3) : "?"} ms/ack avg)`);
