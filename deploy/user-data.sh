#!/bin/bash
# Sidekick server setup. Paste into the launch template's "User data".
# Every new EC2 instance runs this once at first boot.
# Change the three values below to match your AWS setup.
REGION="ap-southeast-1"              # your AWS region
BUCKET="sidekick-deploy-031228339113"       # the S3 bucket holding sidekick.zip
PARAM_PATH="/sidekick/prod"          # where your settings live in Parameter Store

set -euo pipefail
exec > >(tee -a /var/log/sidekick-setup.log) 2>&1
echo "Sidekick setup started $(date -u)"

# 1. Node.js 22 (LTS) and unzip.
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs unzip

# 2. A system user without login rights runs the app (not root).
id sidekick >/dev/null 2>&1 || useradd --system --create-home --shell /sbin/nologin sidekick

# 3. The app code from S3.
rm -rf /opt/sidekick /tmp/sidekick.zip
mkdir -p /opt/sidekick
aws s3 cp "s3://${BUCKET}/sidekick.zip" /tmp/sidekick.zip --region "$REGION"
unzip -q /tmp/sidekick.zip -d /opt/sidekick
rm -f /tmp/sidekick.zip

# 4. backend/.env from Parameter Store. Secrets never sit in the zip or this script.
#    Values are single-quoted, so they may contain spaces and # (but not ').
ENV_FILE=/opt/sidekick/backend/.env
aws ssm get-parameters-by-path --path "$PARAM_PATH" --recursive --with-decryption \
  --region "$REGION" --query "Parameters[*].[Name,Value]" --output text \
  | while IFS=$'\t' read -r name value; do
      printf "%s='%s'\n" "${name##*/}" "$value"
    done > "$ENV_FILE"
chmod 600 "$ENV_FILE"

PUBLIC_ORIGIN=$(grep -E "^PUBLIC_ORIGIN=" "$ENV_FILE" | cut -d= -f2- | tr -d "'")
if [ -z "$PUBLIC_ORIGIN" ]; then
  echo "PUBLIC_ORIGIN is missing from Parameter Store (${PARAM_PATH}/PUBLIC_ORIGIN)." >&2
  exit 1
fi

# 5. Production config for the admin website and the web version of the app.
#    They only hold the public site address, never secrets.
cat > /opt/sidekick/admin-website/js/config.js <<EOF
window.SIDEKICK_ADMIN_CONFIG = { apiMode: 'production', apiBaseUrl: '${PUBLIC_ORIGIN}' };
EOF
cat > /opt/sidekick/mobile-app/js/config.local.js <<EOF
window.SIDEKICK_CONFIG = { apiMode: "production", apiBaseUrl: "${PUBLIC_ORIGIN}" };
EOF

# 6. Install the backend's packages (production only).
cd /opt/sidekick/backend
npm ci --omit=dev
chown -R sidekick:sidekick /opt/sidekick

# 7. Run the backend as a service that restarts if it stops.
cat > /etc/systemd/system/sidekick.service <<'EOF'
[Unit]
Description=Sidekick backend
After=network-online.target
Wants=network-online.target

[Service]
User=sidekick
WorkingDirectory=/opt/sidekick/backend
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now sidekick
echo "Sidekick setup finished $(date -u)"
