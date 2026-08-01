/*
  Warnings:

  - You are about to drop the column `engineTokenHash` on the `transfers` table. All the data in the column will be lost.
  - Added the required column `engineToken` to the `transfers` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "transfers" DROP COLUMN "engineTokenHash",
ADD COLUMN     "engineToken" TEXT NOT NULL;
