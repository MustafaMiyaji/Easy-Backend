# Phase 21.7 - Delivery.js Test Plan (83.64% → 88-92%)

**Date:** November 20, 2025  
**Current Coverage:** 83.64% lines, 69.21% branches  
**Target Coverage:** 88-92% lines, 73-77% branches  
**Tests to Add:** 30-40 targeted tests  
**Estimated Time:** 2-3 hours

---

## 📊 Current State Analysis

**Baseline (Phase 21.6):**

- Lines: 767/917 covered (83.64%)
- Branches: 652/942 covered (69.21%)
- Functions: 55/64 covered (85.93%)
- Statements: 789/961 covered (82.1%)

**Remaining Gaps:**

- **Uncovered Lines**: ~150 lines (16.36%)
- **Uncovered Branches**: ~290 branches (30.79%)
- **Target**: +40-60 lines covered (+5-8%)

---

## 🎯 Priority Analysis (from HTML Report)

### 🔴 Priority 1: Critical Endpoint Branches (20-25 tests)

**Focus**: Order assignment, status updates, payment flows

#### 1.1 Accept Order Complex Branches (6 tests)

**Lines 1044-1150**: Accept order endpoint with complex pickup address logic

**Targeted Tests:**

1. **Lines 1044-1050**: Accept order with seller having no location or place_id

   - Create order, seller with null location/place_id
   - Agent accepts order
   - Expect pickup_address set to null or empty

2. **Lines 1086-1095**: Accept order with seller place_id geocoding error

   - Mock placeDetails to throw error
   - Create order with seller.place_id
   - Agent accepts order
   - Expect pickup_address fallback to seller.address or coordinates

3. **Lines 1100-1115**: Accept order with seller location reverseGeocode error

   - Mock reverseGeocode to throw error
   - Create order with seller location coordinates
   - Agent accepts order
   - Expect pickup_address fallback to coordinates string

4. **Lines 1120-1139**: Accept order idempotency - already in "on_the_way"

   - Create order in "on_the_way" status
   - Agent tries to accept again
   - Expect 400 error "Order already accepted"

5. **Lines 1044-1050**: Accept order with agent having active delivery

   - Create agent with assigned_orders >= 1
   - Create order in "offered" status
   - Agent tries to accept
   - Expect 400 error "Agent has active deliveries"

6. **Lines 1086-1095**: Accept order with seller having both location AND place_id
   - Create seller with both location coordinates and place_id
   - Mock placeDetails to return address
   - Create order
   - Agent accepts
   - Expect pickup_address from placeDetails (place_id takes precedence)

#### 1.2 Update Status Payment Branches (5 tests)

**Lines 1317-1400**: Order completion with payment, commission, earnings

**Targeted Tests:**

1. **Lines 1358-1372**: Update status to "delivered" with COD payment

   - Create order with payment_method="COD", payment_amount=500
   - Agent marks as delivered
   - Expect commission calculated, EarningLog created with COD=true

2. **Lines 1372-1386**: Update status to "delivered" with online payment (UPI/razorpay)

   - Create order with payment_method="razorpay", payment_amount=500
   - Agent marks as delivered
   - Expect commission calculated, EarningLog created with COD=false

3. **Lines 1386-1396**: Update status with missing OTP when required

   - Create order with delivery.otp_required=true
   - Agent tries to mark "delivered" without OTP
   - Expect 400 error "OTP required"

4. **Lines 1358-1396**: Commission calculation with multiple products

   - Create order with 3 products (different commission rates)
   - Agent marks as delivered
   - Expect correct total commission calculated

5. **Lines 1317-1335**: Update status with invalid delivery status transition
   - Create order in "pending" status
   - Agent tries to update to "delivered" (skipping "on_the_way", "picked_up")
   - Expect 400 error or status remains "pending"

#### 1.3 Reject Order Reassignment Branches (4 tests)

**Lines 1210-1270**: Reject order with automatic reassignment

**Targeted Tests:**

1. **Lines 1210-1225**: Reject order when only 1 agent available (no reassignment possible)

   - Create 1 active agent
   - Create order assigned to agent
   - Agent rejects order
   - Expect order status="pending", no reassignment

2. **Lines 1230-1248**: Reject order triggers reassignment to nearest agent

   - Create 3 active agents (different distances)
   - Create order assigned to agent1
   - Agent1 rejects order
   - Expect order reassigned to nearest agent (agent2)

3. **Lines 1248-1260**: Reject order reassignment when all agents at capacity

   - Create 3 agents (all at assigned_orders=3)
   - Create order assigned to agent1
   - Agent1 rejects order
   - Expect order status="pending", skipped count increases

