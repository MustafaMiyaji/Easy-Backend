# Phase 25.5: Authentication Flow Manual Testing

**Date**: November 25, 2025  
**Current Coverage**: 91.3% statements, 85.87% branches  
**Target Coverage**: 95%+  
**Estimated Duration**: 1.5 hours

---

## ✅ Manual Test 1: Admin Login with Valid Credentials

### Test Steps:

1. Start backend server (port 3000)
2. Send POST request to `/api/auth/login/admin`
3. Use valid admin credentials

### cURL Command:

```bash
curl -X POST http://localhost:3000/api/auth/login/admin \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@easygrocery.com","password":"Admin@123"}'
```

### Expected Response:

```json
{
  "message": "Login successful",
  "token": "<JWT_TOKEN>",
  "user": {
    "_id": "...",
    "email": "admin@easygrocery.com",
    "name": "Platform Admin"
  }
}
```

### Result:

---

## ✅ Manual Test 2: Seller Login with Valid Credentials

### Test Steps:

1. Send POST request to `/api/auth/login/seller`
2. Use valid seller email/password (JWT-based login)

### cURL Command:

```bash
curl -X POST http://localhost:3000/api/auth/login/seller \
  -H "Content-Type: application/json" \
  -d '{"email":"seller@example.com","password":"Seller@123"}'
```

### Expected Response:

```json
{
  "message": "Login successful",
  "token": "<JWT_TOKEN>",
  "user": {
    "_id": "...",
    "email": "seller@example.com",
    "business_name": "Test Store"
  }
}
```

### Result:

---

## ✅ Manual Test 3: User Login with Firebase Phone Auth

### Test Steps:

1. Send POST request to `/api/auth/whoami` with Firebase token
2. Verify Firebase token validation works

### cURL Command:

```bash
curl -X POST http://localhost:3000/api/auth/whoami \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <FIREBASE_ID_TOKEN>" \
  -d '{}'
```

### Expected Response:

```json
{
  "user": {
    "uid": "firebase_user_id",
    "email": "user@example.com",
    "phone_number": "+1234567890"
  }
}
```

### Result:

---

## ❌ Manual Test 4: Invalid Credentials Rejected

### Test Steps:

1. Send POST request with wrong password
2. Verify 401 Unauthorized response

### cURL Command:

```bash
curl -X POST http://localhost:3000/api/auth/login/admin \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@easygrocery.com","password":"WrongPassword123"}'
```

### Expected Response:

```json
{
  "error": "Invalid credentials"
}
```

### HTTP Status: 401 Unauthorized

### Result:

---

## 🔒 Manual Test 5: Role-Based Access Control

### Test Steps:

1. Login as seller (get JWT token)
2. Try to access admin-only endpoint `/api/admin/orders`
3. Verify 403 Forbidden response

### cURL Commands:

```bash
# Step 1: Login as seller
SELLER_TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login/seller \
  -H "Content-Type: application/json" \
  -d '{"email":"seller@example.com","password":"Seller@123"}' \
  | jq -r '.token')

# Step 2: Try to access admin endpoint
curl -X GET http://localhost:3000/api/admin/orders \
  -H "Authorization: Bearer $SELLER_TOKEN"
```

### Expected Response:

```json
{
  "error": "Access denied - Admin only"
}
```

### HTTP Status: 403 Forbidden

### Result:

---

## 📊 Summary

| Test                   | Status     | Notes                     |
| ---------------------- | ---------- | ------------------------- |
| 1. Admin Login         | ⏳ Pending | Valid credentials         |
| 2. Seller Login        | ⏳ Pending | JWT-based authentication  |
| 3. User Phone Auth     | ⏳ Pending | Firebase token validation |
| 4. Invalid Credentials | ⏳ Pending | 401 error handling        |
| 5. Role-Based Access   | ⏳ Pending | 403 authorization         |

---

## 🎯 Coverage Improvement Plan

After manual tests, we need to add automated tests for uncovered lines:

### Uncovered Lines (from coverage report):

- **Line 23**: JWT_SECRET missing error (`getJwtSecret()`)
- **Line 58**: console.error in client signup (already in test env guard)
- **Line 124**: console.error in seller signup (already in test env guard)
- **Line 143**: Seller validation error handling
- **Lines 319-322**: Reset password - invalid user type
- **Line 327**: Reset password - user not found
- **Line 332**: Reset password - invalid token
- **Line 347-348**: Reset password - expired token
- **Line 381**: Logout - token revocation warning
- **Lines 396-397**: Logout - device token deletion error (non-fatal)
- **Line 515**: Seller ID lookup - empty OR array
- **Lines 517-519**: Seller ID lookup - token user email regex

### Test Cases to Add:

1. ✅ **JWT_SECRET Missing**: Simulate missing environment variable
2. ✅ **Seller Validation Error**: Trigger Mongoose ValidationError
3. ✅ **Reset Password Edge Cases**:
   - Invalid user type in token
   - User not found
   - Invalid reset token
   - Expired reset token
4. ✅ **Logout Error Paths**:
   - Token revocation failure (non-fatal)
   - Device token deletion failure (non-fatal)
5. ✅ **Seller ID Lookup Edge Cases**:
   - Empty OR array (no valid identifiers)
   - Token user email regex matching

---

## 🚀 Next Steps

1. Execute all 5 manual tests above
2. Document results in this file
3. Create `auth_phase25_5.test.js` with ~15-20 new tests
4. Run full test suite to verify 100% reliability
5. Generate coverage report to confirm 95%+ target achieved
6. Update MANUAL_TESTING_CHECKLIST.md (mark authentication as ✅)
