# Phase 25.6: Admin Panel Manual Testing Guide

**Date:** November 25, 2025  
**Target:** routes/admin.js 47.49% → 75%+ lines  
**Status:** 🔄 IN PROGRESS

---

## Overview

Phase 25.6 focuses on comprehensive admin panel testing to achieve production readiness and push coverage from 47.49% to 75%+ (target gap: +27.51%).

**Baseline Metrics:**

- **Statements**: 46.78%
- **Branches**: 37.55%
- **Functions**: 50.37%
- **Lines**: 47.49%
- **Tests**: 497 existing tests (100% passing)

---

## Manual Test Scenarios

### 1. Admin Login & Authentication

**Endpoint:** `POST /api/admin/login`

```bash
# Test 1: Valid admin credentials
curl -X POST http://localhost:3000/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@test.com",
    "password": "admin123"
  }'

# Expected: 200, JWT token in response
```

**Validation:**

- [ ] Returns 200 with valid JWT
- [ ] Token includes admin role
- [ ] Token can access protected routes

### 2. Seller Approval/Rejection

**Endpoint:** `PATCH /api/admin/sellers/:id/approve`

```bash
# Get seller ID first
curl -X GET http://localhost:3000/api/admin/sellers \
  -H "Authorization: Bearer <admin-jwt>"

# Approve seller
curl -X PATCH http://localhost:3000/api/admin/sellers/<seller-id>/approve \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"is_approved": true}'

# Expected: 200, seller.is_approved = true in DB
```

**Validation:**

- [ ] Seller status updated in MongoDB
- [ ] Seller receives approval notification (check logs)
- [ ] Seller can now create products

### 3. Coupon Management

**Endpoint:** `POST /api/admin/coupons` (via settings update)

```bash
# Create coupon via platform settings
curl -X PUT http://localhost:3000/api/admin/settings \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "coupons": [
      {
        "code": "SAVE20",
        "percent": 20,
        "min_order": 500,
        "active": true,
        "expiry_date": "2025-12-31"
      }
    ]
  }'

# Expected: 200, coupon available for orders
```

**Validation:**

- [ ] Coupon saved in PlatformSettings
- [ ] Coupon validates correctly during order placement
- [ ] Discount calculation accurate

### 4. Platform Analytics

**Endpoint:** `GET /api/admin/metrics` or reporting endpoints

```bash
# View platform overview
curl -X GET http://localhost:3000/api/admin/reporting/overview \
  -H "Authorization: Bearer <admin-jwt>"

# Expected: 200, JSON with order counts, revenue, users
```

**Validation:**

- [ ] Returns aggregated metrics
- [ ] Counts match MongoDB data
- [ ] Date range filtering works

### 5. Delivery Agent Management

**Endpoint:** `GET /api/admin/delivery-agents`

```bash
# List all delivery agents
curl -X GET http://localhost:3000/api/admin/delivery-agents \
  -H "Authorization: Bearer <admin-jwt>"

# Expected: 200, array of delivery agents
```

**Validation:**

- [ ] Returns all agents with status
- [ ] Includes availability and current orders
- [ ] Pagination works correctly

---

## Automated Test Plan

### Phase 25.6 Test Coverage Strategy

**Uncovered Line Analysis (from coverage report):**

```
Uncovered: 14,136-138,166-167,198,203,221-222,264-276,307,421-422,485-486,
572-573,592-593,610-611,672-673,677-678,689-690,695-696,701-702,709,714-715,
767-768,785-786,803,812-862,871-934,943-944,1000-1020,1042,1069-1074,1082-1093,
1117-1118,1146,1152,1163,1169-1185,1196-1197,1245-1246,1261,1311,1350-1351,
1372-1380,1389-1458,1467-1468,1477-1490,1499-1577,1581-1769,1778-1885,1895-2015,
2023-2034,2039-2044,2049-2070,2106-2107,2131-2132,2163-2164,2273-2275,2281-2379,
2384,2387,2423-2424,2506-2507,2523,2555,2557,2559,2561,2563,2579-2580,2595,
2622-2623,2638,2669-2675,2710-2711,2723-2724,2748-2749,2776-2777,2822-2826,
2842-2843,2848-2868,2874-2889,2893-2907,2911-2924,2930-2945,2949-2957,2961-2974,
3069-3070,3095-3104,3141-3142,3163-3164,3170-3185,3193-3218,3223-3245,3254,
3261-3262,3272,3280-3281,3287-3346,3351-3373,3379-3401,3411-3453,3459-3493,
3499-3529,3534-3549,3555-3574,3580-3593
```

### High-Priority Targets

#### Section 1: Login & Authentication (Lines 118-203)

- **Lines 136-138**: Password comparison error handling
- **Lines 166-167**: Password change validation
- **Lines 198-203**: Token generation errors

#### Section 2: Reporting & Fraud (Lines 307-577)

- **Lines 307-421**: Reporting overview endpoint (UNCOVERED)
- **Lines 421-486**: Fraud signal detection (UNCOVERED)
- **Lines 491-573**: Alert evaluation system (UNCOVERED)

#### Section 3: Seller Management (Lines 720-942)

- **Lines 767-786**: Seller approval workflow
- **Lines 812-862**: PATCH sellers endpoint (UNCOVERED)
- **Lines 870-934**: Test pickup address endpoint (UNCOVERED)

#### Section 4: Products & Settings (Lines 999-1225)

- **Lines 1000-1020**: Product listing with filters (UNCOVERED)
- **Lines 1122-1197**: Settings update validation (UNCOVERED)

#### Section 5: Device Tokens & Notifications (Lines 1225-1458)

- **Lines 1245-1311**: Device token listing (PARTIAL)
- **Lines 1266-1351**: Test push notifications (UNCOVERED)

---

## Success Criteria

### Coverage Goals

- **Statements**: 46.78% → **75%+** (+28.22%)
- **Lines**: 47.49% → **75%+** (+27.51%)
- **Test Reliability**: 100% (all new tests passing)

### Manual Testing

- [ ] 4/4 admin panel flows completed
- [ ] All API responses documented
- [ ] Database changes verified
- [ ] Frontend integration validated

### Automated Testing

- [ ] +50-60 new tests created
- [ ] Uncovered endpoints tested (reporting, fraud, settings)
- [ ] Error paths validated
- [ ] Edge cases handled

---

## Implementation Notes

### Priority Order

1. **High-Impact Endpoints** (lines 307-573, 812-934, 1000-1197) - ~20% coverage gain
2. **Critical Admin Functions** (seller approval, settings update) - ~5% coverage gain
3. **Device Token Management** (lines 1225-1351) - ~2% coverage gain
4. **Error Handlers & Edge Cases** - ~0.5% coverage gain

### Estimated Duration

- Manual testing: 1 hour
- Test file creation: 1.5 hours
- Debugging & fixes: 1 hour
- Documentation: 0.5 hour
- **Total**: ~4 hours

---

## Next Steps

After Phase 25.6 completion:

1. Update MANUAL_TESTING_CHECKLIST.md (mark admin section complete)
2. Create PHASE_25.6_SUMMARY.md with results
3. Proceed to Phase 25.7 (Seller Dashboard)