4. **Lines 1260-1270**: Reject order with seller location error during reassignment
   - Mock Seller.findById to return null
   - Create order assigned to agent
   - Agent rejects order
   - Expect order marked "pending", reassignment skipped gracefully

#### 1.4 Generate OTP Edge Cases (3 tests)

**Lines 2020-2070**: OTP generation for delivery verification

**Targeted Tests:**

1. **Lines 2020-2030**: Generate OTP for order without client

   - Create order with null client_id
   - Agent requests OTP
   - Expect 400 error "Order has no client"

2. **Lines 2030-2045**: Generate OTP when already generated (idempotent)

   - Create order with delivery.otp already set
   - Agent requests OTP again
   - Expect 200, same OTP returned

3. **Lines 2045-2070**: Generate OTP with phone normalization
   - Create client with phone="+91-9876543210" (with hyphens/spaces)
   - Agent requests OTP
   - Expect phone normalized to "+919876543210", SMS sent

### 🟡 Priority 2: Location & Geocoding Branches (8-10 tests)

**Focus**: Complex geocoding fallbacks, location handling edge cases

#### 2.1 Current Order Geocoding Chains (4 tests)

**Lines 636-850**: Current order endpoint with multiple geocoding paths

**Targeted Tests:**

1. **Lines 733-750**: Current order with seller missing both location and place_id

   - Create seller with no location, no place_id, no address
   - Create assigned order
   - Agent requests current order
   - Expect pickup_address = null or coordinates fallback

2. **Lines 750-780**: Current order with client having place_id

   - Create client with delivery_address.place_id
   - Mock placeDetails to return formatted address
   - Create assigned order
   - Agent requests current order
   - Expect delivery_address from placeDetails

3. **Lines 780-810**: Current order with client location reverseGeocode

   - Create client with delivery_address.location coordinates
   - Mock reverseGeocode to return formatted address
   - Create assigned order
   - Agent requests current order
   - Expect delivery_address from reverseGeocode

4. **Lines 810-834**: Current order with all geocoding disabled
   - Set GEOCODE_SERVER_FALLBACK=false
   - Create order with seller/client having only coordinates
   - Agent requests current order
   - Expect addresses as coordinate strings "(lat, lng)"

#### 2.2 Offers Endpoint Complex Geocoding (3 tests)

**Lines 281-450**: Offers endpoint with seller geocoding chains

**Targeted Tests:**

1. **Lines 373-395**: Offers with seller place_id geocoding chain

   - Create 3 pending orders from 3 sellers (each with place_id)
   - Mock placeDetails for all 3 sellers
   - Agent requests offers
   - Expect all 3 offers with pickup_address from placeDetails

2. **Lines 395-416**: Offers with mixed geocoding (some place_id, some location, some none)

   - Create order1: seller with place_id
   - Create order2: seller with location coordinates only
   - Create order3: seller with no location/place_id
   - Agent requests offers
   - Expect correct geocoding fallback for each offer

3. **Lines 373-416**: Offers with seller address string fallback
   - Create seller with address="123 Main St, City"
   - No location, no place_id
   - Create pending order
   - Agent requests offers
   - Expect pickup_address = seller.address

#### 2.3 Pending Orders Location Fallbacks (2 tests)

**Lines 154-223**: Pending orders with category detection and geocoding

**Targeted Tests:**

1. **Lines 206-218**: Pending orders with client having no place_id but location

   - Create 2 orders: client1 with place_id, client2 with location only
   - Mock both placeDetails and reverseGeocode
   - Request pending orders
   - Expect both orders with correct delivery addresses

2. **Lines 220-223**: Pending orders with coordinate fallback only
   - Create order with client location coordinates
   - Set GEOCODE_SERVER_FALLBACK=false
   - Request pending orders
   - Expect delivery_address as coordinate string

### 🟢 Priority 3: Retry & Timeout Edge Cases (5-7 tests)

**Focus**: Remaining retry system branches, escalation paths

#### 3.1 Retry System Advanced Scenarios (4 tests)

**Lines 2460-2730**: Retry pending orders with complex logic

**Targeted Tests:**

1. **Lines 2500-2530**: Retry with multiple pending orders (batch processing)

   - Create 5 pending orders (created 15+ min ago)
   - Create 3 available agents
   - Call retry endpoint
   - Expect 3 orders assigned to 3 agents, 2 remain pending

2. **Lines 2560-2590**: Retry escalation when order exceeds max retry attempts

   - Create order with assignment_history length = 10 (MAX_RETRY_ATTEMPTS)
   - Create available agents
   - Call retry endpoint
   - Expect order.escalated=true, status unchanged, no assignment

3. **Lines 2640-2660**: Retry with agents sorted by distance (nearest first)

   - Create 5 agents at different distances from seller
   - Create pending order
   - Call retry endpoint
   - Expect order assigned to nearest agent (not least-assigned)

