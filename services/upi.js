// UPI functionality removed. Export no-ops to prevent accidental usage.
function buildUpiLink() {
  throw new Error("UPI has been removed. Use COD only.");
}
function getUpiEnv() {
  throw new Error("UPI has been removed. Use COD only.");
}
module.exports = { buildUpiLink, getUpiEnv };
