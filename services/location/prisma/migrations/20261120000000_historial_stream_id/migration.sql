-- AlterTable
ALTER TABLE "pings" ADD COLUMN     "stream_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "pings_stream_id_key" ON "pings"("stream_id");
