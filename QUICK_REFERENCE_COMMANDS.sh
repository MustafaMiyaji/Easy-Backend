#!/bin/bash

###############################################################################
# Quick Reference: Easy-Backend Cloud Run Commands
#
# This file contains all common commands for deploying and managing the
# Easy-Backend service on Google Cloud Run.
#
# Usage:
#   Copy-paste any command from this file into your terminal
#   Customize variables like PROJECT_ID, REGION as needed
#
###############################################################################

# ============================================================================
# 1. INITIAL SETUP (One-time)
# ============================================================================

# Set your project
export PROJECT_ID="easy-grocery-521d5"
export REGION="asia-south1"
export SERVICE_NAME="easy-backend"

gcloud config set project $PROJECT_ID

# Enable required APIs
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com

# Create Artifact Registry repository
gcloud artifacts repositories create easy-backend \
  --repository-format=docker \
  --location=$REGION

# Configure Docker authentication
gcloud auth configure-docker ${REGION}-docker.pkg.dev

# Create GCS bucket for backups
gsutil mb -p $PROJECT_ID -l $REGION gs://easy-grocery-backups

# Create service account
gcloud iam service-accounts create easy-backend \
  --display-name="Easy Backend Service"

# Grant permissions
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:easy-backend@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:easy-backend@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:easy-backend@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/storage.admin"


# ============================================================================
# 2. CREATE SECRETS (Do this for all your environment variables)
# ============================================================================

# MongoDB Connection String
echo -n "YOUR_MONGODB_CONNECTION_STRING" | \
  gcloud secrets create DB_CONNECTION_STRING --data-file=-

# Firebase/FCM
echo -n "YOUR_FCM_SERVER_KEY" | \
  gcloud secrets create FCM_SERVER_KEY --data-file=-

# Database Name
echo -n "easy_app" | \
  gcloud secrets create DB_NAME --data-file=-

# UPI Configuration
echo -n "YOUR_UPI_VPA@BANK" | \
  gcloud secrets create UPI_VPA --data-file=-

echo -n "Merchant Name" | \
  gcloud secrets create UPI_PAYER_NAME --data-file=-

echo -n "Order from Easy" | \
  gcloud secrets create UPI_NOTE_PREFIX --data-file=-

# Firebase Settings
echo -n "true" | \
  gcloud secrets create AUTO_VERIFY_CLAIMS --data-file=-

echo -n "YOUR_FCM_SENDER_ID" | \
  gcloud secrets create FCM_SENDER_ID --data-file=-

# Google Maps API
echo -n "YOUR_MAPS_API_KEY" | \
  gcloud secrets create GOOGLE_MAPS_API_KEY --data-file=-

# Sentry DSN (Optional - for error monitoring)
echo -n "https://your-key@sentry.io/project-id" | \
  gcloud secrets create SENTRY_DSN --data-file=-

# Firebase Admin SDK JSON
cat your-firebase-service-account-key.json | \
  gcloud secrets create FIREBASE_ADMIN_SDK --data-file=-

# List created secrets
gcloud secrets list


# ============================================================================
# 3. DEPLOYMENT OPTIONS
# ============================================================================

# OPTION A: Using the automated script (RECOMMENDED)
chmod +x Backend/deploy-to-cloud-run.sh
./Backend/deploy-to-cloud-run.sh --production

# OPTION B: Using your original command
cd Backend
IMAGE="asia-south1-docker.pkg.dev/easy-grocery-521d5/easy-backend/api:$(date +%Y%m%d-%H%M%S)"
gcloud builds submit --tag "$IMAGE" .

gcloud run deploy easy-backend \
  --image "$IMAGE" \
  --region asia-south1 \
  --allow-unauthenticated \
  --timeout 3600 \
  --max-instances 100 \
  --memory 1Gi \
  --cpu 1 \
  --set-secrets "DB_CONNECTION_STRING=DB_CONNECTION_STRING:latest,FCM_SERVER_KEY=FCM_SERVER_KEY:latest,DB_NAME=DB_NAME:latest,UPI_VPA=UPI_VPA:latest,UPI_PAYER_NAME=UPI_PAYER_NAME:latest,UPI_NOTE_PREFIX=UPI_NOTE_PREFIX:latest,AUTO_VERIFY_CLAIMS=AUTO_VERIFY_CLAIMS:latest,FCM_SENDER_ID=FCM_SENDER_ID:latest,GOOGLE_MAPS_API_KEY=GOOGLE_MAPS_API_KEY:latest,SENTRY_DSN=SENTRY_DSN:latest,FIREBASE_ADMIN_SDK=FIREBASE_ADMIN_SDK:latest" \
  --set-env-vars "NODE_ENV=production,GCS_BACKUP_BUCKET=gs://easy-grocery-backups" \
  --service-account="easy-backend@easy-grocery-521d5.iam.gserviceaccount.com"

