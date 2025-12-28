# ✅ Cloudflare CDN Setup Checklist

Quick reference for enabling Cloudflare CDN for image delivery.

---

## 🎯 Quick Setup (5 minutes)

### □ Step 1: Create CNAME Record

- [ ] Go to Cloudflare Dashboard → DNS → Records
- [ ] Click "Add record"
- [ ] Type: `CNAME`
- [ ] Name: `cdn`
- [ ] Target: `easy-backend-785621869568.asia-south1.run.app`
- [ ] Proxy status: ✅ **Proxied** (orange cloud)
- [ ] Click "Save"

### □ Step 2: Create Page Rule

- [ ] Go to Rules → Page Rules
- [ ] Click "Create Page Rule"
- [ ] URL: `cdn.eforeasy.in/api/uploads/*`
- [ ] Add setting: Cache Level = **Cache Everything**
- [ ] Add setting: Edge Cache TTL = **1 month**
- [ ] Add setting: Browser Cache TTL = **1 year**
- [ ] Click "Save and Deploy"

### □ Step 3: Add CORS Headers (Transform Rule)

- [ ] Go to Rules → Transform Rules → Modify Response Header
- [ ] Click "Create rule"
- [ ] Name: `CDN CORS Headers`
- [ ] Match: Hostname equals `cdn.eforeasy.in` AND URI starts with `/api/uploads/`
- [ ] Set: `Access-Control-Allow-Origin` = `*`
- [ ] Set: `Access-Control-Allow-Methods` = `GET, OPTIONS`
- [ ] Click "Deploy"

### □ Step 4: Backend Already Configured ✅

Your `.env` file is already set:

```
CDN_PROVIDER=cloudflare
CDN_DOMAIN=https://cdn.eforeasy.in
ALLOWED_ORIGINS=...,https://cdn.eforeasy.in
```

### □ Step 5: Deploy to Cloud Run

- [ ] Upload Backend/ to GitHub Codespace
- [ ] Run `./setup-secrets.sh` (updates ALLOWED_ORIGINS)
- [ ] Run `./deploy.sh` (deploys with CDN config)

---

## 🧪 Testing

### □ Test 1: DNS

```bash
nslookup cdn.eforeasy.in
# Should show Cloudflare IPs (104.*.*.*)
```

### □ Test 2: Upload Image

- [ ] Open Flutter app → Seller Dashboard
- [ ] Upload product image
- [ ] URL should be: `https://cdn.eforeasy.in/api/uploads/{id}`

### □ Test 3: Load Image

- [ ] Open: `https://cdn.eforeasy.in/api/uploads/{id}` in browser
- [ ] Image should load
- [ ] Check headers (F12 → Network):
  - `cf-cache-status: MISS` (first time)
  - `cf-cache-status: HIT` (subsequent loads)

---

## 🎁 Optional Enhancements

### □ Enable Polish (Auto WebP)

- [ ] Speed → Optimization → Polish
- [ ] Enable: **Lossy**
- [ ] Save
- **Benefit:** 30-50% smaller images

### □ Enable Mirage (Lazy Loading)

- [ ] Speed → Optimization → Mirage
- [ ] Enable
- **Benefit:** Faster page loads

---

## 📊 What You Get

**Before CDN:**

- Image load: 500-1000ms from Cloud Run
- Backend serves 100% of image requests
- Bandwidth cost: ~$5-20/month

**After CDN:**

- Image load: 50-150ms from edge
- Backend serves only 5-10% (cache misses)
- Bandwidth cost: ~$0.50-5/month (90% savings!)

---

## 🚨 Troubleshooting

**Images not loading from CDN?**

1. Check CNAME is **Proxied** (orange cloud), not DNS only
2. Test origin directly: `https://easy-backend-785621869568.asia-south1.run.app/api/uploads/{id}`
3. Wait 2-3 minutes for DNS propagation

**CORS errors?**

1. Verify Transform Rule added (Step 3)
2. Check ALLOWED_ORIGINS includes `https://cdn.eforeasy.in`
3. Redeploy Cloud Run after updating secret

**Cache not working?**

1. Verify Page Rule matches `cdn.eforeasy.in/api/uploads/*`
2. Check response headers for `cf-cache-status: HIT`
3. Purge cache: Caching → Configuration → Purge Everything

---

## 📝 Summary

**Cloudflare Setup:**

- ✅ CNAME: cdn → Cloud Run backend
- ✅ Page Rule: Aggressive caching
- ✅ CORS headers: Allow cross-origin
- ✅ Backend configured

**Result:**

- 🚀 5-10x faster image loading
- 💰 90% reduction in bandwidth costs
- 🌍 Global CDN (200+ edge locations)
- 🔒 DDoS protection included

---

**For detailed instructions, see: `CLOUDFLARE_CDN_SETUP.md`**
