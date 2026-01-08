# 🚀 Quick Deployment Guide - TL;DR

## What Changed Since Your Last Deployment?

### New Features:

1. **Redis Caching** (optional) - For faster API responses
2. **Admin Password Change** - New JWT authentication with secrets
3. **CDN Support** - Image optimization configuration
4. **MongoDB Backup Tools** - Optional database backups

### New Dependencies:

- `redis` npm package (REQUIRED - add before deployment)

### New Environment Variables:

- `JWT_SECRET` ⭐ REQUIRED
- `ADMIN_API_KEY` ⭐ REQUIRED
- `REDIS_URL` (optional)
- `CDN_PROVIDER` (optional)
- `CDN_DOMAIN` (optional)
- `CDN_PREFIX` (optional)
- `GEOCODE_SERVER_FALLBACK` (recommended)
- `ALLOWED_ORIGINS` ⭐ REQUIRED

---

## 🎯 Fastest Path to Deployment (10 Minutes)

### Option A: Automated (Recommended)

Upload to your Codespace, then run:

```bash
cd Backend

# 1. Install redis package
npm install redis

# 2. Setup all secrets automatically
chmod +x setup-secrets.sh
./setup-secrets.sh

# 3. Deploy everything
chmod +x deploy.sh
./deploy.sh
```

**Done!** ✅

### Option B: Manual Step-by-Step

If you prefer manual control:

```bash
cd Backend

# 1. Install redis
npm install redis

# 2. Create NEW secrets only (skip if already exist)
echo -n "BCpc+hirr01edyXIdOaFML/fegOeUMEApUppxmLkOqI=" | gcloud secrets create JWT_SECRET --data-file=-
echo -n "XL9LxQMQY0ImiZvtWWBlcnRW8Sg16Neghu/pHhTI1wI=" | gcloud secrets create ADMIN_API_KEY --data-file=-
echo -n "rediss://default:AYhbAAIncDIzODI4ZmE4NzQ5OGU0ZjQ0OTQzMDMwZWRhNDE2NWU2ZXAyMzQ5MDc@advanced-bulldog-34907.upstash.io:6379" | gcloud secrets create REDIS_URL --data-file=-
echo -n "cloudflare" | gcloud secrets create CDN_PROVIDER --data-file=-
echo -n "https://cdn.eforeasy.in" | gcloud secrets create CDN_DOMAIN --data-file=-
echo -n "" | gcloud secrets create CDN_PREFIX --data-file=-
echo -n "1" | gcloud secrets create GEOCODE_SERVER_FALLBACK --data-file=-
echo -n "http://localhost:3000,https://easy-backend-785621869568.asia-south1.run.app" | gcloud secrets create ALLOWED_ORIGINS --data-file=-

# 3. Build and deploy
gcloud builds submit --tag asia-south1-docker.pkg.dev/YOUR_PROJECT_ID/cloud-run-source-deploy/easy-backend

gcloud run deploy easy-backend \
  --image asia-south1-docker.pkg.dev/YOUR_PROJECT_ID/cloud-run-source-deploy/easy-backend \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-secrets "DB_CONNECTION_STRING=DB_CONNECTION_STRING:latest,DB_NAME=DB_NAME:latest,FCM_SERVER_KEY=FCM_SERVER_KEY:latest,FCM_SENDER_ID=FCM_SENDER_ID:latest,GOOGLE_MAPS_API_KEY=GOOGLE_MAPS_API_KEY:latest,UPI_VPA=UPI_VPA:latest,UPI_PAYER_NAME=UPI_PAYER_NAME:latest,UPI_NOTE_PREFIX=UPI_NOTE_PREFIX:latest,AUTO_VERIFY_CLAIMS=AUTO_VERIFY_CLAIMS:latest,JWT_SECRET=JWT_SECRET:latest,ADMIN_API_KEY=ADMIN_API_KEY:latest,REDIS_URL=REDIS_URL:latest,CDN_PROVIDER=CDN_PROVIDER:latest,CDN_DOMAIN=CDN_DOMAIN:latest,CDN_PREFIX=CDN_PREFIX:latest,GEOCODE_SERVER_FALLBACK=GEOCODE_SERVER_FALLBACK:latest,ALLOWED_ORIGINS=ALLOWED_ORIGINS:latest" \
  --set-env-vars "NODE_ENV=production,PORT=8080"
```

---

## ❓ FAQ

### Do I need Redis?

**Already configured!** ✅ You have Upstash Redis set up and working.

- Your app is using: Upstash Redis (free tier: 10,000 requests/day)
- Benefits: Faster API responses with caching, global edge network
- Cost: $0/month on free tier (upgrade if needed)

### What about MongoDB backup tools?

**Not needed.** MongoDB Atlas already backs up your database automatically.

- Skip this completely for Cloud Run deployment
- The backup script only works if `mongodump` is installed locally

### Do I need to update my old deployment command?

**Yes!** Your old command is missing the new secrets:

