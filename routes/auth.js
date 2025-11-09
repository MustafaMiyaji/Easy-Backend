const express = require("express");
const {
  Client,
  Seller,
  Admin,
  DeliveryAgent,
  DeviceToken,
} = require("../models/models");
const jwt = require("jsonwebtoken");
const router = express.Router();
const {
  validate,
  sanitize,
  signupSchema,
  loginSchema,
} = require("../middleware/validation");

// Helper function to get JWT secret with runtime check
function getJwtSecret() {
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET environment variable not set");
  }
  return JWT_SECRET;
}

// Client signup - with validation
router.post(
  "/signup/client",
  sanitize,
  validate(signupSchema),
  async (req, res) => {
    try {
      const { name, email, phone, firebase_uid } = req.body;
      const normEmail = String(email || "")
        .toLowerCase()
        .trim();

      // Check if client already exists
      const existingClient = await Client.findOne({ email: normEmail });
      if (existingClient) {
        return res.status(400).json({ error: "Client already exists" });
      }

      // Create new client
      const client = new Client({
        name,
        email: normEmail,
        phone,
        firebase_uid,
        otp_verified: true, // Since we're using Firebase Auth
      });

      await client.save();
      res.status(201).json({ message: "Client created successfully", client });
    } catch (error) {
      console.error("Client signup error:", error);
      res.status(500).json({ error: "Failed to create client" });
    }
  }
);

// Seller signup
router.post("/signup/seller", async (req, res) => {
  try {
    const {
      business_name,
      email,
      phone,
      business_type,
      firebase_uid,
      address,
      location,
      place_id,
    } = req.body;
    const normEmail = String(email || "")
      .toLowerCase()
      .trim();

    // Check if seller already exists
    const existingSeller = await Seller.findOne({ email: normEmail });
    if (existingSeller) {
      return res.status(400).json({ error: "Seller already exists" });
    }

    // Validate mandatory address; location is optional (recommended)
    const hasLocation =
      location &&
      typeof location === "object" &&
      location.lat !== undefined &&
      location.lng !== undefined;
    if (!address || String(address).trim().length === 0) {
      return res
        .status(400)
        .json({ error: "Address is required for seller signup" });
    }

    // Create new seller
    const sellerData = {
      business_name,
      email: normEmail,
      phone,
      business_type,
      firebase_uid,
      approved: false, // Requires admin approval
      address,
      ...(place_id ? { place_id } : {}),
    };
    if (hasLocation) {
      sellerData.location = {
        lat: Number(location.lat),
        lng: Number(location.lng),
      };
    }
    const seller = new Seller(sellerData);

    await seller.save();
    res.status(201).json({ message: "Seller created successfully", seller });
  } catch (error) {
    // Only log errors in non-test environments to reduce test output noise
    if (process.env.NODE_ENV !== "test") {
      console.error("Seller signup error:", error);
    }
    // Return 400 for validation errors, 500 for other errors
    if (error.name === "ValidationError") {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "Failed to create seller" });
  }
});

// Seller email/password login (for admin-created accounts with password) - with validation
router.post(
  "/login/seller",
  sanitize,
  validate(loginSchema),
  async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: "Email and password required" });
      }
      const seller = await Seller.findOne({
        email: String(email).toLowerCase().trim(),
      });
      if (!seller || !(await seller.comparePassword(password))) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      const token = jwt.sign(
        { id: seller._id, role: "seller", email: seller.email },
        getJwtSecret(),
        { expiresIn: "2h" }
      );
      res.json({ success: true, token, seller });
    } catch (e) {
      console.error("Seller login error:", e);
      res.status(500).json({ error: "Login failed" });
    }
  }
);

