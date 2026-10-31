-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "description" VARCHAR(500),
ADD COLUMN     "topic" VARCHAR(250);

-- CreateTable
CREATE TABLE "ChannelStar" (
    "userId" INTEGER NOT NULL,
    "channelId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelStar_pkey" PRIMARY KEY ("userId","channelId")
);

-- CreateTable
CREATE TABLE "DMStar" (
    "userId" INTEGER NOT NULL,
    "otherUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DMStar_pkey" PRIMARY KEY ("userId","otherUserId")
);

-- CreateTable
CREATE TABLE "SidebarPref" (
    "userId" INTEGER NOT NULL,
    "collapsed" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SidebarPref_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "ChannelStar_channelId_idx" ON "ChannelStar"("channelId");

-- CreateIndex
CREATE INDEX "DMStar_otherUserId_idx" ON "DMStar"("otherUserId");

-- AddForeignKey
ALTER TABLE "ChannelStar" ADD CONSTRAINT "ChannelStar_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelStar" ADD CONSTRAINT "ChannelStar_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DMStar" ADD CONSTRAINT "DMStar_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DMStar" ADD CONSTRAINT "DMStar_otherUserId_fkey" FOREIGN KEY ("otherUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SidebarPref" ADD CONSTRAINT "SidebarPref_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
