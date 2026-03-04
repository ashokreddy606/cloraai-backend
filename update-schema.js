const fs = require('fs');
let schema = fs.readFileSync('prisma/schema.prisma', 'utf8');

// 1. provider
schema = schema.replace('provider = "mysql"', 'provider = "mongodb"');

// 2. id String @id
schema = schema.replace(/id\s+String\s+@id\s+@default\(cuid\(\)\)/g, 'id String @id @default(auto()) @map("_id") @db.ObjectId');
schema = schema.replace(/id\s+String\s+@id\s+@default\(uuid\(\)\)/g, 'id String @id @default(auto()) @map("_id") @db.ObjectId');

// 3. remove db text types
schema = schema.replace(/@db\.LongText/g, '');
schema = schema.replace(/@db\.Text/g, '');

// 4. Update relation scalar fields to use @db.ObjectId
// These match standard relation fields or fields named similarly
schema = schema.replace(/userId\s+String(\s*)$/gm, 'userId String @db.ObjectId$1');
schema = schema.replace(/userId\s+String\s+@unique/g, 'userId String @unique @db.ObjectId');
schema = schema.replace(/referredById\s+String\?(\s*)$/gm, 'referredById String? @db.ObjectId$1');
schema = schema.replace(/inviterId\s+String(\s*)$/gm, 'inviterId String @db.ObjectId$1');
schema = schema.replace(/referredUserId\s+String(\s*)$/gm, 'referredUserId String @db.ObjectId$1');
schema = schema.replace(/adminId\s+String(\s*)$/gm, 'adminId String @db.ObjectId$1');
schema = schema.replace(/targetId\s+String(\s*)$/gm, 'targetId String @db.ObjectId$1');

// 5. Fix CronLock which only has a lockName as @id
schema = schema.replace(
    'lockName String   @id',
    'id String @id @default(auto()) @map("_id") @db.ObjectId\n  lockName String   @unique'
);

fs.writeFileSync('prisma/schema.prisma', schema);
console.log('Schema updated successfully');
