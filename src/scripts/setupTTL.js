/**
 * Creates MongoDB TTL (Time-To-Live) indexes for temporary records.
 * 
 * - Notifications (30 days)
 * - Audit logs (90 days)
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log('Deploying TTL indexes to MongoDB...');

    // 1. Notification (30 days)
    try {
        await prisma.$runCommandRaw({
            createIndexes: "Notification",
            indexes: [
                {
                    key: { createdAt: 1 },
                    name: "ttl_notification_30d",
                    expireAfterSeconds: 30 * 24 * 60 * 60
                }
            ]
        });
        console.log('✅ TTL index applied to Notification (30 days)');
    } catch (e) {
        console.error('Failed to create TTL index for Notification:', e.message);
    }

    // 2. AuditLog (90 days)
    try {
        await prisma.$runCommandRaw({
            createIndexes: "AuditLog",
            indexes: [
                {
                    key: { createdAt: 1 },
                    name: "ttl_auditlog_90d",
                    expireAfterSeconds: 90 * 24 * 60 * 60
                }
            ]
        });
        console.log('✅ TTL index applied to AuditLog (90 days)');
    } catch (e) {
        console.error('Failed to create TTL index for AuditLog:', e.message);
    }
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