// Delivery Agent signup
router.post("/signup/delivery-agent", async (req, res) => {
  try {
    const { name, email, phone, firebase_uid, vehicle_type, license_number } =
      req.body;
    const normEmail = String(email || "")
      .toLowerCase()
      .trim();

    // Check if delivery agent already exists
    const existingAgent = await DeliveryAgent.findOne({ email: normEmail });
    if (existingAgent) {
      return res.status(400).json({ error: "Delivery agent already exists" });
    }

    // Create new delivery agent
    const agent = new DeliveryAgent({
      name,
      email: normEmail,
      phone,
      firebase_uid,
      vehicle_type,
      license_number,
      approved: false, // Requires admin approval
    });

    await agent.save();
    res
      .status(201)
      .json({ message: "Delivery agent created successfully", agent });
  } catch (error) {
    console.error("Delivery agent signup error:", error);
    res.status(500).json({ error: "Failed to create delivery agent" });
  }
});

// Get user by Firebase UID
router.get("/user/:firebase_uid", async (req, res) => {
  try {
    const { firebase_uid } = req.params;

    // IMPORTANT: Check privileged roles first so an accidental Client doc
    // created for an admin/seller email does not mask the real role.
    let user = await Admin.findOne({ firebase_uid });
    if (user) return res.json({ type: "admin", user, admin_id: user._id });

    user = await Seller.findOne({ firebase_uid });
    if (user) return res.json({ type: "seller", user, seller_id: user._id });

    user = await DeliveryAgent.findOne({ firebase_uid });
    if (user)
      return res.json({
        type: "delivery_agent",
        user,
        delivery_agent_id: user._id,
      });

    user = await Client.findOne({ firebase_uid });
    if (user) return res.json({ type: "client", user, client_id: user._id });

    res.status(404).json({ error: "User not found" });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ error: "Failed to get user" });
  }
});

// Password reset flow for Seller, DeliveryAgent, and Admin (NOT for Clients who use OTP)
// Step 1: Request password reset
router.post("/forgot-password", async (req, res) => {
  try {
    const { email, userType } = req.body;

    if (!email || !userType) {
      return res.status(400).json({ error: "Email and userType are required" });
    }

    // Only allow password reset for roles that use passwords
    if (!["seller", "delivery_agent", "admin"].includes(userType)) {
      return res.status(400).json({
        error:
          "Password reset is only available for Seller, Delivery Agent, and Admin accounts",
      });
    }

    let Model;
    if (userType === "seller") Model = Seller;
    else if (userType === "delivery_agent") Model = DeliveryAgent;
    else if (userType === "admin") Model = Admin;

    const user = await Model.findOne({ email: email.toLowerCase() });
    if (!user) {
      // Don't reveal if user exists or not for security
      return res.json({
        message:
          "If an account exists with this email, a reset token has been generated",
      });
    }

    // Generate reset token (JWT with 1-hour expiry)
    const resetToken = jwt.sign(
      { userId: user._id, userType, purpose: "password_reset" },
      getJwtSecret(),
      { expiresIn: "1h" }
    );

    // Store reset token and expiry in user document
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour
    await user.save();

    // In production, send this token via email
    // For now, return it in response (REMOVE IN PRODUCTION)
    res.json({
      message: "Password reset token generated",
      resetToken, // TODO: Remove this in production, send via email instead
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ error: "Failed to process password reset request" });
  }
});

// Step 2: Reset password using token
router.post("/reset-password", async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;

    if (!resetToken || !newPassword) {
      return res
        .status(400)
        .json({ error: "Reset token and new password are required" });
    }

    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(resetToken, getJwtSecret());
    } catch (err) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    if (decoded.purpose !== "password_reset") {
      return res.status(400).json({ error: "Invalid token purpose" });
    }

    // Find user based on userType from token
    let Model;
    if (decoded.userType === "seller") Model = Seller;
    else if (decoded.userType === "delivery_agent") Model = DeliveryAgent;
    else if (decoded.userType === "admin") Model = Admin;
    else {
      return res.status(400).json({ error: "Invalid user type in token" });
    }

    const user = await Model.findById(decoded.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if token matches and hasn't expired
    if (user.resetPasswordToken !== resetToken) {
      return res.status(400).json({ error: "Invalid reset token" });
    }

    if (user.resetPasswordExpires < Date.now()) {
      return res.status(400).json({ error: "Reset token has expired" });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and clear reset token
    user.password_hash = hashedPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ message: "Password reset successful" });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

