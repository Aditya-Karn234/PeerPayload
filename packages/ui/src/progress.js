// Bytes done so far, from the engine's JSON events (sender or receiver).
// session_start gives the total and chunk size; a resumed file starts at
// the bytes already on disk (file_start's resumeChunk x chunk size);
// chunk_verified adds; file_complete pins a file to its size, so nothing
// can pass 100%. Feed it every event; it returns { bytes, total } once the
// session has started, else null.
export function createProgressTracker() {
  const perFile = new Map();
  let chunkSize = 0;
  let total = null;

  return (event) => {
    switch (event?.event) {
      case "session_start":
        chunkSize = Number(event.chunkSize) || 0;
        total = Number(event.totalBytes) || 0;
        break;
      case "file_start":
        perFile.set(event.relPath, Math.min((Number(event.resumeChunk) || 0) * chunkSize, Number(event.fileSize) || 0));
        break;
      case "chunk_verified":
        perFile.set(event.relPath, (perFile.get(event.relPath) || 0) + (Number(event.bytes) || 0));
        break;
      case "file_complete":
        perFile.set(event.relPath, Number(event.bytes) || 0);
        break;
      default:
        if (total === null)
          return null;
    }

    if (total === null)
      return null;

    let bytes = 0;

    for (const n of perFile.values())
      bytes += n;

    return { bytes: Math.min(bytes, total), total };
  };
}
