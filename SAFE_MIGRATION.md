# Production Prisma Migration — Safe Practice Guide

This document outlines the safe procedures for applying database schema changes to the CloraAI production environment.

## 1. Safety Principles

*   **Additive Only**: Only add new columns, tables, or indices. Never drop a column or table in the same deployment where code still references it.
*   **Default Values**: Ensure new columns have sensible defaults or are nullable to avoid breaking existing records.
*   **Backup First**: Always take a database snapshot before running migrations.
*   **Two-Phase Deploys**: For breaking changes (renaming/dropping), use a two-phase approach:
    1.  Add new column, sync data, update code to use both/new.
    2.  Once confirmed, remove old column in a separate deploy.

## 2. Migration Workflow

### Step 1: Generate Migration (Local)
Generate the migration locally and inspect the SQL.
```bash
npx prisma migrate dev --name your_change_name --create-only
```
Review the generated `migration.sql` file in `prisma/migrations/...`.

### Step 2: Test Migration (Staging)
Apply to a staging database that mimics production data.
```bash
npx prisma migrate deploy
```

### Step 3: Production Deployment
1.  **Stop application** (or use blue-green deployment).
2.  **Take Backup**.
3.  **Apply Migration**:
    ```bash
    npx prisma migrate deploy
    ```
4.  **Verify**: Check that the application starts and can read/write to the new fields.

## 3. Specifically for tokenVersion

The addition of `tokenVersion` is an **additive, nullable-safe change**. 
- The schema uses `@default(0)`, so existing users will automatically have `0`.
- The `authenticate` middleware handles `undefined` as `0` for fallback safety.

## 4. Disaster Recovery

If a migration fails:
1.  Identify the failure reason (e.g., timeout on large table index creation).
2.  Restore from the pre-migration backup.
3.  Fix the migration SQL (e.g., use an online index creation strategy for MySQL) and retry.
