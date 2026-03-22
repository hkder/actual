#!/usr/bin/env bash
# Actual Budget — daily database backup
# Backs up the 'actual-data' Docker volume, retains 30 days, alerts if >2 GB total.

set -euo pipefail

BACKUP_DIR="/home/hkder/actual-backups"
LOG_FILE="${BACKUP_DIR}/backup.log"
ALERT_FILE="${BACKUP_DIR}/SIZE_ALERT.txt"
RETENTION_DAYS=30
SIZE_THRESHOLD_GB=2
SIZE_THRESHOLD_BYTES=$((SIZE_THRESHOLD_GB * 1024 * 1024 * 1024))
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/actual-backup-${TIMESTAMP}.tar.gz"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"
}

log "=== Backup started ==="

# 1. Create the backup
log "Creating backup: ${BACKUP_FILE}"
docker run --rm \
    -v actual_actual-data:/data \
    -v "${BACKUP_DIR}":/backup \
    alpine \
    tar czf "/backup/actual-backup-${TIMESTAMP}.tar.gz" -C /data .

if [ -f "${BACKUP_FILE}" ]; then
    BACKUP_SIZE=$(du -sh "${BACKUP_FILE}" | cut -f1)
    log "Backup created successfully (${BACKUP_SIZE}): ${BACKUP_FILE}"
else
    log "ERROR: Backup file was not created!"
    exit 1
fi

# 2. Delete backups older than 30 days
log "Pruning backups older than ${RETENTION_DAYS} days..."
DELETED_COUNT=0
while IFS= read -r -d '' old_file; do
    rm -f "${old_file}"
    log "  Deleted old backup: ${old_file}"
    DELETED_COUNT=$((DELETED_COUNT + 1))
done < <(find "${BACKUP_DIR}" -maxdepth 1 -name "actual-backup-*.tar.gz" -mtime +${RETENTION_DAYS} -print0)
log "Pruned ${DELETED_COUNT} old backup(s)."

# 3. Check total size and alert if over threshold
TOTAL_BYTES=$(du -sb "${BACKUP_DIR}" | cut -f1)
TOTAL_HUMAN=$(du -sh "${BACKUP_DIR}" | cut -f1)
log "Total backup directory size: ${TOTAL_HUMAN}"

if [ "${TOTAL_BYTES}" -gt "${SIZE_THRESHOLD_BYTES}" ]; then
    ALERT_MSG="[$(date '+%Y-%m-%d %H:%M:%S')] SIZE ALERT
The backup directory ${BACKUP_DIR} is using ${TOTAL_HUMAN}, which exceeds the ${SIZE_THRESHOLD_GB} GB threshold.

Please decide what to do:
  - Delete old backups manually:    rm ${BACKUP_DIR}/actual-backup-<date>.tar.gz
  - Increase the threshold in:      /home/hkder/actual/scripts/db-backup.sh  (SIZE_THRESHOLD_GB)
  - Reduce retention period in:     /home/hkder/actual/scripts/db-backup.sh  (RETENTION_DAYS)

Current backups:
$(ls -lh ${BACKUP_DIR}/actual-backup-*.tar.gz 2>/dev/null || echo '  (none found)')
"
    echo "${ALERT_MSG}" > "${ALERT_FILE}"
    log "WARNING: Total size ${TOTAL_HUMAN} exceeds ${SIZE_THRESHOLD_GB} GB — alert written to ${ALERT_FILE}"
else
    # Clear any previous alert if we're back under the threshold
    rm -f "${ALERT_FILE}"
fi

log "=== Backup completed ==="