4. **Lines 2700-2730**: Retry with SSE notification failure (non-blocking)
   - Mock SSE publish to throw error
   - Create pending order
   - Create available agent
   - Call retry endpoint
   - Expect order still assigned, error logged but not thrown

#### 3.2 Timeout System Advanced Scenarios (3 tests)

**Lines 2130-2450**: Check timeouts with reassignment logic

**Targeted Tests:**

1. **Lines 2210-2240**: Timeout check with multiple timed-out orders

   - Create 3 orders in "offered" status (assigned 11+ min ago)
   - Create 3 available agents
   - Call check-timeouts endpoint
   - Expect all 3 orders reassigned to different agents

2. **Lines 2270-2310**: Timeout reassignment excluding previously-tried agents

   - Create order with assignment_history=[agent1._id, agent2._id]
   - Order timed out (assigned 11+ min ago)
   - Create 4 agents: agent1, agent2, agent3, agent4
   - Call check-timeouts
   - Expect order reassigned to agent3 or agent4 (not agent1/agent2)

3. **Lines 2350-2400**: Timeout with all agents unavailable (no reassignment)
   - Create order timed out (assigned 11+ min ago)
   - All agents either inactive or at capacity
   - Call check-timeouts
   - Expect order status="pending", timeout_count increments

### 🔵 Priority 4: Miscellaneous Gaps (5-8 tests)

**Focus**: Helper functions, error paths, edge cases

#### 4.1 Toggle Availability Advanced Scenarios (3 tests)

**Lines 1426-1520**: Agent availability toggle with complex state

**Targeted Tests:**

1. **Lines 1460-1480**: Toggle offline with pending offers (not yet assigned)

   - Create agent with 2 pending offers (status="offered")
   - Agent toggles offline
   - Expect pending offers reassigned to other agents

2. **Lines 1480-1500**: Toggle offline with mixed states (active + pending + completed)

   - Create agent with 1 active delivery, 2 pending offers, 1 completed
   - Agent toggles offline with forceOffline=true
   - Expect active order reassigned, pending offers reassigned, completed unchanged

3. **Lines 1426-1441**: Toggle online resets assigned_orders counter
   - Create agent with assigned_orders=5 (offline)
   - Agent toggles online
   - Expect assigned_orders=0, available=true

#### 4.2 Earnings & Logs Edge Cases (3 tests)

**Lines 1514-1650**: Earnings summary and breakdown

**Targeted Tests:**

1. **Lines 1580-1610**: Earnings breakdown with no completed orders

   - Create agent with no completed deliveries
   - Request earnings breakdown
   - Expect empty breakdown array, total_earnings=0

2. **Lines 1610-1640**: Earnings logs pagination with large dataset

   - Create agent with 100 earning logs
   - Request logs with page=5, perPage=10
   - Expect logs 41-50, pagination metadata correct

3. **Lines 1514-1550**: Earnings summary with admin-paid deliveries
   - Create agent with 3 deliveries:
     - Order1: normal COD (earning=$20)
     - Order2: admin_pays_agent=true (earning=$15)
     - Order3: online payment (earning=$18)
   - Request earnings summary
   - Expect total_earnings=$53, COD breakdown correct

#### 4.3 Route Optimization Edge Cases (2 tests)

**Lines 1839-1960**: Route optimization with caching

**Targeted Tests:**

1. **Lines 1900-1930**: Route optimization with custom waypoints

   - Create agent with location
   - Request route with waypoints=[{lat, lng}, {lat, lng}, {lat, lng}]
   - Expect route with 3 waypoints, total distance/duration calculated

2. **Lines 1930-1960**: Route optimization cache hit (TTL validation)
   - Request route optimization for agent1 with order1
   - Wait 30 seconds
   - Request same route again
   - Expect cache hit (no re-calculation), same result returned

---

## 📋 Test File Structure

**File:** `tests/delivery_phase_21_7.test.js`  
**Estimated Lines:** 1200-1400 lines  
**Structure:**

