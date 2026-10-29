-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "statusReason" TEXT,
    "sendMode" TEXT NOT NULL,
    "senderAccountId" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "templateMode" TEXT NOT NULL,
    "templatesJson" TEXT NOT NULL,
    "ccJson" TEXT NOT NULL,
    "replyTo" TEXT,
    "recipientMode" TEXT NOT NULL DEFAULT 'company',
    "sheetName" TEXT,
    "copyColleagues" BOOLEAN NOT NULL,
    "signatureHtml" TEXT NOT NULL DEFAULT '',
    "intervalMinutes" INTEGER NOT NULL,
    "startAt" DATETIME NOT NULL,
    "timezone" TEXT NOT NULL,
    "attachmentCount" INTEGER NOT NULL DEFAULT 0,
    "companyZipName" TEXT,
    "sourceFileName" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "eligibleCount" INTEGER NOT NULL DEFAULT 0,
    "invalidCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "excludedCount" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT NOT NULL,
    "approvedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Campaign" ("approvedAt", "approvedByUserId", "attachmentCount", "ccJson", "companyZipName", "completedAt", "copyColleagues", "createdAt", "createdByUserId", "duplicateCount", "eligibleCount", "excludedCount", "fromEmail", "fromName", "id", "intervalMinutes", "invalidCount", "name", "sendMode", "senderAccountId", "signatureHtml", "sourceFileName", "startAt", "status", "statusReason", "templateMode", "templatesJson", "timezone", "totalRows", "updatedAt") SELECT "approvedAt", "approvedByUserId", "attachmentCount", "ccJson", "companyZipName", "completedAt", "copyColleagues", "createdAt", "createdByUserId", "duplicateCount", "eligibleCount", "excludedCount", "fromEmail", "fromName", "id", "intervalMinutes", "invalidCount", "name", "sendMode", "senderAccountId", "signatureHtml", "sourceFileName", "startAt", "status", "statusReason", "templateMode", "templatesJson", "timezone", "totalRows", "updatedAt" FROM "Campaign";
DROP TABLE "Campaign";
ALTER TABLE "new_Campaign" RENAME TO "Campaign";
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");
CREATE INDEX "Campaign_senderAccountId_status_idx" ON "Campaign"("senderAccountId", "status");
CREATE TABLE "new_SenderAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "authType" TEXT NOT NULL DEFAULT 'oauth',
    "refreshTokenEnc" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "statusReason" TEXT,
    "signatureHtml" TEXT NOT NULL DEFAULT '',
    "dailyLimit" INTEGER NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "connectedByUserId" TEXT NOT NULL,
    "connectedAt" DATETIME NOT NULL,
    "lastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_SenderAccount" ("connectedAt", "connectedByUserId", "createdAt", "dailyLimit", "displayName", "email", "id", "lastCheckedAt", "refreshTokenEnc", "scopes", "shared", "signatureHtml", "status", "statusReason", "updatedAt") SELECT "connectedAt", "connectedByUserId", "createdAt", "dailyLimit", "displayName", "email", "id", "lastCheckedAt", "refreshTokenEnc", "scopes", "shared", "signatureHtml", "status", "statusReason", "updatedAt" FROM "SenderAccount";
DROP TABLE "SenderAccount";
ALTER TABLE "new_SenderAccount" RENAME TO "SenderAccount";
CREATE UNIQUE INDEX "SenderAccount_email_key" ON "SenderAccount"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

