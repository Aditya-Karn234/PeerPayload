-- AlterTable
ALTER TABLE "users" ADD COLUMN     "lastHeartbeatAt" TIMESTAMP(3),
ADD COLUMN     "presenceAddress" TEXT,
ADD COLUMN     "presencePort" INTEGER;
