-- AlterTable
ALTER TABLE "transfers" ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'local',
ALTER COLUMN "sourcePath" DROP NOT NULL,
ALTER COLUMN "destDir" DROP NOT NULL;
