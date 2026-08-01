-- CreateTable
CREATE TABLE "transfers" (
    "id" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "destDir" TEXT NOT NULL,
    "host" TEXT NOT NULL DEFAULT '127.0.0.1',
    "port" INTEGER,
    "fileCount" INTEGER,
    "totalBytes" BIGINT,
    "bytesDone" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failReason" TEXT,
    "failedPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunks" (
    "id" SERIAL NOT NULL,
    "transferId" TEXT NOT NULL,
    "relPath" TEXT NOT NULL,
    "chunkId" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transfers_status_idx" ON "transfers"("status");

-- CreateIndex
CREATE INDEX "chunks_transferId_idx" ON "chunks"("transferId");

-- CreateIndex
CREATE UNIQUE INDEX "chunks_transferId_relPath_chunkId_key" ON "chunks"("transferId", "relPath", "chunkId");

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