- ❌ Old: Only 10 secrets
- ✅ New: 17 secrets (7 new ones)

### Where do I get these secret values?

They're already in your `.env` file! The scripts read from there.

### Can I deploy from Windows?

Not easily. Use your GitHub Codespace (Linux) as you normally do. The bash scripts won't work on Windows PowerShell without modification.

---

## 🔍 Verify Deployment

```bash
# Get your Cloud Run URL
gcloud run services describe easy-backend --region=asia-south1 --format="value(status.url)"

# Test health endpoint
curl https://YOUR_CLOUD_RUN_URL/health

# Check logs
gcloud run logs tail easy-backend --region=asia-south1 --follow
```

**Expected in logs:**

- ✅ "MongoDB: Connected successfully"
- ✅ "Firebase Admin SDK initialized"
- ✅ "Redis: Connected and ready"
- ✅ "✅ Redis caching enabled"
- ✅ "Server running on port 8080"

---

## 🐛 Troubleshooting

### "Secret JWT_SECRET not found"

```bash
# Create it:
echo -n "BCpc+hirr01edyXIdOaFML/fegOeUMEApUppxmLkOqI=" | gcloud secrets create JWT_SECRET --data-file=-
```

### "Module 'redis' not found"

```bash
# Install it:
npm install redis
```

### "CORS error from Flutter app"

```bash
# Update ALLOWED_ORIGINS to include your Cloud Run URL:
echo -n "https://your-cloud-run-url.run.app,http://localhost:3000" | gcloud secrets versions add ALLOWED_ORIGINS --data-file=-

# Redeploy:
gcloud run services update easy-backend --region=asia-south1
```

### "Redis connection error" in logs

**Check your REDIS_URL secret.** Make sure it's set to your Upstash connection string:

```bash
# Update REDIS_URL secret
echo -n "rediss://default:AYhbAAIncDIzODI4ZmE4NzQ5OGU0ZjQ0OTQzMDMwZWRhNDE2NWU2ZXAyMzQ5MDc@advanced-bulldog-34907.upstash.io:6379" | gcloud secrets versions add REDIS_URL --data-file=-
```

### Health check fails

```bash
# Check logs for the real error:
gcloud run logs read easy-backend --region=asia-south1 --limit=50

# Common causes:
# - Missing secret (check "Secret ... not found" in logs)
# - Database connection issue (verify MongoDB Atlas allows 0.0.0.0/0)
# - Firebase service key missing (check file exists in Backend/)
```

---

## 📦 What Gets Deployed?

Your Docker container includes:

- ✅ Node.js 20 runtime
- ✅ All production npm packages (including new `redis`)
- ✅ Your entire Backend/ code
- ✅ Firebase service account key file
- ✅ Environment variables from secrets

**NOT included in container:**

- ❌ .env file (secrets come from Secret Manager instead)
- ❌ node_modules from your local machine (rebuilt in container)
- ❌ Any files in .dockerignore

---

## 🎯 Recommended First Deployment Strategy

1. ✅ **Install redis package**: `npm install redis`
2. ✅ **Create all new secrets** (use `setup-secrets.sh`) - includes Upstash Redis URL
3. ✅ **Deploy with Redis enabled** (Upstash connection string configured)
4. ✅ **Verify health endpoint works**
5. ✅ **Test admin login** from Flutter app
6. ✅ **Enjoy Redis caching** - already working locally!

This minimizes risks and gets you deployed fastest.

---

## 📚 Full Documentation

For detailed explanations, see:

- **`DEPLOY_TO_GCP_CLOUD_RUN.md`** - Complete guide with all options
- **`deploy.sh`** - Automated deployment script
- **`setup-secrets.sh`** - Automated secrets setup

---

## ⏱️ Time Estimates

- Creating secrets: **2 minutes** (automated) or **5 minutes** (manual)
- Building image: **2-3 minutes** (Cloud Build) or **5 minutes** (local Docker)
- Deploying: **1-2 minutes**
- **Total: ~5-10 minutes**

Updates (after first deployment): **~3-5 minutes**

---

## ✅ Checklist

Before deployment:

- [ ] Redis package installed (`npm install redis`)
- [ ] All new secrets created in Secret Manager
- [ ] In your Codespace (Linux environment)
- [ ] gcloud CLI authenticated
- [ ] Backend code has all latest changes
- [ ] `.env` file present with all values

After deployment:

- [ ] Health endpoint returns 200 OK
- [ ] Logs show "MongoDB: Connected successfully"
- [ ] Logs show "Redis: Connected and ready"
- [ ] Logs show "✅ Redis caching enabled"
- [ ] Admin login works from Flutter app
- [ ] ALLOWED_ORIGINS updated to include new Cloud Run URL

---

**Ready? Run `./deploy.sh` and you're live in 5 minutes! 🚀**

For questions or issues, check the full guide: `DEPLOY_TO_GCP_CLOUD_RUN.md`
