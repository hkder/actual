#!/bin/bash
# Renews the Tailscale TLS cert for Actual Budget and restarts Docker if cert changed.
# Tailscale renews when <30 days remain (cert is 90 days, issued by Let's Encrypt).

set -euo pipefail

CERT=/home/hkder/actual/tailscale.crt
KEY=/home/hkder/actual/tailscale.key
DOMAIN=hkder-ubuntu.tail43cd44.ts.net
COMPOSE=/home/hkder/actual/docker-compose.server.yml

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Capture fingerprint before renewal attempt
before=""
if [[ -f "$CERT" ]]; then
  before=$(openssl x509 -in "$CERT" -noout -fingerprint -sha256 2>/dev/null || true)
fi

log "Checking cert for $DOMAIN..."
tailscale cert --cert-file "$CERT" --key-file "$KEY" "$DOMAIN"

after=$(openssl x509 -in "$CERT" -noout -fingerprint -sha256 2>/dev/null || true)
expiry=$(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | cut -d= -f2)
log "Cert valid until: $expiry"

if [[ "$before" != "$after" ]]; then
  log "Cert changed — restarting Actual Budget container..."
  docker compose -f "$COMPOSE" restart
  log "Container restarted."
else
  log "Cert unchanged — no restart needed."
fi