# OPTION C: Manual deployment step by step
cd Backend

# Build locally first
docker build -t easy-backend:latest .

# Tag for Artifact Registry
docker tag easy-backend:latest \
  asia-south1-docker.pkg.dev/easy-grocery-521d5/easy-backend/api:latest

# Push to Artifact Registry
docker push asia-south1-docker.pkg.dev/easy-grocery-521d5/easy-backend/api:latest

# Deploy to Cloud Run
gcloud run deploy easy-backend \
  --image asia-south1-docker.pkg.dev/easy-grocery-521d5/easy-backend/api:latest \
  --region asia-south1


# ============================================================================
# 4. MONITORING & DEBUGGING
# ============================================================================

# Get service URL
gcloud run services describe easy-backend --region asia-south1 \
  --format='value(status.url)'

# Stream logs (real-time)
gcloud run services logs read easy-backend --region asia-south1 --tail

# View recent logs (last 100 lines)
gcloud run services logs read easy-backend --region asia-south1 --limit 100

# View specific logs (errors only)
gcloud run services logs read easy-backend --region asia-south1 \
  --filter="severity>=ERROR" --limit 50

# View backup logs
gcloud run services logs read easy-backend --region asia-south1 \
  --filter="textPayload:backup OR textPayload:mongodump" --limit 50

# Monitor cron job (every 5 minutes)
gcloud run services logs read easy-backend --region asia-south1 \
  --filter="textPayload:(Cron OR timeout OR reassign)" --limit 50

# Get service details
gcloud run services describe easy-backend --region asia-south1

# Get traffic split info
gcloud run services update-traffic easy-backend \
  --region asia-south1 \
  --to-revisions LATEST=100


# ============================================================================
# 5. BACKUP OPERATIONS
# ============================================================================

# List all backups in GCS
gsutil ls gs://easy-grocery-backups/mongodb-backups/

# List backups with details
gsutil ls -l gs://easy-grocery-backups/mongodb-backups/

# Download a backup
gsutil -m cp -r gs://easy-grocery-backups/mongodb-backups/backup_easy_app_2024-12-19_02-00-00 ./

# Check total backup storage
gsutil du -sh gs://easy-grocery-backups/

# Manual backup (run in Cloud Run shell)
# First, access the running service
gcloud run services describe easy-backend --region asia-south1

# Then trigger via API
SERVICE_URL=$(gcloud run services describe easy-backend --region asia-south1 \
  --format='value(status.url)')
curl -X POST $SERVICE_URL/api/admin/backup-now \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"


# ============================================================================
# 6. UPDATES & ROLLBACK
# ============================================================================

# View all revisions
gcloud run revisions list --service easy-backend --region asia-south1

# Get current traffic distribution
gcloud run services describe easy-backend --region asia-south1 \
  --format='value(spec.traffic)'

# Rollback to previous revision
PREVIOUS_REVISION=$(gcloud run revisions list --service easy-backend \
  --region asia-south1 --sort-by "~created" --format="value(name)" | head -2 | tail -1)

gcloud run services update-traffic easy-backend \
  --to-revisions "$PREVIOUS_REVISION=100" \
  --region asia-south1

# Gradual rollout (10% to new, 90% to stable)
gcloud run services update-traffic easy-backend \
  --to-revisions LATEST=10,easy-backend-xxxxx=90 \
  --region asia-south1


# ============================================================================
# 7. SCALING & PERFORMANCE
# ============================================================================

# Update max instances
gcloud run deploy easy-backend \
  --max-instances 200 \
  --region asia-south1

# Update memory
gcloud run deploy easy-backend \
  --memory 2Gi \
  --region asia-south1

# Update CPU
gcloud run deploy easy-backend \
  --cpu 2 \
  --region asia-south1

# Update concurrency per instance
gcloud run deploy easy-backend \
  --concurrency 100 \
  --region asia-south1


# ============================================================================
# 8. ENVIRONMENT VARIABLES & SECRETS
# ============================================================================

