/*
  Warnings:

  - You are about to drop the column `bytesDone` on the `transfers` table. All the data in the column will be lost.
  - You are about to drop the column `chunkSize` on the `transfers` table. All the data in the column will be lost.
  - You are about to drop the column `destDir` on the `transfers` table. All the data in the column will be lost.
  - You are about to drop the column `failedPath` on the `transfers` table. All the data in the column will be lost.
  - You are about to drop the column `host` on the `transfers` table. All the data in the column will be lost.
  - You are about to drop the column `mode` on the `transfers` table. All the data in the column will be lost.
  - You are about to drop the column `port` on the `transfers` table. All the data in the column will be lost.
  - You are about to drop the column `sourcePath` on the `transfers` table. All the data in the column will be lost.
  - You are about to drop the column `startedAt` on the `transfers` table. All the data in the column will be lost.
  - You are about to drop the column `token` on the `transfers` table. All the data in the column will be lost.
  - You are about to drop the `chunks` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `engineTokenHash` to the `transfers` table without a default value. This is not possible if the table is not empty.
  - Added the required column `receiverId` to the `transfers` table without a default value. This is not possible if the table is not empty.
  - Added the required column `receiverUsername` to the `transfers` table without a default value. This is not possible if the table is not empty.
  - Added the required column `senderId` to the `transfers` table without a default value. This is not possible if the table is not empty.
  - Added the required column `senderUsername` to the `transfers` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "chunks" DROP CONSTRAINT "chunks_transferId_fkey";

-- AlterTable
ALTER TABLE "transfers" DROP COLUMN "bytesDone",
DROP COLUMN "chunkSize",
DROP COLUMN "destDir",
DROP COLUMN "failedPath",
DROP COLUMN "host",
DROP COLUMN "mode",
DROP COLUMN "port",
DROP COLUMN "sourcePath",
DROP COLUMN "startedAt",
DROP COLUMN "token",
ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "engineTokenHash" TEXT NOT NULL,
ADD COLUMN     "receiverAddress" TEXT,
ADD COLUMN     "receiverId" TEXT NOT NULL,
ADD COLUMN     "receiverPort" INTEGER,
ADD COLUMN     "receiverReport" JSONB,
ADD COLUMN     "receiverUsername" TEXT NOT NULL,
ADD COLUMN     "reportedByReceiver" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reportedBySender" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "senderId" TEXT NOT NULL,
ADD COLUMN     "senderReport" JSONB,
ADD COLUMN     "senderUsername" TEXT NOT NULL;

-- DropTable
DROP TABLE "chunks";

-- CreateIndex
CREATE INDEX "transfers_senderId_idx" ON "transfers"("senderId");

-- CreateIndex
CREATE INDEX "transfers_receiverId_idx" ON "transfers"("receiverId");

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
