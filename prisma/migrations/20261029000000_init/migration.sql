-- Yanthara Bulk Email: initial schema (2026-10-29).
-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SenderAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
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

-- CreateTable
CREATE TABLE "OAuthState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stateHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "browserNonceHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StoredFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "campaignId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Campaign" (
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

-- CreateTable
CREATE TABLE "Recipient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "companyName" TEXT NOT NULL,
    "contactName" TEXT,
    "toEmail" TEXT,
    "ccJson" TEXT NOT NULL DEFAULT '[]',
    "sourceRowsJson" TEXT NOT NULL DEFAULT '[]',
    "subject" TEXT,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "templateNumber" INTEGER,
    "companyFileId" TEXT,
    "status" TEXT NOT NULL,
    "category" TEXT,
    "reason" TEXT,
    "scheduledAt" DATETIME,
    "attemptedAt" DATETIME,
    "sentAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "messageIdHeader" TEXT,
    "gmailMessageId" TEXT,
    "gmailThreadId" TEXT,
    "trackingTokenHash" TEXT,
    "trackingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "firstOpenedAt" DATETIME,
    "lastOpenedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Recipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "campaignId" TEXT,
    "action" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Lease" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "holder" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "SenderAccount_email_key" ON "SenderAccount"("email");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthState_stateHash_key" ON "OAuthState"("stateHash");

-- CreateIndex
CREATE INDEX "StoredFile_campaignId_idx" ON "StoredFile"("campaignId");

-- CreateIndex
CREATE INDEX "StoredFile_kind_campaignId_idx" ON "StoredFile"("kind", "campaignId");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE INDEX "Campaign_senderAccountId_status_idx" ON "Campaign"("senderAccountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Recipient_trackingTokenHash_key" ON "Recipient"("trackingTokenHash");

-- CreateIndex
CREATE INDEX "Recipient_campaignId_status_idx" ON "Recipient"("campaignId", "status");

-- CreateIndex
CREATE INDEX "Recipient_toEmail_status_idx" ON "Recipient"("toEmail", "status");

-- CreateIndex
CREATE INDEX "Recipient_status_scheduledAt_idx" ON "Recipient"("status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_value_key" ON "Suppression"("value");

-- CreateIndex
CREATE INDEX "AuditEvent_campaignId_idx" ON "AuditEvent"("campaignId");