# Update environment variable
gcloud run deploy easy-backend \
  --set-env-vars LOG_LEVEL=debug \
  --region asia-south1

# Update secret
echo -n "new_value" | gcloud secrets versions add DB_CONNECTION_STRING --data-file=-

# View all secrets
gcloud secrets list

# Get secret value (for verification - use carefully!)
gcloud secrets versions access latest --secret="DB_CONNECTION_STRING"


# ============================================================================
# 9. TESTING & VERIFICATION
# ============================================================================

# Get service URL
SERVICE_URL=$(gcloud run services describe easy-backend --region asia-south1 \
  --format='value(status.url)')

# Test health endpoint
curl -s "$SERVICE_URL/health" | jq .

# Test API endpoint (example)
curl -s "$SERVICE_URL/api/health" | jq .

# Check response time
time curl -s "$SERVICE_URL/health" > /dev/null

# Test with verbose output
curl -v "$SERVICE_URL/health"

# Load test (requires Apache Bench)
ab -n 1000 -c 100 "$SERVICE_URL/health"


# ============================================================================
# 10. CLEANUP & MAINTENANCE
# ============================================================================

# Delete old image versions (keep last 5)
gcloud artifacts docker images delete \
  asia-south1-docker.pkg.dev/easy-grocery-521d5/easy-backend/api:OLD_TAG \
  --delete-tags

# List image storage usage
gcloud artifacts docker images list asia-south1-docker.pkg.dev/easy-grocery-521d5/easy-backend/

# Cleanup old backups in GCS
gsutil -m rm -r gs://easy-grocery-backups/mongodb-backups/backup_easy_app_2024-10-*

# Set automatic backup deletion (30 days)
cat > /tmp/lifecycle.json << 'EOF'
{
  "lifecycle": {
    "rule": [
      {
        "action": {"type": "Delete"},
        "condition": {"age": 30}
      }
    ]
  }
}
EOF
gsutil lifecycle set /tmp/lifecycle.json gs://easy-grocery-backups

# View current Cloud Run costs (for your project)
gcloud billing projects describe projects/$PROJECT_ID


# ============================================================================
# 11. TROUBLESHOOTING
# ============================================================================

# Check if service is running
gcloud run services describe easy-backend --region asia-south1 \
  --format='value(status.conditions[0].status)'

# View deployment errors
gcloud run services describe easy-backend --region asia-south1 \
  --format='value(status.conditions)'

# Check Docker image in Artifact Registry
gcloud artifacts docker images describe \
  asia-south1-docker.pkg.dev/easy-grocery-521d5/easy-backend/api:latest

# View service account details
gcloud iam service-accounts describe \
  easy-backend@easy-grocery-521d5.iam.gserviceaccount.com

# Test database connection (from Cloud Shell)
gcloud run services describe easy-backend --region asia-south1 --format=value | head -1
# Or check logs for connection errors
gcloud run services logs read easy-backend --region asia-south1 | grep -i "mongodb\|connection"

# View Cloud Build history
gcloud builds list --limit 10

# Get detailed build logs
gcloud builds log BUILD_ID --stream


# ============================================================================
# 12. USEFUL VARIABLES FOR SCRIPTING
# ============================================================================

# Get service URL (useful in scripts)
SERVICE_URL=$(gcloud run services describe easy-backend --region asia-south1 \
  --format='value(status.url)')

# Get project ID (useful in scripts)
PROJECT_ID=$(gcloud config get-value project)

# Get list of all services
gcloud run services list --region asia-south1

# Get latest image tag
LATEST_IMAGE=$(gcloud artifacts docker images list \
  asia-south1-docker.pkg.dev/easy-grocery-521d5/easy-backend/api \
  --sort-by="~create_time" --limit=1 --format="value(image)")


# ============================================================================
# Additional Resources
# ============================================================================

# Documentation URLs:
# - Cloud Run: https://cloud.google.com/run/docs
# - gcloud CLI: https://cloud.google.com/sdk/gcloud/reference/run
# - Artifact Registry: https://cloud.google.com/artifact-registry/docs
# - Cloud Storage: https://cloud.google.com/storage/docs
# - Secret Manager: https://cloud.google.com/secret-manager/docs
# - MongoDB Backup: https://docs.mongodb.com/manual/reference/program/mongodump/

# ============================================================================
# EOF - End of Commands
# ============================================================================
