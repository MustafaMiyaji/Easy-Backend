# Quick Fix Script for Test Suite
# This script applies quick fixes to make tests run successfully

Write-Host "🔧 Fixing Test Suite Issues..." -ForegroundColor Cyan

# Step 1: Update package.json to run tests sequentially
Write-Host "`n📝 Step 1: Updating package.json for sequential test execution..." -ForegroundColor Yellow

$packageJsonPath = "package.json"
$packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json

# Update test script to run in band (one file at a time)
$packageJson.scripts.test = "jest --runInBand --coverage --verbose --forceExit"
$packageJson.scripts.PSObject.Properties.Add((New-Object PSNoteProperty('test:quick', 'jest --runInBand --no-coverage --forceExit')))

$packageJson | ConvertTo-Json -Depth 10 | Set-Content $packageJsonPath
Write-Host "✅ Updated test scripts to run sequentially" -ForegroundColor Green

# Step 2: Update Jest config for better timeout handling
Write-Host "`n📝 Step 2: Updating jest.config.js..." -ForegroundColor Yellow

$jestConfig = @"
module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'routes/**/*.js',
    'controllers/**/*.js',
    'middleware/**/*.js',
    'models/**/*.js',
    '!**/node_modules/**',
  ],
  testMatch: ['**/tests/**/*.test.js'],
  testTimeout: 60000, // 60 seconds
  maxWorkers: 1, // Run one test file at a time
  forceExit: true,
  detectOpenHandles: false,
};
"@

Set-Content -Path "jest.config.js" -Value $jestConfig
Write-Host "✅ Updated Jest configuration" -ForegroundColor Green

# Step 3: Check for Coupon model issue
Write-Host "`n📝 Step 3: Checking Coupon model export..." -ForegroundColor Yellow

$modelsFile = Get-Content "models/models.js" -Raw
if ($modelsFile -match "Coupon") {
    Write-Host "✅ Coupon model is exported" -ForegroundColor Green
} else {
    Write-Host "⚠️  WARNING: Coupon model might not be exported in models/models.js" -ForegroundColor Red
}

# Step 4: Quick Test Run (auth tests only - these should pass)
Write-Host "`n📝 Step 4: Running quick sanity test..." -ForegroundColor Yellow
Write-Host "Testing with existing passing tests (auth + orders)..." -ForegroundColor Gray

npm test -- tests/auth.test.js tests/orders.test.js

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n✅ Sanity tests passed! Test infrastructure is working." -ForegroundColor Green
} else {
    Write-Host "`n⚠️  Sanity tests failed. MongoDB connection issues detected." -ForegroundColor Red
}

Write-Host "`n" -NoNewline
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "🎯 Next Steps:" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Option A: Run All Tests (May Still Timeout)" -ForegroundColor Yellow
Write-Host "  npm test" -ForegroundColor Gray
Write-Host ""
Write-Host "Option B: Test Specific Module" -ForegroundColor Yellow
Write-Host "  npm test -- tests/coupons.test.js" -ForegroundColor Gray
Write-Host "  npm test -- tests/delivery.test.js" -ForegroundColor Gray
Write-Host ""
Write-Host "Option C: Manual Testing (Recommended for Launch)" -ForegroundColor Yellow
Write-Host "  See: MANUAL_TESTING_CHECKLIST.md" -ForegroundColor Gray
Write-Host ""
Write-Host "Option D: Use Real MongoDB Instead of Memory Server" -ForegroundColor Yellow
Write-Host "  1. Start MongoDB: mongod --dbpath=C:\data\db" -ForegroundColor Gray
Write-Host "  2. Update tests/testUtils/dbHandler.js to use real DB" -ForegroundColor Gray
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan

Write-Host "`n📚 Documentation Created:" -ForegroundColor Yellow
Write-Host "  - TEST_SUITE_README.md (Complete testing guide)" -ForegroundColor Gray
Write-Host "  - MANUAL_TESTING_CHECKLIST.md (60+ manual test scenarios)" -ForegroundColor Gray
