import os from "os";
import net from "net";

// architecture.md's flow assumes a flat internal network (same LAN/VPN) —
// a private LAN IP is directly reachable between two employee machines
// there, unlike the personal-tool's internet-facing version which needed a
// public-IP lookup. Picks the first non-internal IPv4 address; falls back
// to loopback for same-machine dev/verification runs.
export function getLocalIp() {
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal)
        return iface.address;
    }
  }

  return "127.0.0.1";
}

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.listen(0, "0.0.0.0", () => {
      const { port } = server.address();

      server.close(() => resolve(port));
    });

    server.on("error", reject);
  });
}
