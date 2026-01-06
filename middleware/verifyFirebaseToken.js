/**
 * Firebase Token Verification Middleware
 *
 * This middleware verifies Firebase ID tokens and attaches the decoded user info to req.user
 * It's used to protect routes that require authentication (reviews, wishlist, etc.)
 */

const logger = require("../config/logger");

/**
 * Middleware to verify Firebase ID token from Authorization header
 * Expects: Authorization: Bearer <firebase-id-token>
 * Sets req.user = { uid, email, ... } on success
 */
async function verifyFirebaseToken(req, res, next) {
  try {
    // Check if Firebase Admin SDK is initialized
    if (!global.firebaseAdmin) {
      logger.error("Firebase Admin SDK not initialized");
      return res.status(500).json({
        success: false,
        message: "Authentication service not available",
      });
    }

    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "No authentication token provided",
      });
    }

    const token = authHeader.split("Bearer ")[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication token format",
      });
    }

    // Verify the Firebase ID token
    const decodedToken = await global.firebaseAdmin.auth().verifyIdToken(token);

    // Attach user info to request object
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      phone: decodedToken.phone_number,
      emailVerified: decodedToken.email_verified,
    };

    // Also set firebaseUser for backward compatibility with existing code
    req.firebaseUser = decodedToken;

    logger.logAuth({
      action: "token_verified",
      uid: decodedToken.uid,
      email: decodedToken.email,
    });

    next();
  } catch (error) {
    logger.error("Firebase token verification failed:", error);

    // Handle specific Firebase errors
    if (error.code === "auth/id-token-expired") {
      return res.status(401).json({
        success: false,
        message: "Authentication token expired",
      });
    }

    if (error.code === "auth/id-token-revoked") {
      return res.status(401).json({
        success: false,
        message: "Authentication token revoked",
      });
    }

    if (error.code === "auth/argument-error") {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication token",
      });
    }

    return res.status(401).json({
      success: false,
      message: "Authentication failed",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}

/**
 * Optional authentication middleware
 * Similar to verifyFirebaseToken but doesn't require authentication
 * If token is present and valid, sets req.user
 * If token is missing or invalid, continues without req.user
 */
async function optionalFirebaseToken(req, res, next) {
  try {
    if (!global.firebaseAdmin) {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return next();
    }

    const token = authHeader.split("Bearer ")[1];
    if (!token) {
      return next();
    }

    const decodedToken = await global.firebaseAdmin.auth().verifyIdToken(token);
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      phone: decodedToken.phone_number,
      emailVerified: decodedToken.email_verified,
    };
    req.firebaseUser = decodedToken;

    next();
  } catch (error) {
    // Silent fail - just continue without user
    logger.warn("Optional token verification failed:", error.message);
    next();
  }
}

module.exports = verifyFirebaseToken;
module.exports.optionalFirebaseToken = optionalFirebaseToken;
