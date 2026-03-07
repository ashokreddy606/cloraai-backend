#!/bin/bash
# MongoDB Backup Script for CloraAI
# Requires mongodump to be installed.
# Usage: ./backup.sh

# Load environment variables
if [ -f ../.env ]; then
    export $(cat ../.env | grep -v '#' | awk '/=/ {print $1}')
fi

if [ -z "$DATABASE_URL" ]; then
    echo "Error: DATABASE_URL is not set."
    exit 1
fi

BACKUP_DIR="../backups/$(date +'%Y-%m-%d_%H-%M-%S')"
echo "Starting backup to $BACKUP_DIR..."

mongodump --uri="$DATABASE_URL" --out="$BACKUP_DIR"

if [ $? -eq 0 ]; then
    echo "Backup completed successfully!"
    # Optional: Compress
    tar -czvf "$BACKUP_DIR.tar.gz" "$BACKUP_DIR"
    rm -rf "$BACKUP_DIR"
    echo "Archive created at $BACKUP_DIR.tar.gz"
else
    echo "Backup failed!"
    exit 1
fi