```javascript
// Mock setup (40 lines)
jest.mock("../services/orderEvents");
jest.mock("../services/push");
jest.mock("../services/geocode");

describe("Phase 21.7: Delivery.js Advanced Branch Coverage", () => {
  describe("Priority 1: Accept Order Complex Branches", () => {
    // 6 tests (lines 50-300)
  });

  describe("Priority 1: Update Status Payment Branches", () => {
    // 5 tests (lines 300-500)
  });

  describe("Priority 1: Reject Order Reassignment Branches", () => {
    // 4 tests (lines 500-700)
  });

  describe("Priority 1: Generate OTP Edge Cases", () => {
    // 3 tests (lines 700-850)
  });

  describe("Priority 2: Current Order Geocoding Chains", () => {
    // 4 tests (lines 850-1050)
  });

  describe("Priority 2: Offers Endpoint Complex Geocoding", () => {
    // 3 tests (lines 1050-1200)
  });

  describe("Priority 2: Pending Orders Location Fallbacks", () => {
    // 2 tests (lines 1200-1300)
  });

  describe("Priority 3: Retry System Advanced Scenarios", () => {
    // 4 tests (lines 1300-1500)
  });

  describe("Priority 3: Timeout System Advanced Scenarios", () => {
    // 3 tests (lines 1500-1650)
  });

  describe("Priority 4: Toggle Availability Advanced", () => {
    // 3 tests (lines 1650-1800)
  });

  describe("Priority 4: Earnings & Logs Edge Cases", () => {
    // 3 tests (lines 1800-1950)
  });

  describe("Priority 4: Route Optimization Edge Cases", () => {
    // 2 tests (lines 1950-2050)
  });
});
```

---

## ✅ Validation Checklist (Apply from Phase 21.6)

**Schema Validations** (Must have from start):

- ✅ All Seller instances: email (unique) + business_type (enum)
- ✅ All DeliveryAgent instances: email (unique), name
- ✅ All Order instances: payment.method (enum), payment.amount, delivery.delivery_address.full_address
- ✅ All Client instances: phone (required), firebase_uid

**Field Name Validations**:

- ✅ Use `assignment_history` (not assignment_attempts)
- ✅ Use `assigned_at` (not attempted_at)
- ✅ Use `assigned_orders` field on agents (pre-calculated count)
- ✅ Use `available` (not isAvailable) for agent status

**Mock Setup**:

- ✅ Mock Firebase admin before requiring route
- ✅ Mock geocode service (placeDetails, reverseGeocode)
- ✅ Mock SSE service (publish, publishToSeller)
- ✅ Mock push service (notifyOrderUpdate)

---

## 🎯 Expected Outcomes

**Coverage Targets:**

- **Lines**: 83.64% → **88-92%** (+40-60 lines, +5-8%)
- **Branches**: 69.21% → **73-77%** (+40-80 branches, +4-8%)
- **Tests**: 276 → **310-320** (+34-44 tests)
- **Pass Rate**: **100%** (all tests passing on first or second run)

**Time Estimates:**

- Test planning: 30 min (COMPLETE - this document)
- Test implementation: 90-120 min
- Debugging & fixes: 30-45 min
- Coverage measurement: 15 min
- Documentation: 15 min
- **Total**: 2.5-3.5 hours

**Success Criteria:**

- ✅ All 310-320 tests passing (100% reliability)
- ✅ Lines coverage 88%+ (target 88-92%)
- ✅ Branch coverage 73%+ (target 73-77%)
- ✅ No schema validation errors
- ✅ No production code changes needed
- ✅ Documentation updated (BACKEND_CHANGES_LOG, TEST_COVERAGE_IMPROVEMENT_PLAN, PHASE_21_DELIVERY_100_PERCENT_PLAN)

---

## 🚀 Next Steps

1. **Create Test File** (30 min)

   - Copy Phase 21.6 structure
   - Set up all mocks correctly from start
   - Implement 35-40 tests with correct validations

2. **Run & Debug** (60-90 min)

   - First run: expect 30-35 passing (85%+)
   - Identify logic issues (field names, response expectations)
   - Fix in batch (multi_replace_string_in_file)
   - Second run: expect 100% passing

3. **Measure Coverage** (15 min)

   - Run combined suite: `npx jest tests/delivery.test.js tests/delivery_phase_21_6.test.js tests/delivery_phase_21_7.test.js --coverage`
   - Generate HTML report
   - Verify 88-92% lines achieved

4. **Document Results** (15 min)

   - Update BACKEND_CHANGES_LOG.md
   - Update TEST_COVERAGE_IMPROVEMENT_PLAN.md
   - Update PHASE_21_DELIVERY_100_PERCENT_PLAN.md
   - Update todo list

5. **Plan Phase 21.8** (15 min)
   - Analyze remaining gaps (92% → 95-97%)
   - Identify 20-30 final tests needed
   - Estimate 1.5-2 hours for Phase 21.8

---

## 💡 Key Strategies (Proven in Phase 21.6)

1. **Clean File Creation**: Start with ALL validations correct (saves hours)
2. **Production Code Analysis**: Read actual code before writing tests (prevents field name mistakes)
3. **Batch Fixes**: Group similar issues, fix with multi_replace (efficiency)
4. **Console Logs**: Capture and verify branch logic working correctly
5. **Incremental Testing**: Run tests early, fix issues fast, iterate

**Ready to implement Phase 21.7!** 🎯
