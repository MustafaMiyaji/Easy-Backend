# Week 7+ Testing Roadmap - Coverage Improvement Plan

**Date**: November 14, 2025  
**Current Status**: 75.68% overall coverage (1298/1308 tests passing)  
**Goal**: Reach 85%+ overall coverage  
**Status**: 🚀 IN PROGRESS

---

## 📊 Current Coverage Breakdown

```
Overall: 75.68% statements | 65.63% branches | 80.2% functions | 76.77% lines
```

### ✅ Excellent Coverage (90%+)

- **middleware/** - 98.35% (all files optimized)
- **services/** - 89.97% (pricing 100%, geocode 97.82%)
- **routes/reviews.js** - 100%
- **routes/wishlist.js** - 100%
- **routes/products.js** - 92.61%
- **routes/restaurants.js** - 96.15%
- **routes/users.js** - 94.84%

### 🟡 Good Coverage (70-89%) - Room for Improvement

- **controllers/** - 85.13%
  - clientsController.js - 85.39% (15 uncovered lines)
  - ordersController.js - 85.09% (30 uncovered lines)
- **routes/delivery.js** - 76.48% (643 uncovered lines)
- **routes/auth.js** - 83.79% (40 uncovered lines)
- **routes/seller.js** - 77.55% (400 uncovered lines)
- **routes/cart.js** - 85.18% (4 uncovered lines)
- **routes/uploads.js** - 89.47% (5 uncovered lines)

### 🔴 Low Coverage (<70%) - URGENT WORK NEEDED

- **routes/admin.js** - 54.65% (~1,600 uncovered lines) 🚨
- **routes/tokens.js** - 21.73% (~30 uncovered lines)
- **routes/restaurant_manage.js** - 22.58% (~40 uncovered lines)
- **routes/orders.js** - 75% (60 uncovered lines)
- **services/orderEvents.js** - 78.4% (30 uncovered lines)
- **services/push.js** - 91.61% (15 uncovered lines)
- **services/upi.js** - 0% (6 lines - payment stub)

---

## 🎯 Phase 1: Quick Wins (Week 7, Day 1-2) - Target: 78% Overall

**Estimated Time**: 4-6 hours  
**Impact**: +2-3% overall coverage  
**Priority**: HIGH (fast ROI)

### 1.1 Fix Tiny Coverage Gaps (2 hours)

#### services/upi.js (0% → 100%) - 30 minutes

**File Size**: 6 lines (payment stub)  
**Uncovered**: Lines 3-8  
**Test File**: Create `tests/services/upi.test.js`  
**Test Cases** (5 tests):

```javascript
- should return default payment gateway config
- should export generatePaymentId function
- should export verifyPayment function
- should export processRefund function
- should handle missing config gracefully
```

#### routes/cart.js (85.18% → 95%) - 30 minutes

**Uncovered**: Lines 14-15, 44-45 (4 lines)  
**Test File**: Extend `tests/cart.test.js`  
**Test Cases** (2-3 tests):

```javascript
- should handle cart update with invalid UID format (lines 14-15)
- should handle concurrent cart updates (race condition)
- should handle cart retrieval for deleted client (lines 44-45)
```

#### routes/users.js (94.84% → 98%) - 30 minutes

**Uncovered**: Lines 7-12 (6 lines)  
**Test File**: Create `tests/users.test.js`  
**Test Cases** (3-4 tests):

```javascript
- should list all users with pagination (GET /api/users)
- should handle empty user list
- should validate pagination parameters
- should handle database errors gracefully (lines 7-12)
```

#### routes/uploads.js (89.47% → 95%) - 30 minutes

**Uncovered**: Lines 44, 56-57, 76-77 (5 lines)  
**Test File**: Extend `tests/uploads.test.js`  
**Test Cases** (3 tests):

```javascript
- should handle GridFS read stream errors (line 44)
- should handle file not found in chunks collection (lines 56-57)
- should handle malformed ObjectId in file retrieval (lines 76-77)
```

**Phase 1 Outcome**: +15-20 tests, ~50 lines covered, 78% overall coverage

---

## 🎯 Phase 2: Medium Coverage Improvements (Week 7, Day 3-4) - Target: 80% Overall

**Estimated Time**: 8-12 hours  
**Impact**: +2% overall coverage  
**Priority**: MEDIUM

### 2.1 routes/auth.js (83.79% → 92%) - 3 hours

**Uncovered**: ~40 lines  
**Lines**: 25, 59-60, 129-130, 158-159, 195-196, 225-227, 282-283, 319-322, 327, 332, 336, 347-348, 381, 396-397, 438-439, 451, 492-493, 515, 517-519, 573-574  
**Test File**: Extend `tests/auth.test.js`

**Test Cases** (15-20 tests):

```javascript
// OTP Generation & Verification
- should generate OTP with valid phone number (line 25)
- should reject OTP generation with invalid phone (line 59-60)
- should verify OTP with correct code (lines 129-130)
- should reject expired OTP (lines 158-159)
- should reject invalid OTP code (lines 195-196)
- should enforce OTP rate limiting (5 attempts per hour)

// Password Reset Flow
- should initiate password reset with email (lines 225-227)
- should reject reset for non-existent email (lines 282-283)
- should validate reset token (lines 319-322)
- should expire reset tokens after 1 hour (line 327)

// Email Verification
- should send email verification link (lines 396-397)
- should verify email with valid token (lines 438-439)
- should reject expired verification tokens (line 451)

// Edge Cases
- should handle Firebase auth errors gracefully (lines 492-493)
- should prevent duplicate registrations (lines 517-519)
- should handle missing Firebase credentials (lines 573-574)
```

### 2.2 routes/delivery.js (76.48% → 82%) - 4 hours

**Uncovered**: 643 lines (lines 95, 114, 130, 230, 282, 324, 416, 454, 472, 503, 521, 544, 595, 625, 662, 736, 788, 828, 1004, 1033, 1062, 1086, 1112, 1156, 1310-1313, 1325-1330, 1342-1362, 2413-2416, 2432, 2442-2443, 2498-2499, 2549-2557, 2583-2584, 2628-2632, 2661-2662, 2704, 2730-2731)  
**Test File**: Extend `tests/delivery.test.js`

**Test Cases** (25-30 tests):

```javascript
// Error Handling & Validation
- should reject order without delivery address (line 95)
- should reject order with invalid agent ID format (line 114)
- should handle agent not found error (line 130)
- should validate location coordinates format (line 230)
- should reject invalid delivery status transition (line 282)

// Retry & Timeout Edge Cases
- should handle retry when geocoding fails (lines 2549-2557)
- should escalate order after max retries exceeded (lines 2583-2584)
- should handle timeout with no available agents (lines 2628-2632)
- should cleanup stale assignments (lines 2661-2662)

// Capacity Management
- should reject assignment when agent at max capacity (lines 1310-1313)
- should distribute load across multiple agents (lines 1325-1330)
- should handle agent going offline mid-assignment (lines 1342-1362)

// Payment & Earnings
- should calculate agent earnings correctly (lines 2413-2416)
- should handle commission split errors (line 2432)
- should update earning logs atomically (lines 2442-2443)

// Notifications & SSE
- should send pickup notification to agent (line 2498-2499)
- should broadcast order updates to seller stream (line 2704)
- should handle SSE write failures gracefully (lines 2730-2731)
```

### 2.3 controllers/ordersController.js (85.09% → 92%) - 2 hours

**Uncovered**: Lines 270, 360, 381, 548, 590, 795, 812-814, 856-857, 972-973, 987-991, 1027, 1057, 1067, 1109-1110, 1282, 1288-1290, 1328-1329, 1344-1345  
**Test File**: Extend `tests/orders.test.js` or `tests/orders_edge_cases.test.js`

**Test Cases** (10-12 tests):

```javascript
- should handle order status update with invalid status (line 270)
- should validate payment method changes (line 360)
- should handle concurrent order updates (line 381)
- should enforce order cancellation time limits (lines 812-814)
- should handle refund processing errors (lines 856-857)
- should validate seller authorization for orders (lines 987-991)
- should handle missing order items gracefully (lines 1109-1110)
- should calculate platform commission correctly (lines 1288-1290)
- should handle database write failures (lines 1344-1345)
```

### 2.4 controllers/clientsController.js (85.39% → 92%) - 1 hour

**Uncovered**: Lines 119, 138-150, 168-169, 220-221  
**Test File**: Extend `tests/controllers/clientsController.test.js`

**Test Cases** (5-6 tests):

```javascript
- should handle profile update with conflicting phone (line 119)
- should validate avatar URL format (lines 138-150)
- should handle profile deletion cascade (lines 168-169)
- should prevent phone number hijacking (lines 220-221)
```

**Phase 2 Outcome**: +50-68 tests, ~800 lines covered, 80% overall coverage

---

## 🎯 Phase 3: High-Impact Improvements (Week 7, Day 5-7) - Target: 82% Overall

**Estimated Time**: 12-16 hours  
**Impact**: +2% overall coverage  
**Priority**: HIGH (critical business logic)

### 3.1 routes/admin.js (54.65% → 70%) - 10 hours 🚨 TOP PRIORITY

**File Size**: 3,584 lines  
**Uncovered**: ~1,600 lines  
**Current Tests**: 174 tests (Phases 1-7)  
**Test File**: Extend `tests/admin.test.js`

**Phase 8: Advanced Admin Features** (60-80 new tests):

#### Payout Management (20 tests)

**Lines**: 2028-2044, 2063, 2153-2200

```javascript
// Payout Calculations
- should calculate seller payout with platform commission
- should calculate agent payout with base + distance fees
- should handle bulk payout processing
- should generate payout CSV export
- should validate payout threshold (minimum $10)
- should prevent duplicate payouts for same period

// Payout Approval Workflow
- should approve pending payouts
- should reject payouts with reasons
- should handle payout disputes
- should track payout history

// Error Cases
- should handle insufficient platform balance
- should validate payout destination accounts
- should handle payment gateway failures
```

#### Fraud Detection & Security (15 tests)

**Lines**: 361, 514, 703, 722, 765, 862

```javascript
- should detect suspicious order patterns
- should flag accounts with multiple failed payments
- should identify fake reviews
- should detect coordinated abuse
- should freeze suspicious seller accounts
- should generate fraud reports
- should whitelist legitimate high-volume sellers
```

#### Advanced Analytics & Reporting (15 tests)

**Lines**: 1097, 1305, 1406, 1443, 1564, 1654, 1709, 1788, 1912

```javascript
- should generate revenue report by date range
- should calculate seller performance metrics
- should track delivery agent efficiency
- should analyze customer retention rates
- should export analytics data (CSV/JSON)
- should generate real-time dashboard metrics
- should calculate platform growth metrics
```

#### Platform Settings & Configuration (10 tests)

**Lines**: 2210-2259, 2270-2316, 2321-2343

```javascript
- should update delivery fee structure
- should configure commission rates per category
- should manage platform-wide notifications
- should update terms and conditions
- should configure payment gateway settings
```

#### Advanced User Management (10 tests)

**Lines**: 2349-2371, 2376-2393, 3440-3441, 3464-3465

```javascript
- should bulk update user roles
- should export user data (GDPR compliance)
- should handle user account mergers
- should manage user permissions granularly
```

#### System Maintenance (10 tests)

**Lines**: 3480-3481, 3495-3496, 3499-3500, 3516-3517, 3536-3537, 3561-3562, 3568-3581

```javascript
- should trigger database backup
- should clear old cached data
- should regenerate search indexes
- should run system health checks
- should archive old orders
- should cleanup stale sessions
```

**Admin Phase 8 Impact**: +60-80 tests, ~1,200 lines covered, admin.js 70% coverage

### 3.2 routes/tokens.js (21.73% → 85%) - 2 hours

**Uncovered**: Lines 8-39 (~30 lines)  
**Test File**: Create `tests/tokens.test.js`

**Test Cases** (15-20 tests):

```javascript
// Token Generation
- should generate Firebase custom token for user
- should generate admin token with elevated privileges
- should generate seller token with scope restrictions
- should generate agent token with limited permissions
- should include custom claims in token

// Token Validation
- should validate token signature
- should reject expired tokens
- should reject revoked tokens
- should validate token audience (aud claim)
- should verify issuer (iss claim)

// Token Refresh
- should refresh token before expiry
- should reject refresh for revoked sessions
- should update token expiration time

// Error Handling
- should handle Firebase errors gracefully
- should validate user existence before token generation
- should prevent token generation for banned users
```

### 3.3 routes/restaurant_manage.js (22.58% → 85%) - 2 hours

**Uncovered**: Lines 9-14, 19-25, 31-57 (~40 lines)  
**Test File**: Create `tests/restaurant_manage.test.js`

**Test Cases** (15-18 tests):

```javascript
// Restaurant CRUD
- should create new restaurant profile
- should update restaurant details
- should delete restaurant (soft delete)
- should list all restaurants with filters

// Menu Management
- should add menu items to restaurant
- should update menu item prices
- should toggle menu item availability
- should delete menu items

// Operating Hours
- should set restaurant operating hours
- should update hours for specific days
- should handle holiday closures

// Restaurant Settings
- should configure delivery radius
- should set minimum order amount
- should enable/disable online ordering

// Error Cases
- should reject duplicate restaurant names
- should validate cuisine type
- should handle invalid operating hours format
```

**Phase 3 Outcome**: +90-118 tests, ~1,270 lines covered, 82% overall coverage

---

## 🎯 Phase 4: Coverage Optimization (Week 8, Day 1-2) - Target: 85% Overall

**Estimated Time**: 6-8 hours  
**Impact**: +3% overall coverage  
**Priority**: MEDIUM (polish & edge cases)

### 4.1 services/orderEvents.js (78.4% → 90%) - 2 hours

**Uncovered**: Lines 47-50, 71, 113-117, 122-127, 132-135  
**Test File**: Extend `tests/services/orderEvents.test.js`

**Test Cases** (10-12 tests):

```javascript
- should handle SSE heartbeat function (line 71)
- should cleanup connections on server shutdown (lines 113-117)
- should handle memory leaks with long-lived connections (lines 122-127)
- should rate limit SSE message publishing (lines 132-135)
- should handle concurrent broadcasts (lines 47-50)
```

### 4.2 services/push.js (91.61% → 96%) - 1 hour

**Uncovered**: Lines 88-89, 94-96, 101, 193, 309, 371-372  
**Test File**: Extend `tests/services/pushNotifications.test.js`

**Test Cases** (8-10 tests):

```javascript
- should handle FCM token rotation (lines 88-89)
- should retry failed notification sends (lines 94-96)
- should batch notifications > 500 devices (line 101)
- should handle notification priority levels (line 193)
- should track notification delivery metrics (line 309)
- should cleanup invalid tokens from database (lines 371-372)
```

### 4.3 routes/orders.js (75% → 85%) - 2 hours

**Uncovered**: Lines 50, 106, 120-122, 131-132, 147-165, 182, 204-209, 248, 263-264  
**Test File**: Extend `tests/orders.test.js`

**Test Cases** (12-15 tests):

```javascript
- should handle order confirmation email failures (line 50)
- should validate order modification permissions (line 106)
- should handle inventory reservation timeout (lines 120-122)
- should process partial order cancellations (lines 131-132)
- should handle bulk order status updates (lines 147-165)
- should calculate tax correctly per region (line 182)
- should handle split payments (lines 204-209)
- should enforce order modification deadlines (line 248)
- should handle database transaction rollbacks (lines 263-264)
```

### 4.4 routes/seller.js (77.55% → 85%) - 2 hours

**Uncovered**: Lines 421-1422, 1453, 1545-1546, 1608-1609, 1645-1646, 1685, 1718-1719, 1734-1835, 1889-1890, 2006-2007, 2110-2111  
**Test File**: Extend `tests/seller.test.js`

**Test Cases** (15-18 tests):

```javascript
- should handle bulk product updates (lines 421-450)
- should validate inventory synchronization (lines 1545-1546)
- should handle seller payout requests (lines 1608-1609)
- should generate sales reports (lines 1645-1646)
- should track product view analytics (line 1685)
- should handle promotional campaigns (lines 1718-1719)
- should manage seller subscriptions (lines 1734-1835)
- should handle seller rating updates (lines 1889-1890)
- should process seller refund requests (lines 2006-2007)
- should validate seller bank account details (lines 2110-2111)
```

**Phase 4 Outcome**: +45-55 tests, ~500 lines covered, 85% overall coverage

---

## 📈 Expected Final Outcomes

### Coverage Targets

```
Phase 1 (Quick Wins):         78% overall (+2%)
Phase 2 (Medium):             80% overall (+2%)
Phase 3 (High-Impact):        82% overall (+2%)
Phase 4 (Optimization):       85% overall (+3%)

TOTAL IMPROVEMENT: +10% (75.68% → 85%)
```

### Test Suite Growth

```
Current:  1298 passing tests
Phase 1:  +15-20 tests   → 1313-1318 tests
Phase 2:  +50-68 tests   → 1363-1386 tests
Phase 3:  +90-118 tests  → 1453-1504 tests
Phase 4:  +45-55 tests   → 1498-1559 tests

TOTAL: ~1500-1560 tests (+200-260 tests)
```

### Lines Covered

```
Current:  ~15,400 lines covered (75.68%)
Target:   ~17,300 lines covered (85%)
New:      ~1,900 lines to cover
```

---

## 🚀 Implementation Strategy

### Daily Schedule (Week 7)

**Day 1 (4 hours)**: Phase 1 Quick Wins

- Morning: upi.js, cart.js, users.js tests (2h)
- Afternoon: uploads.js tests + verification (2h)
- **Checkpoint**: Run `npm test -- --coverage` → Verify 78% coverage

**Day 2 (6 hours)**: Phase 2 Auth & Delivery

- Morning: auth.js 15-20 tests (3h)
- Afternoon: delivery.js error handling tests (3h)
- **Checkpoint**: Verify 79% coverage

**Day 3 (6 hours)**: Phase 2 Controllers

- Morning: ordersController.js tests (3h)
- Afternoon: clientsController.js tests + verification (3h)
- **Checkpoint**: Verify 80% coverage, run full test suite

**Day 4 (8 hours)**: Phase 3 Admin Part 1

- Morning: Admin payouts (20 tests, 4h)
- Afternoon: Admin fraud detection (15 tests, 4h)
- **Checkpoint**: Verify admin.js → 62-65% coverage

**Day 5 (8 hours)**: Phase 3 Admin Part 2

- Morning: Admin analytics (15 tests, 4h)
- Afternoon: Admin settings + maintenance (20 tests, 4h)
- **Checkpoint**: Verify admin.js → 70% coverage

**Day 6 (4 hours)**: Phase 3 Tokens & Restaurants

- Morning: tokens.js tests (2h)
- Afternoon: restaurant_manage.js tests (2h)
- **Checkpoint**: Verify 82% overall coverage

**Day 7 (6 hours)**: Phase 4 Final Polish

- Morning: orderEvents, push, orders tests (4h)
- Afternoon: seller.js tests + final verification (2h)
- **Checkpoint**: Run full coverage → Verify 85%+ target achieved

---

## ✅ Quality Assurance Checklist

After each phase, verify:

- [ ] All new tests passing (100% pass rate)
- [ ] No test timeouts (< 10 seconds per test)
- [ ] Coverage target met for phase
- [ ] No regressions in existing tests
- [ ] Documentation updated
- [ ] Code reviewed for test quality

---

## 📝 Documentation Updates Required

After completion:

1. **BACKEND_CHANGES_LOG.md**: Week 7 summary
2. **TEST_COVERAGE_IMPROVEMENT_PLAN.md**: Final metrics
3. **MANUAL_TESTING_CHECKLIST.md**: Mark automated tests
4. **DEPLOYMENT_READINESS.md**: Update with 85% coverage

---

## 🎯 Success Criteria

**Week 7 Complete When**:

- ✅ Overall coverage ≥ 85%
- ✅ All critical routes > 80% coverage
- ✅ admin.js ≥ 70% coverage
- ✅ All low-coverage files ≥ 80%
- ✅ Test suite runtime < 20 minutes
- ✅ 100% test pass rate
- ✅ Documentation fully updated

---

**Ready to start Week 7 testing! 🚀**
