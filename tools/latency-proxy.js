#!/usr/bin/env node
// A TCP proxy that delays bytes flowing from the upstream (receiver) back
// to the client (sender) by a fixed amount, to simulate network RTT for
// benchmarking. This exists because Sleep()-ing inside the receiver's own
// thread before each ack (see shared/include/bench_latency.hpp) serializes
// ack delivery through one blocking point regardless of how many chunks the
// pipelined sender has in flight — that's a correct model for stop-and-wait
// (only one chunk is ever outstanding) but an incorrect one for pipelining,
// where multiple acks should be able to be "in transit" concurrently.
//
// setTimeout callbacks scheduled with the same delay fire in the order they
// were scheduled, so per-direction byte ordering through the proxy is
// preserved without any extra bookkeeping.
//
// Only the upstream -> client direction (acks) is delayed, matching
// DTS_BENCH_LATENCY_MS's original semantics of "add N ms once per chunk
// round trip" rather than delaying both directions.
const net = require("net");

const [, , listenPortArg, upstreamHostArg, upstreamPortArg, delayMsArg] = process.argv;

if (!listenPortArg || !upstreamHostArg || !upstreamPortArg || !delayMsArg) {
  console.error("Usage: node latency-proxy.js <listenPort> <upstreamHost> <upstreamPort> <delayMs>");
  process.exit(1);
}

const listenPort = Number(listenPortArg);
const upstreamHost = upstreamHostArg;
const upstreamPort = Number(upstreamPortArg);
const delayMs = Number(delayMsArg);

function pipeImmediate(src, dst) {
  src.on("data", (chunk) => {
    if (!dst.destroyed) dst.write(chunk);
  });
  src.on("end", () => dst.end());
  src.on("error", () => {});
}

function pipeDelayed(src, dst, delay) {
  src.on("data", (chunk) => {
    setTimeout(() => {
      if (!dst.destroyed) dst.write(chunk);
    }, delay);
  });
  src.on("end", () => {
    setTimeout(() => dst.end(), delay);
  });
  src.on("error", () => {});
}

const server = net.createServer((clientSocket) => {
  const upstreamSocket = net.connect(upstreamPort, upstreamHost);

  upstreamSocket.on("connect", () => {
    pipeImmediate(clientSocket, upstreamSocket); // sender -> receiver: chunks, instant
    pipeDelayed(upstreamSocket, clientSocket, delayMs); // receiver -> sender: acks, delayed
  });

  upstreamSocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstreamSocket.destroy());
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(`ready: 127.0.0.1:${listenPort} -> ${upstreamHost}:${upstreamPort} (+${delayMs}ms on acks)`);
});