module.exports = router;

// Logout endpoint to support client sign-out flows
// POST /api/auth/logout { firebase_uid?: string, internal_id?: string }
// If Authorization: Bearer <Firebase ID token> is provided and Firebase Admin is initialized,
// the uid from the token is preferred. This route revokes refresh tokens and clears device tokens.
router.post("/logout", async (req, res) => {
  try {
    const admin = global.firebaseAdmin;
    const tokenUid = req.firebaseUser?.uid;
    const bodyUid =
      req.body && req.body.firebase_uid ? String(req.body.firebase_uid) : null;
    const uid = tokenUid || bodyUid;
    if (!uid) {
      return res.status(400).json({
        error:
          "firebase_uid required (or provide Authorization header with ID token)",
      });
    }

    const idsToClear = [uid];
    const internalId =
      req.body && req.body.internal_id ? String(req.body.internal_id) : null;
    if (internalId && internalId.length > 0) idsToClear.push(internalId);

    let revoked = false;
    if (admin && typeof admin.auth === "function") {
      try {
        await admin.auth().revokeRefreshTokens(uid);
        revoked = true;
      } catch (e) {
        // non-fatal; continue to clear device tokens
        console.warn("⚠️ Failed to revoke refresh tokens:", e?.message || e);
      }
    }

    try {
      await DeviceToken.deleteMany({ user_id: { $in: idsToClear } });
    } catch (e) {
      // non-fatal
    }

    return res.json({ ok: true, revoked, cleared_user_ids: idsToClear });
  } catch (e) {
    console.error("logout error", e);
    return res.status(500).json({ error: "failed to logout" });
  }
});

