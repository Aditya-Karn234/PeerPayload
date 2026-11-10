// Where the mailbox keeps envelopes waiting for their recipient, and the
// ids it has seen (to drop duplicates). Two implementations, same shape:
//
//   memoryStore()        lost on restart; for tests and hosts without a disk
//   sqliteStore(file)    survives restarts (node:sqlite, built into Node 22+)
//
// Store API (synchronous):
//   size(fp)                     envelopes waiting for device fp
//   add(fp, id, envelope, at)
//   list(fp)                     [{ id, envelope }], oldest first
//   remove(fp, ids)              -> how many were removed
//   seen(key) / markSeen(key, at)  duplicate suppression (key = `${to}:${id}`)
//   expire(cutoff)               drop envelopes and seen keys older than cutoff
//   total()                      envelopes waiting, all devices
//   close()

function memoryStore() {
  const queues = new Map(); // fp -> [{ id, envelope, at }]
  const seenKeys = new Map(); // key -> at

  return {
    size: (fp) => queues.get(fp)?.length ?? 0,
    add(fp, id, envelope, at) {
      const queue = queues.get(fp) ?? [];

      queue.push({ id, envelope, at });
      queues.set(fp, queue);
    },
    list: (fp) => (queues.get(fp) ?? []).map(({ id, envelope }) => ({ id, envelope })),
    remove(fp, ids) {
      const queue = queues.get(fp) ?? [];
      const kept = queue.filter((item) => !ids.has(item.id));

      if (kept.length)
        queues.set(fp, kept);
      else
        queues.delete(fp);

      return queue.length - kept.length;
    },
    seen: (key) => seenKeys.has(key),
    markSeen: (key, at) => seenKeys.set(key, at),
    expire(cutoff) {
      for (const [fp, queue] of queues) {
        const kept = queue.filter((item) => item.at >= cutoff);

        if (kept.length)
          queues.set(fp, kept);
        else
          queues.delete(fp);
      }

      for (const [key, at] of seenKeys)
        if (at < cutoff)
          seenKeys.delete(key);
    },
    total: () => [...queues.values()].reduce((n, q) => n + q.length, 0),
    close() {},
  };
}

function sqliteStore(file) {
  // Required lazily: only hosts that use it need a Node with node:sqlite.
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);

  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS envelopes (
      seq      INTEGER PRIMARY KEY AUTOINCREMENT,
      to_fp    TEXT NOT NULL,
      id       TEXT NOT NULL,
      envelope TEXT NOT NULL,
      at       INTEGER NOT NULL,
      UNIQUE (to_fp, id)
    );
    CREATE INDEX IF NOT EXISTS envelopes_by_device ON envelopes (to_fp, seq);
    CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
  `);

  const q = {
    size: db.prepare("SELECT COUNT(*) AS n FROM envelopes WHERE to_fp = ?"),
    add: db.prepare("INSERT OR IGNORE INTO envelopes (to_fp, id, envelope, at) VALUES (?, ?, ?, ?)"),
    list: db.prepare("SELECT id, envelope FROM envelopes WHERE to_fp = ? ORDER BY seq"),
    remove: db.prepare("DELETE FROM envelopes WHERE to_fp = ? AND id = ?"),
    seen: db.prepare("SELECT 1 FROM seen WHERE key = ?"),
    markSeen: db.prepare("INSERT OR REPLACE INTO seen (key, at) VALUES (?, ?)"),
    expireEnvelopes: db.prepare("DELETE FROM envelopes WHERE at < ?"),
    expireSeen: db.prepare("DELETE FROM seen WHERE at < ?"),
    total: db.prepare("SELECT COUNT(*) AS n FROM envelopes"),
  };

  return {
    size: (fp) => q.size.get(fp).n,
    add: (fp, id, envelope, at) => q.add.run(fp, id, JSON.stringify(envelope), at),
    list: (fp) => q.list.all(fp).map((row) => ({ id: row.id, envelope: JSON.parse(row.envelope) })),
    remove(fp, ids) {
      let removed = 0;

      for (const id of ids)
        removed += Number(q.remove.run(fp, id).changes);

      return removed;
    },
    seen: (key) => Boolean(q.seen.get(key)),
    markSeen: (key, at) => q.markSeen.run(key, at),
    expire(cutoff) {
      q.expireEnvelopes.run(cutoff);
      q.expireSeen.run(cutoff);
    },
    total: () => q.total.get().n,
    close: () => db.close(),
  };
}

module.exports = { memoryStore, sqliteStore };