// Map an existing Admin/Seller/Client document to a Firebase UID by email
// Map an existing Admin/Seller/Client/DeliveryAgent document to a Firebase UID by email
// POST /api/auth/map-by-email { email, firebase_uid }
router.post("/map-by-email", async (req, res) => {
  try {
    const { email, firebase_uid } = req.body || {};
    const normEmail = String(email || "")
      .toLowerCase()
      .trim();
    if (!normEmail || !firebase_uid) {
      return res
        .status(400)
        .json({ error: "email and firebase_uid are required" });
    }
    // Helper to escape regex
    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ciQuery = {
      email: { $regex: new RegExp(`^${escapeRegex(normEmail)}$`, "i") },
    };
    const setUpdate = { $set: { firebase_uid, email: normEmail } };

    // Try Admin, then Seller, then DeliveryAgent, then Client (case-insensitive)
    let updated = await Admin.updateOne(ciQuery, setUpdate);
    if (updated.matchedCount === 0) {
      updated = await Seller.updateOne(ciQuery, setUpdate);
    }
    if (updated.matchedCount === 0) {
      updated = await DeliveryAgent.updateOne(ciQuery, setUpdate);
    }
    if (updated.matchedCount === 0) {
      updated = await Client.updateOne(ciQuery, setUpdate);
    }
    if (updated.matchedCount === 0) {
      return res.status(404).json({ error: "No user found with that email" });
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error("Map-by-email error:", error);
    res.status(500).json({ error: "Failed to map by email" });
  }
});

// Convenience endpoint: get only seller_id (or 404) by firebase uid
router.get("/seller-id/:firebase_uid", async (req, res) => {
  try {
    const { firebase_uid } = req.params;
    const seller = await Seller.findOne({ firebase_uid }, { _id: 1 }).lean();
    if (!seller) return res.status(404).json({ error: "Not a seller" });
    return res.json({ seller_id: seller._id });
  } catch (e) {
    res.status(500).json({ error: "Failed to get seller id" });
  }
});

// Lightweight role lookup by email for client-side flows (e.g., forgot password UX)
// GET /api/auth/role-by-email?email=...
router.get("/role-by-email", async (req, res) => {
  try {
    const email = String(req.query.email || "")
      .toLowerCase()
      .trim();
    if (!email || !/.+@.+\..+/.test(email)) {
      return res.status(400).json({ error: "valid email required" });
    }
    // Check privileged roles first
    const regex = new RegExp(
      `^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i"
    );
    const admin = await Admin.findOne(
      { email: { $regex: regex } },
      { _id: 1 }
    ).lean();
    if (admin) return res.json({ role: "admin" });
    const seller = await Seller.findOne(
      { email: { $regex: regex } },
      { _id: 1 }
    ).lean();
    if (seller) return res.json({ role: "seller" });
    const agent = await DeliveryAgent.findOne(
      { email: { $regex: regex } },
      { _id: 1 }
    ).lean();
    if (agent) return res.json({ role: "delivery_agent" });
    const client = await Client.findOne(
      { email: { $regex: regex } },
      { _id: 1 }
    ).lean();
    if (client) return res.json({ role: "client" });
    return res.status(404).json({ error: "not found" });
  } catch (e) {
    console.error("role-by-email error", e);
    res.status(500).json({ error: "failed to lookup role" });
  }
});

// Debug: Who am I? Inspect provided firebase_uid/email or Authorization token (if Firebase Admin is enabled)
// GET /api/auth/whoami?firebase_uid=...&email=...
router.get("/whoami", async (req, res) => {
  try {
    const tokenUser = req.firebaseUser || null; // set by app-level middleware when Firebase Admin is enabled and Authorization header present
    const qUid = String(req.query.firebase_uid || "").trim();
    const qEmailRaw = String(req.query.email || "").trim();
    const qEmail = qEmailRaw ? qEmailRaw.toLowerCase() : "";

    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const emailRegex = qEmail
      ? new RegExp(`^${escapeRegex(qEmail)}$`, "i")
      : null;

    const or = [];
    if (qUid) or.push({ firebase_uid: qUid });
    if (emailRegex) or.push({ email: { $regex: emailRegex } });
    if (tokenUser?.uid && (!qUid || qUid !== tokenUser.uid))
      or.push({ firebase_uid: tokenUser.uid });
    if (tokenUser?.email) {
      const tEmail = String(tokenUser.email).toLowerCase();
      const tRegex = new RegExp(`^${escapeRegex(tEmail)}$`, "i");
      or.push({ email: { $regex: tRegex } });
    }

    if (or.length === 0) {
      return res.status(400).json({
        error:
          "Provide firebase_uid/email query or send a valid Firebase ID token in Authorization header",
      });
    }

    const projection = {
      _id: 1,
      email: 1,
      firebase_uid: 1,
      name: 1,
      business_name: 1,
      approved: 1,
      phone: 1,
    };

    const [admin, seller, agent, client] = await Promise.all([
      Admin.findOne({ $or: or }, projection).lean(),
      Seller.findOne({ $or: or }, projection).lean(),
      DeliveryAgent.findOne({ $or: or }, projection).lean(),
      Client.findOne({ $or: or }, projection).lean(),
    ]);

    // Determine effective role using same priority as /user/:firebase_uid
    let role = null;
    if (admin) role = "admin";
    else if (seller) role = "seller";
    else if (agent) role = "delivery_agent";
    else if (client) role = "client";

    return res.json({
      input: {
        query: { firebase_uid: qUid || null, email: qEmail || null },
        token: tokenUser
          ? { uid: tokenUser.uid, email: tokenUser.email || null }
          : null,
      },
      matches: {
        admin,
        seller,
        delivery_agent: agent,
        client,
      },
      effective_role: role,
      notes:
        role === null
          ? "No matching documents found. If you expect a Seller/Admin record, ensure the email is normalized (lowercase) and mapped to the correct firebase_uid."
          : undefined,
    });
  } catch (e) {
    console.error("whoami error", e);
    res.status(500).json({ error: "failed to resolve identity" });
  }
});
