const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const mongoose = require("mongoose");
const { spawn } = require("child_process");
const path = require("path");
const https = require("https");

// Helper function to get JWT secret with runtime check
function getJwtSecret() {
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET environment variable not set");
  }
  return JWT_SECRET;
}

const {
  Admin,
  Client,
  Seller,
  Product,
  Catalog,
  Order,
  Cart,
  UserAddress,
  DeviceToken,
  DeliveryAgent,
  NotificationCampaign,
  Feedback,
  PlatformSettings,
  EarningLog,
  Alert,
} = require("../models/models");
// Reuse core order state handlers for payment + delivery updates
const {
  verifyPayment,
  updateDelivery,
  buildSnapshot,
} = require("../controllers/ordersController");
const {
  reverseGeocode,
  placeDetails,
  ENABLED: GEO_FALLBACK_ENABLED,
} = require("../services/geocode");

// Rate limiting for admin routes
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: "Too many admin requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Request logging middleware
const logRequest = (req, res, next) => {
  // Capture start time and basic request info
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const method = req.method;
  const path = req.path;
  const ip = req.ip;
  const userAgent = req.get("User-Agent");

  // Log after response is sent (when req.admin is set by requireAdmin middleware)
  res.on("finish", () => {
    if (process.env.NODE_ENV !== "test") {
      const duration = Date.now() - startTime;
      const adminId = req.admin?.id || req.admin?.email || "Anonymous";
      console.log(
        `[ADMIN LOG] ${timestamp} | ${method} ${path} | IP: ${ip} | Admin: ${adminId} | Status: ${res.statusCode} | ${duration}ms | UserAgent: ${userAgent}`
      );
    }
  });

  next();
};

// Apply rate limiting and logging to all admin routes
router.use(adminLimiter);
router.use(logRequest);

// Common filters used by backfill preview/start for detecting missing coordinates
const missingSeller = {
  $or: [
    { "location.lat": { $exists: false } },
    { "location.lng": { $exists: false } },
    { "location.lat": null },
    { "location.lng": null },
    { "location.lat": { $not: { $type: "number" } } },
    { "location.lng": { $not: { $type: "number" } } },
  ],
};
const missingAddr = {
  $or: [
    { "location.lat": { $exists: false } },
    { "location.lng": { $exists: false } },
    { "location.lat": null },
    { "location.lng": null },
    { "location.lat": { $not: { $type: "number" } } },
    { "location.lng": { $not: { $type: "number" } } },
  ],
};
const missingOrderAddr = {
  $or: [
    { "delivery.delivery_address.location.lat": { $exists: false } },
    { "delivery.delivery_address.location.lng": { $exists: false } },
    { "delivery.delivery_address.location.lat": null },
    { "delivery.delivery_address.location.lng": null },
    { "delivery.delivery_address.location.lat": { $not: { $type: "number" } } },
    { "delivery.delivery_address.location.lng": { $not: { $type: "number" } } },
  ],
};

// Admin login endpoint - generates JWT token
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    // Find admin by email
    const admin = await Admin.findOne({ email: email.toLowerCase() });
    if (!admin) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check password with bcrypt; fallback to legacy plaintext then upgrade
    let ok = await admin.comparePassword(password);
    if (!ok && admin.password && admin.password === password) {
      // upgrade legacy plaintext to bcrypt
      admin.password = password;
      await admin.save();
      ok = true;
    }
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        id: admin._id,
        email: admin.email,
        role: "admin",
        exp: Math.floor(Date.now() / 1000) + 2 * 60 * 60, // 2 hours
      },
      getJwtSecret()
    );

    res.json({
      success: true,
      token,
      admin: {
        id: admin._id,
        email: admin.email,
        name: admin.name || admin.email,
        role: admin.role,
      },
    });
  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

// Change admin password (requires current password verification)
router.put("/change-password", requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // Validation
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: "Current password and new password are required",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: "New password must be at least 6 characters long",
      });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({
        error: "New password must be different from current password",
      });
    }

    // Get admin from database (req.admin only has basic info from JWT)
    const adminId = req.admin.id;
    if (!adminId) {
      return res.status(401).json({ error: "Admin ID not found in token" });
    }

    const admin = await Admin.findById(adminId);
    if (!admin) {
      return res.status(404).json({ error: "Admin account not found" });
    }

    // Verify current password
    const isValid = await admin.comparePassword(currentPassword);
    if (!isValid) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    // Update password (pre-save hook will hash it)
    admin.password = newPassword;
    await admin.save();

    res.json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (error) {
    console.error("Admin password change error:", error);
    res.status(500).json({ error: "Failed to change password" });
  }
});

// Middleware to protect admin routes.
// Now supports:
// 1. JWT Bearer tokens (preferred)
// 2. Legacy header x-admin: 1 (dev only)
// 3. API key via Bearer token or x-api-key header
async function requireAdmin(req, res, next) {
  const legacy = req.headers["x-admin"] === "1"; // backward compat (DEV ONLY)
  const apiKey = process.env.ADMIN_API_KEY;
  let providedKey = null;
  const auth = req.headers.authorization || req.headers.Authorization;

  if (auth && /^Bearer /i.test(auth)) {
    const token = auth.split(/\s+/)[1];

    // Try JWT first
    try {
      const decoded = jwt.verify(token, getJwtSecret());
      if (decoded.role === "admin") {
        req.admin = decoded;
        return next();
      }
    } catch (jwtError) {
      // If JWT fails, try as API key
      providedKey = token;
    }
  }

  if (!providedKey && req.headers["x-api-key"]) {
    providedKey = req.headers["x-api-key"];
  }

  // Accept Firebase ID Token if it corresponds to an Admin document
  try {
    if (req.firebaseUser) {
      const uid = req.firebaseUser.uid;
      const email = (req.firebaseUser.email || "").toLowerCase();
      const adminDoc = await Admin.findOne({
        $or: [{ firebase_uid: uid }, ...(email ? [{ email }] : [])],
      }).lean();
      if (adminDoc) {
        req.admin = {
          id: adminDoc._id,
          email: adminDoc.email,
          role: adminDoc.role || "admin",
          source: "firebase",
        };
        return next();
      }
    }
  } catch (e) {
    // fall through to other auth methods
  }

  if (legacy || (apiKey && providedKey && providedKey === apiKey)) {
    req.admin = { role: "admin", source: legacy ? "legacy" : "api-key" };
    return next();
  }

  return res.status(401).json({ error: "admin auth required" });
}

// Generic pagination helper (page & limit)
function parsePagination(req) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

// Date range helper (defaults to last N days)
function parseDateRange(req, { defaultDays = 30 } = {}) {
  let { from, to } = req.query;
  let fromDate = from
    ? new Date(from)
    : new Date(Date.now() - defaultDays * 86400000);
  let toDate = to ? new Date(to) : new Date();
  if (isNaN(fromDate.getTime()))
    fromDate = new Date(Date.now() - defaultDays * 86400000);
  if (isNaN(toDate.getTime())) toDate = new Date();
  return { from: fromDate, to: toDate };
}

// ---------------- Admin Reporting (Advanced) ----------------
// Returns revenue, order count, average order value, top products, daily trend arrays.
router.get("/reporting/overview", requireAdmin, async (req, res) => {
  try {
    const { from, to } = parseDateRange(req, { defaultDays: 30 });
    const matchStage = {
      created_at: { $gte: from, $lte: to },
      status: { $ne: "cancelled" },
    };

    const [agg] = await Order.aggregate([
      { $match: matchStage },
      {
        $facet: {
          core: [
            {
              $group: {
                _id: null,
                totalRevenue: { $sum: "$payment.amount" },
                orderCount: { $sum: 1 },
                avgValue: { $avg: "$payment.amount" },
              },
            },
          ],
          daily: [
            {
              $group: {
                _id: {
                  y: { $year: "$created_at" },
                  m: { $month: "$created_at" },
                  d: { $dayOfMonth: "$created_at" },
                },
                revenue: { $sum: "$payment.amount" },
                orders: { $sum: 1 },
              },
            },
            { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
          ],
          topProducts: [
            { $unwind: "$order_items" },
            {
              $group: {
                _id: "$order_items.product_id",
                qty: { $sum: "$order_items.qty" },
                revenue: {
                  $sum: {
                    $multiply: [
                      "$order_items.qty",
                      "$order_items.price_snapshot",
                    ],
                  },
                },
              },
            },
            { $sort: { revenue: -1 } },
            { $limit: 10 },
          ],
        },
      },
    ]);

    const core =
      agg.core && agg.core[0]
        ? agg.core[0]
        : { totalRevenue: 0, orderCount: 0, avgValue: 0 };
    // Trend arrays (fill missing days)
    const dailyMap = new Map();
    for (const d of agg.daily || []) {
      const key = new Date(d._id.y, d._id.m - 1, d._id.d)
        .toISOString()
        .slice(0, 10);
      dailyMap.set(key, { revenue: d.revenue, orders: d.orders });
    }
    const cursor = new Date(from);
    const trend = [];
    while (cursor <= to) {
      const key = cursor.toISOString().slice(0, 10);
      const val = dailyMap.get(key) || { revenue: 0, orders: 0 };
      trend.push({ date: key, revenue: val.revenue, orders: val.orders });
      cursor.setDate(cursor.getDate() + 1);
    }

    // Enrich top products with names (best effort)
    let enrichedTop = [];
    if (agg.topProducts?.length) {
      const ids = agg.topProducts.map((p) => p._id).filter(Boolean);
      const prodDocs = await Product.find({ _id: { $in: ids } })
        .select("name price seller_id")
        .lean();
      const byId = new Map(prodDocs.map((p) => [String(p._id), p]));
      enrichedTop = agg.topProducts.map((p) => ({
        product_id: p._id,
        name: byId.get(String(p._id))?.name || "Unknown",
        qty: p.qty,
        revenue: p.revenue,
      }));
    }

    res.json({
      range: { from, to },
      metrics: {
        totalRevenue: core.totalRevenue || 0,
        orderCount: core.orderCount || 0,
        averageOrderValue: core.avgValue || 0,
      },
      trend,
      topProducts: enrichedTop,
    });
  } catch (e) {
    console.error("admin reporting overview error", e);
    res.status(500).json({ message: "Failed to build reporting overview" });
  }
});

// ---------------- Fraud Detection (Rule-based signals) ----------------
router.get("/fraud/signals", requireAdmin, async (req, res) => {
  try {
    const { from, to } = parseDateRange(req, { defaultDays: 7 });
    const windowMatch = { created_at: { $gte: from, $lte: to } };
    const orders = await Order.find(windowMatch)
      .select("client_id payment status created_at coupon_code")
      .lean();
    const byClient = new Map();
    for (const o of orders) {
      const cid = o.client_id;
      if (!byClient.has(cid)) byClient.set(cid, []);
      byClient.get(cid).push(o);
    }
    const signals = [];
    for (const [cid, list] of byClient.entries()) {
      const sorted = list.sort(
        (a, b) => new Date(a.created_at) - new Date(b.created_at)
      );
      // Rapid fire: >=3 orders within 10 minutes
      for (let i = 0; i < sorted.length - 2; i++) {
        const a = sorted[i],
          b = sorted[i + 2];
        if (new Date(b.created_at) - new Date(a.created_at) < 10 * 60 * 1000) {
          signals.push({
            type: "rapid_orders",
            client_id: cid,
            window: [a.created_at, b.created_at],
            count: 3,
          });
          break;
        }
      }
      // High-value COD (amount > 2000 and method COD)
      for (const o of sorted) {
        if (o.payment?.method === "COD" && o.payment.amount > 2000) {
          signals.push({
            type: "high_cod_amount",
            client_id: cid,
            order_id: o._id,
            amount: o.payment.amount,
          });
        }
      }
      // Refund rate (>40% refunded of window orders)
      const refunded = sorted.filter(
        (o) => o.status === "refunded" || o.payment?.status === "failed"
      );
      if (refunded.length >= 2 && refunded.length / sorted.length > 0.4) {
        signals.push({
          type: "high_refund_rate",
          client_id: cid,
          refunded: refunded.length,
          total: sorted.length,
        });
      }
    }
    res.json({ from, to, totalSignals: signals.length, signals });
  } catch (e) {
    console.error("admin fraud signals error", e);
    res.status(500).json({ message: "Failed to build fraud signals" });
  }
});

// ---------------- Automated Alerts ----------------
router.post("/alerts/evaluate", requireAdmin, async (req, res) => {
  try {
    const { from, to } = parseDateRange(req, { defaultDays: 1 });
    const todayMatch = {
      created_at: { $gte: from, $lte: to },
      status: { $ne: "cancelled" },
    };
    const prevFrom = new Date(from.getTime() - (to - from) - 1000);
    const prevTo = new Date(from.getTime() - 1000);
    const prevMatch = {
      created_at: { $gte: prevFrom, $lte: prevTo },
      status: { $ne: "cancelled" },
    };
    const [todayAgg, prevAgg] = await Promise.all([
      Order.aggregate([
        { $match: todayMatch },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$payment.amount" },
            orders: { $sum: 1 },
          },
        },
      ]),
      Order.aggregate([
        { $match: prevMatch },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$payment.amount" },
            orders: { $sum: 1 },
          },
        },
      ]),
    ]);
    const todayRevenue = todayAgg[0]?.revenue || 0;
    const prevRevenue = prevAgg[0]?.revenue || 0;
    const alerts = [];
    if (prevRevenue > 0 && todayRevenue < prevRevenue * 0.6) {
      alerts.push({
        type: "revenue_drop",
        severity: "high",
        message: `Revenue dropped ${(
          100 -
          (todayRevenue / prevRevenue) * 100
        ).toFixed(1)}% compared to previous window`,
        meta: { todayRevenue, prevRevenue, from, to },
      });
    }
    const refundedCount = await Order.countDocuments({
      ...todayMatch,
      status: "refunded",
    });
    const todayCount = todayAgg[0]?.orders || 0;
    if (todayCount >= 5 && refundedCount / todayCount > 0.3) {
      alerts.push({
        type: "refund_ratio_high",
        severity: "medium",
        message: `Refund ratio ${((refundedCount / todayCount) * 100).toFixed(
          1
        )}% exceeds threshold`,
        meta: { refundedCount, todayCount, from, to },
      });
    }
    const created = [];
    for (const a of alerts) {
      const exists = await Alert.findOne({
        type: a.type,
        "meta.from": { $gte: prevFrom },
        acknowledged: false,
      }).lean();
      if (!exists) {
        created.push(await Alert.create(a));
      }
    }
    res.json({
      evaluated: alerts.length,
      created: created.length,
      alerts: created,
    });
  } catch (e) {
    console.error("admin alerts evaluate error", e);
    res.status(500).json({ message: "Failed to evaluate alerts" });
  }
});

router.get("/alerts", requireAdmin, async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req);
    const filter = {};
    if (req.query.unacked === "1") filter.acknowledged = false;
    const [total, rows] = await Promise.all([
      Alert.countDocuments(filter),
      Alert.find(filter)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);
    res.json({ page, limit, total, rows });
  } catch (e) {
    console.error("admin alerts list error", e);
    res.status(500).json({ message: "Failed to list alerts" });
  }
});

router.post("/alerts/:id/ack", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id))
      return res.status(400).json({ error: "invalid alert id" });
    const updated = await Alert.findByIdAndUpdate(
      id,
      { $set: { acknowledged: true, acknowledged_at: new Date() } },
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: "alert not found" });
    res.json(updated);
  } catch (e) {
    console.error("admin alert ack error", e);
    res.status(500).json({ message: "Failed to acknowledge alert" });
  }
});

// ---------------- Clients ----------------
router.get("/clients", requireAdmin, async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req);
    const { search } = req.query;
    const filter = {};
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { name: rx },
        { email: rx },
        { phone: rx },
        { firebase_uid: rx },
      ];
    }
    const [total, rows] = await Promise.all([
      Client.countDocuments(filter),
      Client.find(filter)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .select("name email phone firebase_uid created_at")
        .lean(),
    ]);

    // Role tagging enrichment (seller / restaurant / delivery)
    try {
      const emails = Array.from(
        new Set(rows.map((r) => (r.email || "").toLowerCase()).filter(Boolean))
      );
      const phones = Array.from(
        new Set(rows.map((r) => (r.phone || "").trim()).filter(Boolean))
      );
      const [matchedSellers, matchedAgents] = await Promise.all([
        emails.length || phones.length
          ? Seller.find({
              $or: [
                emails.length ? { email: { $in: emails } } : null,
                phones.length ? { phone: { $in: phones } } : null,
              ].filter(Boolean),
            })
              .select("email phone business_type")
              .lean()
          : [],
        emails.length || phones.length
          ? DeliveryAgent.find({
              $or: [
                emails.length ? { email: { $in: emails } } : null,
                phones.length ? { phone: { $in: phones } } : null,
              ].filter(Boolean),
            })
              .select("email phone")
              .lean()
          : [],
      ]);
      const sellerByKey = new Map();
      for (const s of matchedSellers) {
        const keys = [s.email, s.phone].filter(Boolean);
        for (const k of keys) sellerByKey.set(String(k).toLowerCase(), s);
      }
      const agentByKey = new Map();
      for (const a of matchedAgents) {
        const keys = [a.email, a.phone].filter(Boolean);
        for (const k of keys) agentByKey.set(String(k).toLowerCase(), a);
      }
      for (const r of rows) {
        const roles = ["client"]; // base role
        const lookups = [r.email, r.phone]
          .filter(Boolean)
          .map((v) => v.toLowerCase());
        let sellerType = null;
        for (const k of lookups) {
          const s = sellerByKey.get(k);
          if (s) {
            sellerType = s.business_type || "seller";
            break;
          }
        }
        if (sellerType) {
          // Normalize restaurant vs seller
          if (/rest/i.test(sellerType)) roles.push("restaurant");
          else roles.push("seller");
        }
        let isDelivery = false;
        for (const k of lookups) {
          if (agentByKey.has(k)) {
            isDelivery = true;
            break;
          }
        }
        if (isDelivery) roles.push("delivery");
        r.roles = roles;
      }
    } catch (enrichErr) {
      console.warn("client roles enrichment failed", enrichErr);
    }

    res.json({ page, limit, total, rows });
  } catch (e) {
    console.error("admin clients list error", e);
    res.status(500).json({ message: "Failed to list clients" });
  }
});

// ---------------- Sellers ----------------
router.get("/sellers", requireAdmin, async (req, res) => {
  try {
    // Support both: pending=true and status=pending (legacy)
    const isPendingParam =
      req.query.pending === "1" ||
      req.query.pending === "true" ||
      req.query.status === "pending";
    const { search } = req.query;
    const filter = isPendingParam ? { approved: { $ne: true } } : {};
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { business_name: rx },
        { email: rx },
        { phone: rx },
        { business_type: rx },
      ];
    }

    // Legacy behavior: if status=pending is provided and no pagination expected, return a bare array
    const legacyList =
      req.query.status === "pending" && !req.query.page && !req.query.limit;
    if (legacyList) {
      const rows = await Seller.find(filter)
        .sort({ created_at: -1 })
        .select(
          "business_name email phone business_type approved created_at address place_id location"
        )
        .lean();
      return res.json(rows);
    }

    // Default: paginated response
    const { page, limit, skip } = parsePagination(req);
    const [total, rows] = await Promise.all([
      Seller.countDocuments(filter),
      Seller.find(filter)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .select(
          "business_name email phone business_type approved created_at address place_id location"
        )
        .lean(),
    ]);
    res.json({ page, limit, total, rows });
  } catch (e) {
    console.error("admin sellers list error", e);
    res.status(500).json({ message: "Failed to list sellers" });
  }
});

router.patch("/sellers/:id/approve", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id))
      return res.status(400).json({ error: "invalid seller id" });
    const seller = await Seller.findByIdAndUpdate(
      id,
      { $set: { approved: true } },
      { new: true }
    );
    if (!seller) return res.status(404).json({ error: "seller not found" });
    res.json(seller);
  } catch (e) {
    console.error("Error approving seller", e);
    res.status(500).json({ error: "failed to approve seller" });
  }
});

// ---------------- Seller Address Admin Helpers ----------------
// Get a seller by id (address/location/place_id included)
router.get("/sellers/:sellerId", requireAdmin, async (req, res) => {
  try {
    const { sellerId } = req.params;
    if (!mongoose.isValidObjectId(sellerId))
      return res.status(400).json({ error: "invalid seller id" });
    const seller = await Seller.findById(sellerId).select(
      "business_name email phone address location place_id approved created_at"
    );
    if (!seller) return res.status(404).json({ error: "seller not found" });
    res.json({ seller });
  } catch (e) {
    res.status(500).json({
      error: "failed to fetch seller",
      details: e?.message || String(e),
    });
  }
});

// Update a seller's address/location/place_id (same semantics as set-address)
router.patch("/sellers/:sellerId", requireAdmin, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const { address, lat, lng, place_id } = req.body || {};
    if (!mongoose.isValidObjectId(sellerId))
      return res.status(400).json({ error: "invalid seller id" });
    const seller = await Seller.findById(sellerId);
    if (!seller) return res.status(404).json({ error: "seller not found" });

    let newAddress =
      typeof address === "string" && address.trim() ? address.trim() : null;
    let newLat = lat != null ? Number(lat) : undefined;
    let newLng = lng != null ? Number(lng) : undefined;
    let newPlaceId =
      typeof place_id === "string" && place_id.trim()
        ? place_id.trim()
        : undefined;

    if (!newAddress && newPlaceId) {
      try {
        const pd = await placeDetails(newPlaceId);
        if (pd) newAddress = pd;
      } catch (_) {}
    }
    if (
      !newAddress &&
      typeof newLat === "number" &&
      typeof newLng === "number" &&
      GEO_FALLBACK_ENABLED
    ) {
      try {
        const rg = await reverseGeocode(newLat, newLng);
        if (rg) newAddress = rg;
      } catch (_) {}
    }

    if (newAddress) seller.address = newAddress;
    if (typeof newLat === "number" && typeof newLng === "number")
      seller.location = { lat: newLat, lng: newLng };
    if (newPlaceId) seller.place_id = newPlaceId;
    await seller.save();
    res.json({
      ok: true,
      seller: {
        id: seller._id,
        address: seller.address,
        location: seller.location,
        place_id: seller.place_id,
      },
    });
  } catch (e) {
    res.status(500).json({
      error: "failed to update seller",
      details: e?.message || String(e),
    });
  }
});

// Test pickup string resolution for a seller (mirrors delivery endpoints logic)
router.get("/sellers/:sellerId/test-pickup", requireAdmin, async (req, res) => {
  try {
    const { sellerId } = req.params;
    if (!mongoose.isValidObjectId(sellerId))
      return res.status(400).json({ error: "invalid seller id" });
    const s = await Seller.findById(sellerId)
      .select("address location place_id business_name")
      .lean();
    if (!s) return res.status(404).json({ error: "seller not found" });
    let source = "none";
    let pickup = null;
    if (s.address && String(s.address).trim()) {
      pickup = s.address;
      source = "address";
    }
    if (!pickup && GEO_FALLBACK_ENABLED && s.place_id) {
      try {
        const pd = await placeDetails(s.place_id);
        if (pd) {
          pickup = pd;
          source = "place_id";
        }
      } catch (_) {}
    }
    if (
      !pickup &&
      GEO_FALLBACK_ENABLED &&
      s.location &&
      s.location.lat != null &&
      s.location.lng != null
    ) {
      try {
        const rg = await reverseGeocode(
          Number(s.location.lat),
          Number(s.location.lng)
        );
        if (rg) {
          pickup = rg;
          source = "reverse_geocode";
        }
      } catch (_) {}
    }
    if (
      !pickup &&
      s.location &&
      s.location.lat != null &&
      s.location.lng != null
    ) {
      pickup = `${Number(s.location.lat).toFixed(5)}, ${Number(
        s.location.lng
      ).toFixed(5)}`;
      source = "coords";
    }
    if (!pickup) {
      pickup = "Store address";
    }
    res.json({
      seller_id: sellerId,
      business_name: s.business_name,
      pickup_address: pickup,
      source,
      fallback_enabled: GEO_FALLBACK_ENABLED,
    });
  } catch (e) {
    res.status(500).json({
      error: "failed to test pickup",
      details: e?.message || String(e),
    });
  }
});

// Minimal Admin UI page (no auth on HTML; protected JSON calls require Authorization header)
router.get("/ui/sellers", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"/><title>Admin • Sellers</title>
<style>body{font-family:system-ui,Segoe UI,Arial;margin:20px} input,button{font-size:14px} .row{margin:8px 0} .card{border:1px solid #ddd;border-radius:8px;padding:12px;margin:8px 0}</style>
</head><body>
<h2>Admin • Sellers</h2>
<div class="row">Admin JWT: <input id="tok" type="password" style="width:420px" placeholder="Bearer token"/></div>
<div class="row">Search: <input id="q" style="width:320px" placeholder="name/email/phone"/> <button onclick="search()">Search</button></div>
<div id="results"></div>
<hr/>
<div class="card">
  <div class="row">Seller ID: <input id="sid" style="width:360px"/></div>
  <div class="row">Address: <input id="addr" style="width:460px"/></div>
  <div class="row">Lat: <input id="lat" style="width:120px"/> Lng: <input id="lng" style="width:120px"/> Place ID: <input id="pid" style="width:260px"/></div>
  <div class="row"><button onclick="loadSeller()">Load</button> <button onclick="saveSeller()">Save</button> <button onclick="testPickup()">Test pickup</button></div>
  <pre id="out" style="white-space:pre-wrap"></pre>
</div>
<script>
const base = location.origin + '/api/admin';
function h(){ const t=document.getElementById('tok').value.trim(); return t?{ 'Authorization':'Bearer '+t, 'Content-Type':'application/json' }:{ 'Content-Type':'application/json' }; }
async function search(){
  const q=document.getElementById('q').value.trim(); const r=document.getElementById('results'); r.textContent='Loading...';
  const u= base + '/sellers?search=' + encodeURIComponent(q) + '&limit=10&page=1';
  const res= await fetch(u,{ headers:h() }); const js= await res.json(); if(!res.ok){ r.textContent=JSON.stringify(js,null,2); return; }
  const rows= js.rows || js; r.innerHTML = rows.map(x => (
    '<div class="card">'
    + '<b>' + (x.business_name || '-') + '</b><br/>'
    + (x.email || '') + ' ' + (x.phone || '') + '<br/>'
    + '<small>' + x._id + '</small><br/>'
    + '<button onclick="pick(\'' + x._id + '\')">Select</button>'
    + '</div>'
  )).join('');
}
function pick(id){ document.getElementById('sid').value=id; loadSeller(); }
async function loadSeller(){
  const id=document.getElementById('sid').value.trim(); if(!id) return;
  const res= await fetch(base + '/sellers/' + id, { headers:h() }); const js= await res.json();
  document.getElementById('out').textContent = JSON.stringify(js,null,2);
  if(js.seller){ const s=js.seller; document.getElementById('addr').value = s.address||''; document.getElementById('lat').value = s.location?.lat??''; document.getElementById('lng').value = s.location?.lng??''; document.getElementById('pid').value = s.place_id||''; }
}
async function saveSeller(){
  const id=document.getElementById('sid').value.trim(); if(!id) return;
  const body={ address:document.getElementById('addr').value.trim(), lat:document.getElementById('lat').value, lng:document.getElementById('lng').value, place_id:document.getElementById('pid').value.trim() };
  const res= await fetch(base + '/sellers/' + id, { method:'PATCH', headers:h(), body: JSON.stringify(body) }); const js= await res.json();
  document.getElementById('out').textContent = JSON.stringify(js,null,2);
}
async function testPickup(){
  const id=document.getElementById('sid').value.trim(); if(!id) return;
  const res= await fetch(base + '/sellers/' + id + '/test-pickup', { headers:h() }); const js= await res.json();
  document.getElementById('out').textContent = JSON.stringify(js,null,2);
}
</script>
</body></html>`);
});

// ---------------- Products ----------------
router.get("/products", requireAdmin, async (req, res) => {
  try {
    const { search, category, sellerId } = req.query;
    const filter = {};
    if (category) filter.category = new RegExp(`^${category}$`, "i");
    if (sellerId) filter.seller_id = sellerId;
    if (search) filter.name = { $regex: search, $options: "i" };
    const { page, limit, skip } = parsePagination(req);
    const [total, rows] = await Promise.all([
      Product.countDocuments(filter),
      Product.find(filter)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        // include description for richer admin/product UI contexts
        .select("name category price stock status seller_id description")
        .lean(),
    ]);
    res.json({ page, limit, total, rows });
  } catch (e) {
    console.error("admin products list error", e);
    res.status(500).json({ message: "Failed to list products" });
  }
});

// -------- Full deletion helpers (cascade) --------
async function _deleteSellerCascade(sellerDoc, cascade, full) {
  const sellerId = String(sellerDoc._id);
  // delete products
  const productsDel = await Product.deleteMany({ seller_id: sellerId });
  cascade.productsDeleted = productsDel?.deletedCount || 0;
  // optionally delete orders referencing this seller (logical cleanup)
  const ordersDel = await Order.deleteMany({ seller_id: sellerId });
  cascade.ordersDeleted = ordersDel?.deletedCount || 0;
  // device tokens & earnings logs keyed by firebase_uid or _id
  const userIdKey = sellerDoc.firebase_uid || sellerId;
  const tokensDel = await DeviceToken.deleteMany({ user_id: userIdKey });
  cascade.deviceTokensDeleted = tokensDel?.deletedCount || 0;
  const earningsDel = await EarningLog.deleteMany({ seller_id: sellerId });
  cascade.earningsDeleted = earningsDel?.deletedCount || 0;
  if (full && sellerDoc.firebase_uid && global.firebaseAdmin) {
    try {
      await global.firebaseAdmin.auth().deleteUser(sellerDoc.firebase_uid);
      cascade.firebaseUserDeleted = true;
    } catch (fe) {
      cascade.firebaseUserDeleted = false;
      cascade.firebaseDeleteError = fe?.message || String(fe);
    }
  }
  return cascade;
}

async function _deleteDeliveryAgentCascade(agentDoc, cascade, full) {
  const agentId = String(agentDoc._id);
  // remove device tokens by firebase_uid or id
  const userIdKey = agentDoc.firebase_uid || agentId;
  const tokensDel = await DeviceToken.deleteMany({ user_id: userIdKey });
  cascade.deviceTokensDeleted = tokensDel?.deletedCount || 0;
  // Null out delivery assignments on orders referencing this agent
  const ordersUpd = await Order.updateMany(
    { "delivery.delivery_agent_id": agentId },
    {
      $unset: {
        "delivery.delivery_agent_id": "",
        "delivery.delivery_agent_response": "",
      },
    }
  );
  cascade.ordersUpdated = ordersUpd?.modifiedCount || 0;
  if (full && agentDoc.firebase_uid && global.firebaseAdmin) {
    try {
      await global.firebaseAdmin.auth().deleteUser(agentDoc.firebase_uid);
      cascade.firebaseUserDeleted = true;
    } catch (fe) {
      cascade.firebaseUserDeleted = false;
      cascade.firebaseDeleteError = fe?.message || String(fe);
    }
  }
  return cascade;
}

// Distinct product categories for filters
router.get("/product-categories", requireAdmin, async (req, res) => {
  try {
    const cats = await Product.distinct("category", {
      category: { $exists: true, $ne: null },
    });
    // Sort case-insensitively
    cats.sort((a, b) =>
      String(a).toLowerCase().localeCompare(String(b).toLowerCase())
    );
    res.json({ categories: cats });
  } catch (e) {
    console.error("admin product categories error", e);
    res.status(500).json({ error: "failed to load categories" });
  }
});

// ---------------- Settings & Roles ----------------
router.get("/settings", requireAdmin, async (req, res) => {
  try {
    const settings = await PlatformSettings.findOne().lean();
    if (!settings)
      return res.json({
        currency_symbol: "₹",
        locale: "en_IN",
        low_stock_threshold: 5,
        order_status_notifications: true,
        delivery_charge_grocery: 30,
        delivery_charge_food: 40,
        min_total_for_delivery_charge: 100,
        free_delivery_threshold: 0,
        free_delivery_admin_compensation: false,
        free_delivery_agent_payment: 0,
        coupons: [],
      });
    res.json(settings);
  } catch (e) {
    console.error("admin settings get error", e);
    res.status(500).json({ error: "failed to get settings" });
  }
});

router.put("/settings", requireAdmin, async (req, res) => {
  try {
    // Sanitize coupons payload if provided
    const update = { ...req.body, updated_at: new Date() };
    // Coerce numeric settings
    if (update.delivery_charge_grocery !== undefined) {
      update.delivery_charge_grocery = Math.max(
        0,
        Number(update.delivery_charge_grocery) || 0
      );
    }
    if (update.delivery_charge_food !== undefined) {
      update.delivery_charge_food = Math.max(
        0,
        Number(update.delivery_charge_food) || 0
      );
    }
    if (update.min_total_for_delivery_charge !== undefined) {
      update.min_total_for_delivery_charge = Math.max(
        0,
        Number(update.min_total_for_delivery_charge) || 0
      );
    }
    if (update.free_delivery_threshold !== undefined) {
      update.free_delivery_threshold = Math.max(
        0,
        Number(update.free_delivery_threshold) || 0
      );
    }
    if (update.free_delivery_agent_payment !== undefined) {
      update.free_delivery_agent_payment = Math.max(
        0,
        Number(update.free_delivery_agent_payment) || 0
      );
    }
    if (update.free_delivery_admin_compensation !== undefined) {
      update.free_delivery_admin_compensation = Boolean(
        update.free_delivery_admin_compensation
      );
    }
    if (update.low_stock_threshold !== undefined) {
      update.low_stock_threshold = Math.max(
        0,
        parseInt(update.low_stock_threshold) || 0
      );
    }
    if (Array.isArray(update.coupons)) {
      update.coupons = update.coupons
        .filter((c) => c && typeof c.code === "string" && c.code.trim())
        .map((c) => ({
          code: String(c.code).toUpperCase().trim(),
          percent: Math.max(0, Math.min(100, Number(c.percent) || 0)),
          active: c.active !== false,
          minSubtotal: Math.max(0, Number(c.minSubtotal || 0)),
          validFrom: c.validFrom ? new Date(c.validFrom) : undefined,
          validTo: c.validTo ? new Date(c.validTo) : undefined,
          categories: Array.isArray(c.categories)
            ? c.categories
                .map((v) =>
                  String(v || "")
                    .toLowerCase()
                    .trim()
                )
                .filter((v) => ["grocery", "vegetable", "food"].includes(v))
            : undefined,
        }));
    }
    const doc = await PlatformSettings.findOneAndUpdate(
      {},
      { $set: update },
      { new: true, upsert: true }
    );
    res.json(doc);
  } catch (e) {
    console.error("admin settings update error", e);
    res.status(500).json({ error: "failed to update settings" });
  }
});

// ---------------- Device Tokens & Test Push ----------------
// Helper: resolve candidate user ids by email (checks Admin/Client/Seller/DeliveryAgent)
async function _resolveUserIdsByEmail(email) {
  const e = String(email || "")
    .toLowerCase()
    .trim();
  if (!e) return [];
  const [admins, clients, sellers, agents] = await Promise.all([
    Admin.find({ email: e }).select("_id firebase_uid").lean(),
    Client.find({ email: e }).select("_id firebase_uid").lean(),
    Seller.find({ email: e }).select("_id firebase_uid").lean(),
    DeliveryAgent.find({ email: e }).select("_id firebase_uid").lean(),
  ]);
  const ids = [];
  for (const col of [admins, clients, sellers, agents]) {
    for (const doc of col) {
      if (doc._id) ids.push(String(doc._id));
      if (doc.firebase_uid) ids.push(String(doc.firebase_uid));
    }
  }
  return Array.from(new Set(ids));
}

// GET /api/admin/device-tokens?userId=...&email=...&limit=50
router.get("/device-tokens", requireAdmin, async (req, res) => {
  try {
    const { userId, email } = req.query || {};
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    let userIds = [];
    if (userId) userIds.push(String(userId));
    if (email) {
      const resolved = await _resolveUserIdsByEmail(email);
      userIds.push(...resolved);
    }
    const filter = userIds.length
      ? { user_id: { $in: Array.from(new Set(userIds)) } }
      : {};
    const rows = await DeviceToken.find(filter)
      .sort({ last_seen: -1 })
      .limit(limit)
      .select("user_id token platform last_seen")
      .lean();
    res.json({ count: rows.length, rows });
  } catch (e) {
    console.error("admin device-tokens error", e);
    res.status(500).json({ error: "failed to list tokens" });
  }
});

// Quick debug: list device tokens for a client Firebase UID
router.get("/device-tokens/by-client", requireAdmin, async (req, res) => {
  try {
    const uid = (req.query.uid || "").toString();
    if (!uid) return res.status(400).json({ error: "uid required" });
    const rows = await DeviceToken.find({ user_id: uid })
      .sort({ last_seen: -1 })
      .select("user_id token platform last_seen")
      .lean();
    res.json({ count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ error: "failed to list client tokens" });
  }
});

// POST /api/admin/test-push { token? , userId? , email? , title? , body? , route? , data? }
router.post("/test-push", requireAdmin, async (req, res) => {
  try {
    const adminSdk = global.firebaseAdmin;
    if (!adminSdk || !adminSdk.messaging) {
      return res.status(503).json({ error: "Firebase Admin not initialized" });
    }
    const { token, userId, email } = req.body || {};
    let tokens = [];
    if (token) tokens.push(String(token));
    if ((userId && !token) || (email && !token)) {
      let userIds = [];
      if (userId) userIds.push(String(userId));
      if (email) {
        const resolved = await _resolveUserIdsByEmail(email);
        userIds.push(...resolved);
      }
      if (userIds.length) {
        const rows = await DeviceToken.find({
          user_id: { $in: Array.from(new Set(userIds)) },
        })
          .sort({ last_seen: -1 })
          .limit(500)
          .select("token")
          .lean();
        tokens = rows.map((r) => r.token);
      }
    }
    tokens = Array.from(new Set(tokens));
    if (!tokens.length)
      return res.status(404).json({ error: "no tokens found" });

    const title = req.body?.title || "Easy App Test";
    const body = req.body?.body || "Hello from FCM v1";
    const route = req.body?.route || "/loading";
    const extraData =
      req.body?.data && typeof req.body.data === "object" ? req.body.data : {};

    // Ensure string data for FCM v1
    const data = {
      route,
      type: "test",
      android_channel_id: "orders_updates",
      click_action: "FLUTTER_NOTIFICATION_CLICK",
    };
    for (const [k, v] of Object.entries(extraData))
      data[k] = typeof v === "string" ? v : JSON.stringify(v);

    // Chunk send (<=500 per request)
    const chunks = [];
    for (let i = 0; i < tokens.length; i += 500)
      chunks.push(tokens.slice(i, i + 500));
    let successCount = 0,
      failureCount = 0;
    const results = [];
    for (const chunk of chunks) {
      const message = {
        tokens: chunk,
        notification: { title, body },
        data,
        android: {
          priority: "high",
          notification: {
            channelId: "orders_updates",
            clickAction: "FLUTTER_NOTIFICATION_CLICK",
            sound: "default",
          },
        },
      };
      const resp = await adminSdk.messaging().sendEachForMulticast(message);
      successCount += resp.successCount || 0;
      failureCount += resp.failureCount || 0;
      results.push({
        successCount: resp.successCount,
        failureCount: resp.failureCount,
      });
    }
    res.json({
      ok: true,
      sent: successCount,
      failed: failureCount,
      batches: results.length,
      results,
    });
  } catch (e) {
    console.error("admin test-push error", e);
    res.status(500).json({ error: e?.message || "failed to send test push" });
  }
});

// ---------------- Migrations / Backfill Tools ----------------
// Simple in-memory progress tracking for backfill script run via child process
let backfillJob = {
  running: false,
  pid: null,
  phase: "idle", // sellers | addresses | done | error | idle
  total: null, // estimated total records to process
  scanned: 0,
  updated: 0,
  startedAt: null,
  endedAt: null,
  exitCode: null,
  logs: [],
  error: null,
};

function _appendLog(line) {
  try {
    backfillJob.logs.push(line);
    if (backfillJob.logs.length > 200) backfillJob.logs.shift();
    // very rough phase detection
    if (/Backfill Summary/i.test(line)) backfillJob.phase = "done";
    // progress heuristics: count success and failures as scanned
    if (/^✅ /.test(line) || /^⚠️/.test(line) || /^❌/.test(line)) {
      backfillJob.scanned++;
      if (/^✅ /.test(line)) backfillJob.updated++;
    }
  } catch (_) {}
}

router.post(
  "/migrations/backfill-locations/start",
  requireAdmin,
  async (req, res) => {
    try {
      if (backfillJob.running) {
        return res.status(409).json({ error: "backfill already running" });
      }
      const { limit, preferPlaceDetails } = req.body || {};

      // Estimate totals upfront (best effort)
      const [sellersToFix, addrsToFix, ordersToFix] = await Promise.all([
        Seller.countDocuments(missingSeller),
        UserAddress.countDocuments(missingAddr),
        Order.countDocuments(missingOrderAddr),
      ]);

      backfillJob = {
        running: true,
        pid: null,
        phase: "sellers",
        total: sellersToFix + addrsToFix + ordersToFix,
        scanned: 0,
        updated: 0,
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        logs: [],
        error: null,
      };

      const backendDir = path.join(__dirname, "..");
      const nodeExec = process.execPath; // current Node
      const scriptPath = path.join(
        backendDir,
        "scripts",
        "backfill_locations.js"
      );
      const env = { ...process.env };
      if (typeof limit !== "undefined") env.BACKFILL_LIMIT = String(limit);
      if (preferPlaceDetails === false) env.PREFER_PLACE_DETAILS = "0";

      const child = spawn(nodeExec, [scriptPath], { cwd: backendDir, env });
      backfillJob.pid = child.pid;

      child.stdout.on("data", (buf) => {
        const text = buf.toString();
        text.split(/\r?\n/).forEach((line) => {
          if (!line) return;
          _appendLog(line);
        });
      });
      child.stderr.on("data", (buf) => {
        const text = buf.toString();
        text.split(/\r?\n/).forEach((line) => {
          if (!line) return;
          _appendLog(`[err] ${line}`);
        });
      });
      child.on("exit", (code) => {
        backfillJob.exitCode = code;
        backfillJob.endedAt = new Date();
        backfillJob.running = false;
        backfillJob.phase = code === 0 ? "done" : "error";
      });

      res.json({ ok: true, pid: child.pid, total: backfillJob.total });
    } catch (e) {
      console.error("start backfill error", e);
      backfillJob.running = false;
      backfillJob.phase = "error";
      backfillJob.error = e?.message || String(e);
      backfillJob.endedAt = new Date();
      return res.status(500).json({ error: "failed to start backfill" });
    }
  }
);

router.get(
  "/migrations/backfill-locations/progress",
  requireAdmin,
  (req, res) => {
    const { logs, ...rest } = backfillJob;
    res.json({ ...rest, logs: logs.slice(-50) });
  }
);

// Preview count: how many seller/user addresses missing coords (without starting job)
router.get(
  "/migrations/backfill-locations/preview-count",
  requireAdmin,
  async (req, res) => {
    try {
      const [sellersToFix, addrsToFix, ordersToFix] = await Promise.all([
        Seller.countDocuments(missingSeller),
        UserAddress.countDocuments(missingAddr),
        Order.countDocuments(missingOrderAddr),
      ]);
      res.json({
        sellers_missing: sellersToFix,
        addresses_missing: addrsToFix,
        orders_missing: ordersToFix,
        total_missing: sellersToFix + addrsToFix + ordersToFix,
      });
    } catch (e) {
      res.status(500).json({ error: "failed to compute preview counts" });
    }
  }
);

router.get(
  "/migrations/backfill-locations/stream",
  requireAdmin,
  (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const interval = setInterval(() => {
      res.write(`data: ${JSON.stringify(backfillJob)}\n\n`);
      if (backfillJob.phase === "done" || backfillJob.phase === "error") {
        clearInterval(interval);
        res.write(`data: ${JSON.stringify(backfillJob)}\n\n`);
        res.end();
      }
    }, 1000);
    req.on("close", () => clearInterval(interval));
  }
);

// -------- One-off repair: fix a specific order's delivery address coords --------
async function _httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (resp) => {
        let data = "";
        resp.on("data", (chunk) => (data += chunk));
        resp.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function _geocodeAddress(address, key) {
  if (!address || !address.trim()) return null;
  let base = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    address
  )}`;
  // Optional bias by components, e.g., country:IN (set GOOGLE_GEOCODE_COMPONENTS or GEO_COUNTRY)
  const comp = process.env.GOOGLE_GEOCODE_COMPONENTS || process.env.GEO_COUNTRY;
  if (comp) {
    const val = comp.includes("=") ? comp : `country:${comp}`;
    base += `&components=${encodeURIComponent(val)}`;
  }
  const url = `${base}&key=${key}`;
  const data = await _httpGetJson(url);
  if (data.status !== "OK") return null;
  const first = data.results?.[0];
  const loc = first?.geometry?.location;
  const formatted = first?.formatted_address;
  return loc ? { lat: loc.lat, lng: loc.lng, formatted } : null;
}

async function _placeDetails(placeId, key) {
  if (!placeId) return null;
  const fields = "geometry,formatted_address"; // include formatted address
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(
    placeId
  )}&fields=${fields}&key=${key}`;
  const data = await _httpGetJson(url);
  if (data.status !== "OK") return null;
  const result = data.result;
  const loc = result?.geometry?.location;
  const formatted = result?.formatted_address;
  return loc ? { lat: loc.lat, lng: loc.lng, formatted } : null;
}

function _parseLatLngText(text) {
  if (typeof text !== "string") return null;
  const m = text
    .trim()
    .match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const plat = Number(m[1]);
  const plng = Number(m[2]);
  if (Number.isNaN(plat) || Number.isNaN(plng)) return null;
  return { lat: plat, lng: plng };
}

router.post("/orders/:orderId/fix-address", requireAdmin, async (req, res) => {
  try {
    const GOOGLE_KEY =
      process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || "";
    if (!GOOGLE_KEY) {
      return res
        .status(400)
        .json({ error: "GOOGLE_MAPS_API_KEY not configured on server" });
    }
    const { orderId } = req.params;
    const { address, lat, lng, place_id } = req.body || {};
    let order = null;
    // Accept either Mongo _id or custom order_id/id
    if (mongoose.isValidObjectId(orderId)) {
      order = await Order.findById(orderId);
    }
    if (!order) {
      order = await Order.findOne({
        $or: [
          { order_id: orderId },
          { id: orderId },
          ...(mongoose.isValidObjectId(orderId) ? [{ _id: orderId }] : []),
        ],
      });
    }
    if (!order) return res.status(404).json({ error: "Order not found" });

    order.delivery = order.delivery || {};
    order.delivery.delivery_address = order.delivery.delivery_address || {};
    const da = order.delivery.delivery_address;

    // 1) Determine UA, if any
    let ua = null;
    if (da.address_id) {
      try {
        ua = await UserAddress.findById(da.address_id);
      } catch (_) {}
    }
    if (
      !ua &&
      typeof da.full_address === "string" &&
      /^[0-9a-fA-F]{24}$/.test(da.full_address)
    ) {
      try {
        ua = await UserAddress.findById(da.full_address);
      } catch (_) {}
    }

    // 2) Direct lat/lng in body
    const nlat = typeof lat === "string" ? Number(lat) : lat;
    const nlng = typeof lng === "string" ? Number(lng) : lng;
    if (
      typeof nlat === "number" &&
      typeof nlng === "number" &&
      !Number.isNaN(nlat) &&
      !Number.isNaN(nlng)
    ) {
      da.location = { lat: nlat, lng: nlng };
      await order.save();
      let uaUpdated = false;
      if (
        ua &&
        (!ua.location ||
          typeof ua.location.lat !== "number" ||
          typeof ua.location.lng !== "number")
      ) {
        ua.location = { lat: nlat, lng: nlng };
        await ua.save();
        uaUpdated = true;
      }
      return res.json({
        ok: true,
        order_id: String(order._id),
        location: { lat: nlat, lng: nlng },
        uaUpdated,
        method: "direct",
      });
    }

    // 3) Derive address string
    let addr =
      typeof address === "string" && address.trim() ? address.trim() : "";
    if (!addr && ua) {
      const parts = [
        ua.full_address,
        ua.street,
        ua.city,
        ua.state,
        ua.pincode,
      ].filter((x) => x && String(x).trim().length > 0);
      addr = parts.join(", ");
    }
    if (
      !addr &&
      typeof da.full_address === "string" &&
      !/^[0-9a-fA-F]{24}$/.test(da.full_address)
    ) {
      addr = da.full_address.trim();
    }

    // 4) If address is "lat,lng" text
    const parsed = _parseLatLngText(addr);
    if (parsed) {
      da.location = { lat: parsed.lat, lng: parsed.lng };
      await order.save();
      let uaUpdated = false;
      if (
        ua &&
        (!ua.location ||
          typeof ua.location.lat !== "number" ||
          typeof ua.location.lng !== "number")
      ) {
        ua.location = { lat: parsed.lat, lng: parsed.lng };
        await ua.save();
        uaUpdated = true;
      }
      return res.json({
        ok: true,
        order_id: String(order._id),
        location: parsed,
        uaUpdated,
        method: "coords-from-text",
      });
    }

    // 5) Reuse UA coords if present
    let loc = null;
    if (
      ua &&
      ua.location &&
      typeof ua.location.lat === "number" &&
      typeof ua.location.lng === "number"
    ) {
      loc = { lat: ua.location.lat, lng: ua.location.lng };
    }

    // 6) Try Place Details if any place_id available
    if (!loc) {
      const pId = place_id || ua?.place_id || da.place_id;
      if (pId) {
        loc = await _placeDetails(pId, GOOGLE_KEY);
      }
    }

    // 7) Geocode address text
    if (!loc) {
      if (!addr) {
        return res.status(400).json({
          error:
            "No address available to geocode. Provide 'address', 'lat/lng', or 'place_id'.",
        });
      }
      loc = await _geocodeAddress(addr, GOOGLE_KEY);
    }
    if (!loc) {
      return res
        .status(400)
        .json({ error: "Geocoding failed for provided/resolved address" });
    }

    // 8) Persist
    da.location = { lat: loc.lat, lng: loc.lng };
    if (loc.formatted) {
      da.full_address = loc.formatted;
    } else if (addr) {
      // fallback: store provided text if no formatted available
      da.full_address = addr;
    }
    await order.save();
    let uaUpdated = false;
    if (
      ua &&
      (!ua.location ||
        typeof ua.location.lat !== "number" ||
        typeof ua.location.lng !== "number")
    ) {
      ua.location = { lat: loc.lat, lng: loc.lng };
      await ua.save();
      uaUpdated = true;
    }
    return res.json({
      ok: true,
      order_id: String(order._id),
      location: loc,
      uaUpdated,
      method: "geocode",
    });
  } catch (e) {
    console.error("admin fix-address error", e);
    return res.status(500).json({ error: "failed to fix address" });
  }
});

// Get available delivery agents for an order with distance calculation
router.get(
  "/orders/:orderId/available-agents",
  requireAdmin,
  async (req, res) => {
    try {
      const { orderId } = req.params;

      // Resolve order
      let order = null;
      if (mongoose.isValidObjectId(orderId)) {
        order = await Order.findById(orderId);
      }
      if (!order) {
        order = await Order.findOne({
          $or: [
            { order_id: orderId },
            { id: orderId },
            ...(mongoose.isValidObjectId(orderId) ? [{ _id: orderId }] : []),
          ],
        });
      }
      if (!order) return res.status(404).json({ error: "Order not found" });

      // Check if order payment is completed
      if (order.payment?.status !== "paid") {
        return res.status(400).json({
          error: "Order must be paid before viewing available agents",
        });
      }

      // Get seller location
      const sellerId = order.seller_id;
      const seller = await Seller.findById(sellerId);
      if (!seller || !seller.location || !seller.location.coordinates) {
        return res.status(400).json({ error: "Seller location not available" });
      }

      const [sellerLng, sellerLat] = seller.location.coordinates;

      // Helper function to calculate distance (Haversine formula)
      function calculateDistance(lat1, lng1, lat2, lng2) {
        const R = 6371; // Earth's radius in km
        const dLat = ((lat2 - lat1) * Math.PI) / 180;
        const dLng = ((lng2 - lng1) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLng / 2) *
            Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
      }

      // Get all approved delivery agents
      const agents = await DeliveryAgent.find({ approved: true })
        .select("_id name email phone active available location")
        .lean();

      // Calculate distance and format response
      const agentsWithDistance = agents.map((agent) => {
        let distance = null;
        if (
          agent.location &&
          agent.location.coordinates &&
          agent.location.coordinates.length === 2
        ) {
          const [agentLng, agentLat] = agent.location.coordinates;
          distance = calculateDistance(
            sellerLat,
            sellerLng,
            agentLat,
            agentLng
          );
        }

        return {
          id: agent._id.toString(),
          name: agent.name || "Unnamed Agent",
          email: agent.email || "",
          phone: agent.phone || "",
          distance: distance !== null ? parseFloat(distance.toFixed(2)) : null,
          online: agent.active && agent.available,
          active: agent.active,
          available: agent.available,
        };
      });

      // Sort by distance (closest first), then by online status
      agentsWithDistance.sort((a, b) => {
        // Online agents first
        if (a.online !== b.online) return b.online ? 1 : -1;
        // Then by distance (nulls last)
        if (a.distance === null && b.distance === null) return 0;
        if (a.distance === null) return 1;
        if (b.distance === null) return -1;
        return a.distance - b.distance;
      });

      res.json({ agents: agentsWithDistance });
    } catch (e) {
      console.error("Get available agents error", e);
      res.status(500).json({ error: "Failed to get available agents" });
    }
  }
);

// Manual delivery agent assignment (fallback when auto-assignment fails)
router.post(
  "/orders/:orderId/assign-delivery-agent",
  requireAdmin,
  async (req, res) => {
    try {
      const { orderId } = req.params;
      const { agent_id, agent_email, force } = req.body || {};
      if (!agent_id && !agent_email) {
        return res
          .status(400)
          .json({ error: "agent_id or agent_email required" });
      }
      // Resolve order
      let order = null;
      if (mongoose.isValidObjectId(orderId)) {
        order = await Order.findById(orderId);
      }
      if (!order) {
        order = await Order.findOne({
          $or: [
            { order_id: orderId },
            { id: orderId },
            ...(mongoose.isValidObjectId(orderId) ? [{ _id: orderId }] : []),
          ],
        });
      }
      if (!order) return res.status(404).json({ error: "Order not found" });

      // Basic payment validation: only assign paid COD orders
      if (order.payment?.status !== "paid") {
        return res
          .status(400)
          .json({ error: "Order must be paid before manual assignment" });
      }
      order.delivery = order.delivery || {};

      // Resolve agent
      let agent = null;
      if (agent_id && mongoose.isValidObjectId(agent_id)) {
        agent = await DeliveryAgent.findById(agent_id);
      }
      if (!agent && agent_email) {
        agent = await DeliveryAgent.findOne({
          email: agent_email.toLowerCase(),
        });
      }
      if (!agent)
        return res.status(404).json({ error: "Delivery agent not found" });

      if (!agent.approved) {
        return res.status(400).json({ error: "Agent not approved" });
      }
      if ((!agent.active || !agent.available) && !force) {
        return res.status(400).json({
          error: "Agent not online/available (use force to override)",
        });
      }

      // If already assigned to same agent, just return snapshot
      if (
        String(order.delivery.delivery_agent_id || "") === String(agent._id)
      ) {
        const existingSnap = buildSnapshot(order);
        return res.json({
          ok: true,
          order_id: String(order._id),
          agent_id: String(agent._id),
          already_assigned: true,
          snapshot: existingSnap,
        });
      }

      // Decrement previous agent counter if changing assignment
      const prevAgentId = order.delivery.delivery_agent_id;
      if (prevAgentId && prevAgentId.toString() !== agent._id.toString()) {
        try {
          await DeliveryAgent.findByIdAndUpdate(prevAgentId, {
            $inc: { assigned_orders: -1 },
          });
        } catch (_) {}
      }

      // Apply assignment
      order.delivery.delivery_agent_id = agent._id;
      order.delivery.delivery_agent_response = "pending";
      if (order.delivery.delivery_status === "pending") {
        order.delivery.delivery_status = "assigned";
      }
      order.delivery.assignment_history = Array.isArray(
        order.delivery.assignment_history
      )
        ? order.delivery.assignment_history
        : [];
      order.delivery.assignment_history.push({
        agent_id: agent._id,
        assigned_at: new Date(),
        response: "pending",
      });
      await order.save();

      // Increment agent counter
      await DeliveryAgent.findByIdAndUpdate(agent._id, {
        $inc: { assigned_orders: 1 },
      });

      // Publish SSE snapshot (order + seller)
      let snapshot = null;
      try {
        snapshot = buildSnapshot(order);
        publish(String(order._id), snapshot);
        if (snapshot.seller_id)
          publishToSeller(String(snapshot.seller_id), snapshot);
      } catch (pubErr) {
        console.warn("Manual assign publish error", pubErr);
      }

      res.json({
        ok: true,
        order_id: String(order._id),
        agent_id: String(agent._id),
        snapshot,
      });
    } catch (e) {
      console.error("manual assign error", e);
      res
        .status(500)
        .json({ error: "Failed to manually assign delivery agent" });
    }
  }
);

router.post("/migrations/backfill-locations/stop", requireAdmin, (req, res) => {
  try {
    if (!backfillJob.running || !backfillJob.pid) {
      return res.status(400).json({ error: "no running job" });
    }
    process.kill(backfillJob.pid);
    backfillJob.running = false;
    backfillJob.phase = "error";
    backfillJob.error = "terminated";
    backfillJob.endedAt = new Date();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "failed to stop job" });
  }
});

router.get("/roles", requireAdmin, async (req, res) => {
  try {
    const admins = await Admin.find().select("email role created_at").lean();
    res.json({ admins });
  } catch (e) {
    console.error("admin roles list error", e);
    res.status(500).json({ error: "failed to list roles" });
  }
});

router.post("/roles", requireAdmin, async (req, res) => {
  try {
    const { email, role, password } = req.body || {};
    if (!email || !/^.+@.+\..+$/.test(email))
      return res.status(400).json({ error: "valid email required" });
    if (!role || !["superadmin", "moderator"].includes(role))
      return res.status(400).json({ error: "invalid role" });
    if (!password || typeof password !== "string" || password.length < 4)
      return res.status(400).json({ error: "password required (min 4 chars)" });
    const existing = await Admin.findOne({ email: email.toLowerCase() });
    if (existing)
      return res.status(409).json({ error: "admin already exists" });
    const toCreate = { email: email.toLowerCase(), role, password };
    const doc = await Admin.create(toCreate);
    res.status(201).json({
      id: doc._id,
      email: doc.email,
      role: doc.role,
      created_at: doc.created_at,
    });
  } catch (e) {
    console.error("admin create role error", e);
    res.status(500).json({ error: "failed to create admin" });
  }
});

router.patch("/roles/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id))
      return res.status(400).json({ error: "invalid admin id" });
    const { role } = req.body || {};
    if (!role || !["superadmin", "moderator"].includes(role))
      return res.status(400).json({ error: "invalid role" });
    // Prevent demoting the last remaining superadmin
    const target = await Admin.findById(id).lean();
    if (!target) return res.status(404).json({ error: "admin not found" });
    if (target.role === "superadmin" && role !== "superadmin") {
      const supCount = await Admin.countDocuments({ role: "superadmin" });
      if (supCount <= 1) {
        return res
          .status(400)
          .json({ error: "cannot demote the last superadmin" });
      }
    }
    const upd = await Admin.findByIdAndUpdate(
      id,
      { $set: { role } },
      { new: true }
    );
    if (!upd) return res.status(404).json({ error: "admin not found" });
    res.json({
      id: upd._id,
      email: upd.email,
      role: upd.role,
      created_at: upd.created_at,
    });
  } catch (e) {
    console.error("admin update role error", e);
    res.status(500).json({ error: "failed to update role" });
  }
});

router.delete("/roles/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id))
      return res.status(400).json({ error: "invalid admin id" });
    // Prevent deleting the last remaining superadmin
    const toDel = await Admin.findById(id).lean();
    if (!toDel) return res.status(404).json({ error: "admin not found" });
    if (toDel.role === "superadmin") {
      const supCount = await Admin.countDocuments({ role: "superadmin" });
      if (supCount <= 1) {
        return res
          .status(400)
          .json({ error: "cannot delete the last superadmin" });
      }
    }
    const del = await Admin.findByIdAndDelete(id);
    if (!del) return res.status(404).json({ error: "admin not found" });
    res.status(204).end();
  } catch (e) {
    console.error("admin delete role error", e);
    res.status(500).json({ error: "failed to delete admin" });
  }
});

// ---------------- Payouts (aggregate with pagination metadata) ----------------
router.get("/payouts", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const search = req.query.search;
    const all = await Order.aggregate([
      { $match: { status: { $in: ["completed", "delivered"] } } },
      {
        $group: {
          _id: "$seller_id",
          total_sales: { $sum: "$total" },
          orders: { $sum: 1 },
        },
      },
      { $sort: { total_sales: -1 } },
    ]);
    let filtered = all;
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filtered = all.filter((r) => rx.test(String(r._id)));
    }
    const total = filtered.length;
    const start = (page - 1) * limit;
    const rows = filtered.slice(start, start + limit);
    res.json({ page, limit, total, rows });
  } catch (e) {
    console.error("admin payouts error", e);
    res.status(500).json({ message: "Failed to compute payouts" });
  }
});

// ---------------- Metrics ----------------
router.get("/metrics", requireAdmin, async (req, res) => {
  try {
    console.log("[METRICS] Starting metrics fetch...");
    const [
      ordersCount,
      activeProducts,
      allClients,
      sellersPending,
      allSellers,
      deliveryAgentsCount,
      salesAgg,
      commissionAgg,
      discountAgg,
    ] = await Promise.all([
      Order.estimatedDocumentCount(),
      Product.countDocuments({ status: "active" }),
      Client.find().select("email phone").lean(),
      Seller.countDocuments({ approved: false }),
      Seller.find().select("email phone business_type").lean(),
      DeliveryAgent.estimatedDocumentCount(),
      Order.aggregate([
        { $group: { _id: null, total: { $sum: "$payment.amount" } } },
      ]),
      // Sum platform_commission from earning logs (seller role)
      EarningLog.aggregate([
        { $match: { role: "seller" } },
        { $group: { _id: null, total: { $sum: "$platform_commission" } } },
      ]),
      // Sum applied_discount_amount across orders
      Order.aggregate([
        { $match: { applied_discount_amount: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: "$applied_discount_amount" } } },
      ]),
    ]);

    console.log(
      `[METRICS] Fetched: ${ordersCount} orders, ${activeProducts} products, ${allClients.length} clients, ${allSellers.length} sellers, ${deliveryAgentsCount} agents`
    );

    // Build lookup maps for sellers and delivery agents
    const sellerKeys = new Set();
    const restaurantKeys = new Set();
    for (const s of allSellers) {
      const keys = [s.email, s.phone]
        .filter(Boolean)
        .map((k) => String(k).toLowerCase());
      const isRestaurant = /rest/i.test(s.business_type || "");
      for (const k of keys) {
        if (isRestaurant) {
          restaurantKeys.add(k);
        } else {
          sellerKeys.add(k);
        }
      }
    }

    // Count pure clients (not sellers/restaurants/delivery)
    let pureClientsCount = 0;
    for (const c of allClients) {
      const keys = [c.email, c.phone]
        .filter(Boolean)
        .map((k) => String(k).toLowerCase());
      const isSeller = keys.some(
        (k) => sellerKeys.has(k) || restaurantKeys.has(k)
      );
      if (!isSeller) {
        pureClientsCount++;
      }
    }

    const totalSales = salesAgg.length ? salesAgg[0].total : 0;
    const platformCommission = commissionAgg.length
      ? commissionAgg[0].total
      : 0;
    const totalDiscounts = discountAgg.length ? discountAgg[0].total : 0;

    // Count restaurants vs sellers from allSellers
    let restaurantsCount = 0;
    let sellersCount = 0;
    for (const s of allSellers) {
      if (/rest/i.test(s.business_type || "")) {
        restaurantsCount++;
      } else {
        sellersCount++;
      }
    }

    console.log(
      `[METRICS] Computed: ${pureClientsCount} pure clients, ${restaurantsCount} restaurants, ${sellersCount} sellers`
    );

    res.json({
      orders: ordersCount,
      active_products: activeProducts,
      clients: pureClientsCount,
      sellers_pending: sellersPending,
      restaurants: restaurantsCount,
      sellers: sellersCount,
      delivery_agents: deliveryAgentsCount,
      total_sales: totalSales,
      platform_commission_total: platformCommission,
      total_discounts_given: totalDiscounts,
    });
  } catch (e) {
    console.error("Error metrics", e);
    console.error("Error stack:", e.stack);
    res.status(500).json({ error: "failed to compute metrics" });
  }
});

// ---------------- Orders ----------------
router.get("/orders", requireAdmin, async (req, res) => {
  try {
    const {
      status,
      delivery_status,
      seller_id,
      client_id,
      from,
      to,
      page = 1,
      pageSize = 20,
      search,
      payment_method,
      min_amount,
      max_amount,
    } = req.query;
    const filter = {};
    if (status) filter["payment.status"] = status;
    if (delivery_status) filter["delivery.delivery_status"] = delivery_status;
    if (seller_id && mongoose.isValidObjectId(seller_id))
      filter["seller_id"] = seller_id;
    if (client_id) filter["client_id"] = client_id;

    // Payment method filter
    if (payment_method) {
      filter["payment_method"] = payment_method;
    }

    // Amount range filters
    if (min_amount || max_amount) {
      const amountFilter = {};
      if (min_amount) amountFilter.$gte = parseFloat(min_amount);
      if (max_amount) amountFilter.$lte = parseFloat(max_amount);
      filter["total_amount"] = amountFilter;
    }

    if (from || to) {
      const idRange = {};
      if (from) {
        const d = new Date(from);
        if (!isNaN(d.getTime()))
          idRange.$gte = mongoose.Types.ObjectId.createFromTime(
            Math.floor(d.getTime() / 1000)
          );
      }
      if (to) {
        const d = new Date(to);
        if (!isNaN(d.getTime()))
          idRange.$lte = mongoose.Types.ObjectId.createFromTime(
            Math.floor(d.getTime() / 1000)
          );
      }
      if (Object.keys(idRange).length) filter._id = idRange;
    }
    if (search) {
      // Enhanced search: partial hex match on _id, match client/seller ids, or order_no
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ client_id: rx }, { seller_id: rx }, { order_no: rx }];
      // If likely hex substring, add _id regex (inefficient without index but acceptable for small sets)
      if (/^[a-fA-F0-9]{3,24}$/.test(search)) {
        filter.$or.push({ _id: { $regex: rx } });
      }
    }
    const pg = Math.max(parseInt(page, 10) || 1, 1);
    const ps = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 200);
    const [items, total] = await Promise.all([
      Order.find(filter)
        .sort({ _id: -1 })
        .skip((pg - 1) * ps)
        .limit(ps)
        .lean(),
      Order.countDocuments(filter),
    ]);
    const mapped = items.map((o) => {
      const itemsAmount =
        o.payment && typeof o.payment.amount === "number"
          ? o.payment.amount
          : Number(o.payment?.amount || 0);
      const deliveryCharge = Number(o.delivery?.delivery_charge || 0);
      const totalAmount = itemsAmount + deliveryCharge;

      return {
        order_id: o._id,
        created_at:
          o.created_at ||
          (o._id && o._id.getTimestamp ? o._id.getTimestamp() : new Date()),
        client_id: o.client_id,
        seller_id: o.seller_id,
        amount: totalAmount,
        items_amount: itemsAmount,
        delivery_charge: deliveryCharge,
        payment_status: o.payment?.status,
        payment_method: o.payment?.method,
        delivery_status: o.delivery?.delivery_status || "pending",
      };
    });
    res.json({ rows: mapped, total, page: pg, limit: ps });
  } catch (e) {
    console.error("Error listing orders", e);
    res.status(500).json({ error: "failed to list orders" });
  }
});

router.patch("/orders/:id/payment", requireAdmin, (req, res, next) =>
  verifyPayment(req, res, next)
);
router.patch("/orders/:id/delivery", requireAdmin, (req, res, next) =>
  updateDelivery(req, res, next)
);

// ========================================
// COUPON MANAGEMENT ENDPOINTS
// ========================================

// GET /api/admin/coupons - List all coupons with usage statistics
router.get("/coupons", requireAdmin, async (req, res) => {
  try {
    const settings = await PlatformSettings.findOne();
    if (!settings) {
      return res.json({ success: true, coupons: [] });
    }

    // Return coupons with calculated statistics
    const coupons = settings.coupons.map((coupon) => {
      return {
        code: coupon.code,
        percent: coupon.percent,
        active: coupon.active,
        minSubtotal: coupon.minSubtotal,
        categories: coupon.categories,
        validFrom: coupon.validFrom,
        validTo: coupon.validTo,
        usage_count: coupon.usage_count || 0,
        usage_limit: coupon.usage_limit,
        max_uses_per_user: coupon.max_uses_per_user,
        unique_users: coupon.used_by ? coupon.used_by.length : 0,
        created_at: coupon.created_at,
        updated_at: coupon.updated_at,
      };
    });

    res.json({ success: true, coupons });
  } catch (error) {
    console.error("Error fetching coupons:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch coupons",
      error: error.message,
    });
  }
});

// POST /api/admin/coupons - Create a new coupon
router.post("/coupons", requireAdmin, async (req, res) => {
  try {
    const {
      code,
      percent,
      active = true,
      minSubtotal = 0,
      categories = [],
      validFrom,
      validTo,
      usage_limit = null,
      max_uses_per_user = 1,
    } = req.body;

    // Validate required fields
    if (!code || percent === undefined) {
      return res.status(400).json({
        success: false,
        message: "Code and percent are required",
      });
    }

    // Validate percent range
    if (percent < 0 || percent > 100) {
      return res.status(400).json({
        success: false,
        message: "Percent must be between 0 and 100",
      });
    }

    let settings = await PlatformSettings.findOne();
    if (!settings) {
      settings = new PlatformSettings();
    }

    // Check if coupon code already exists
    const existingCoupon = settings.coupons.find((c) => c.code === code);
    if (existingCoupon) {
      return res.status(400).json({
        success: false,
        message: "Coupon code already exists",
      });
    }

    // Create new coupon
    const newCoupon = {
      code: code.toUpperCase(),
      percent,
      active,
      minSubtotal,
      categories,
      validFrom: validFrom ? new Date(validFrom) : null,
      validTo: validTo ? new Date(validTo) : null,
      usage_count: 0,
      usage_limit,
      max_uses_per_user,
      used_by: [],
      created_at: new Date(),
      updated_at: new Date(),
    };

    settings.coupons.push(newCoupon);
    settings.updated_at = new Date();
    await settings.save();

    console.log(`[ADMIN] Coupon created: ${code} by ${req.admin?.email}`);

    res.status(201).json({
      success: true,
      message: "Coupon created successfully",
      coupon: newCoupon,
    });
  } catch (error) {
    console.error("Error creating coupon:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create coupon",
      error: error.message,
    });
  }
});

// PUT /api/admin/coupons/:code - Update a coupon
router.put("/coupons/:code", requireAdmin, async (req, res) => {
  try {
    const { code } = req.params;
    const updates = req.body;

    const settings = await PlatformSettings.findOne();
    if (!settings) {
      return res.status(404).json({
        success: false,
        message: "Settings not found",
      });
    }

    const couponIndex = settings.coupons.findIndex(
      (c) => c.code === code.toUpperCase()
    );
    if (couponIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found",
      });
    }

    const coupon = settings.coupons[couponIndex];

    // Update allowed fields
    if (updates.percent !== undefined) {
      if (updates.percent < 0 || updates.percent > 100) {
        return res.status(400).json({
          success: false,
          message: "Percent must be between 0 and 100",
        });
      }
      coupon.percent = updates.percent;
    }
    if (updates.active !== undefined) coupon.active = updates.active;
    if (updates.minSubtotal !== undefined)
      coupon.minSubtotal = updates.minSubtotal;
    if (updates.categories !== undefined)
      coupon.categories = updates.categories;
    if (updates.validFrom !== undefined)
      coupon.validFrom = updates.validFrom ? new Date(updates.validFrom) : null;
    if (updates.validTo !== undefined)
      coupon.validTo = updates.validTo ? new Date(updates.validTo) : null;
    if (updates.usage_limit !== undefined)
      coupon.usage_limit = updates.usage_limit;
    if (updates.max_uses_per_user !== undefined)
      coupon.max_uses_per_user = updates.max_uses_per_user;

    coupon.updated_at = new Date();
    settings.coupons[couponIndex] = coupon;
    settings.updated_at = new Date();

    await settings.save();

    console.log(`[ADMIN] Coupon updated: ${code} by ${req.admin?.email}`);

    res.json({
      success: true,
      message: "Coupon updated successfully",
      coupon,
    });
  } catch (error) {
    console.error("Error updating coupon:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update coupon",
      error: error.message,
    });
  }
});

// DELETE /api/admin/coupons/:code - Delete a coupon
router.delete("/coupons/:code", requireAdmin, async (req, res) => {
  try {
    const { code } = req.params;

    const settings = await PlatformSettings.findOne();
    if (!settings) {
      return res.status(404).json({
        success: false,
        message: "Settings not found",
      });
    }

    const couponIndex = settings.coupons.findIndex(
      (c) => c.code === code.toUpperCase()
    );
    if (couponIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found",
      });
    }

    settings.coupons.splice(couponIndex, 1);
    settings.updated_at = new Date();
    await settings.save();

    console.log(`[ADMIN] Coupon deleted: ${code} by ${req.admin?.email}`);

    res.json({
      success: true,
      message: "Coupon deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting coupon:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete coupon",
      error: error.message,
    });
  }
});

// GET /api/admin/coupons/:code/usage - Get detailed usage statistics for a coupon
router.get("/coupons/:code/usage", requireAdmin, async (req, res) => {
  try {
    const { code } = req.params;

    const settings = await PlatformSettings.findOne();
    if (!settings) {
      return res.status(404).json({
        success: false,
        message: "Settings not found",
      });
    }

    const coupon = settings.coupons.find((c) => c.code === code.toUpperCase());
    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found",
      });
    }

    // Get orders that used this coupon
    const orders = await Order.find({ coupon_code: code.toUpperCase() })
      .select("client_id total_amount applied_discount_amount created_at")
      .sort("-created_at")
      .limit(100);

    res.json({
      success: true,
      coupon: {
        code: coupon.code,
        usage_count: coupon.usage_count || 0,
        usage_limit: coupon.usage_limit,
        unique_users: coupon.used_by ? coupon.used_by.length : 0,
        used_by: coupon.used_by || [],
      },
      recent_orders: orders,
      total_discount_given: orders.reduce(
        (sum, o) => sum + (o.applied_discount_amount || 0),
        0
      ),
    });
  } catch (error) {
    console.error("Error fetching coupon usage:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch coupon usage",
      error: error.message,
    });
  }
});

module.exports = router;
// ---------------- Extended Admin: Delivery Agents ----------------
router.get("/delivery-agents", requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;

    const agents = await DeliveryAgent.find()
      .select(
        "name email phone vehicle_type approved active available assigned_orders completed_orders rating created_at"
      )
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await DeliveryAgent.countDocuments();

    res.json({
      agents,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("get delivery agents error", error);
    res.status(500).json({ error: "Failed to get delivery agents" });
  }
});

router.get("/delivery-agents/pending", requireAdmin, async (req, res) => {
  try {
    const pendingAgents = await DeliveryAgent.find({ approved: false })
      .select("name email phone vehicle_type license_number created_at")
      .sort({ created_at: -1 });

    res.json(pendingAgents);
  } catch (error) {
    console.error("get pending delivery agents error", error);
    res.status(500).json({ error: "Failed to get pending delivery agents" });
  }
});

router.patch("/delivery-agents/:id/approve", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid delivery agent ID" });
    }

    const agent = await DeliveryAgent.findByIdAndUpdate(
      id,
      { $set: { approved: true } },
      { new: true }
    );

    if (!agent) {
      return res.status(404).json({ error: "Delivery agent not found" });
    }

    res.json({ message: "Delivery agent approved successfully", agent });
  } catch (error) {
    console.error("approve delivery agent error", error);
    res.status(500).json({ error: "Failed to approve delivery agent" });
  }
});

router.patch("/delivery-agents/:id/reject", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid delivery agent ID" });
    }

    const agent = await DeliveryAgent.findByIdAndUpdate(
      id,
      { $set: { approved: false, active: false } },
      { new: true }
    );

    if (!agent) {
      return res.status(404).json({ error: "Delivery agent not found" });
    }

    res.json({
      message: "Delivery agent rejected/suspended successfully",
      agent,
    });
  } catch (error) {
    console.error("reject delivery agent error", error);
    res.status(500).json({ error: "Failed to reject delivery agent" });
  }
});

router.get("/delivery-agents/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid delivery agent ID" });
    }

    const agent = await DeliveryAgent.findById(id);
    if (!agent) {
      return res.status(404).json({ error: "Delivery agent not found" });
    }

    // Get agent's delivery statistics
    const deliveryStats = await Order.aggregate([
      {
        $match: {
          "delivery.delivery_agent_id": new mongoose.Types.ObjectId(id),
        },
      },
      {
        $group: {
          _id: "$delivery.delivery_status",
          count: { $sum: 1 },
        },
      },
    ]);

    // Get recent orders for this agent
    const recentOrders = await Order.find({
      "delivery.delivery_agent_id": new mongoose.Types.ObjectId(id),
    })
      .select(
        "_id payment delivery.delivery_status delivery.delivery_charge created_at"
      )
      .sort({ created_at: -1 })
      .limit(5)
      .lean();

    // Format recent orders with correct total (items + delivery charge)
    const formattedRecentOrders = recentOrders.map((order) => {
      const itemsTotal = Number(order.payment?.amount || 0);
      const deliveryCharge = Number(order.delivery?.delivery_charge || 0);
      const total = itemsTotal + deliveryCharge;

      return {
        _id: order._id,
        order_id: order._id,
        status: order.delivery?.delivery_status || "unknown",
        total: total,
        items_total: itemsTotal,
        delivery_charge: deliveryCharge,
      };
    });

    res.json({
      ...agent.toObject(),
      recent_orders: formattedRecentOrders,
      deliveryStats,
    });
  } catch (error) {
    console.error("get delivery agent details error", error);
    res.status(500).json({ error: "Failed to get delivery agent details" });
  }
});

router.patch("/delivery-agents/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid delivery agent ID" });
    }

    const agent = await DeliveryAgent.findByIdAndUpdate(
      id,
      { $set: req.body },
      { new: true, runValidators: true }
    );

    if (!agent) {
      return res.status(404).json({ error: "Delivery agent not found" });
    }

    res.json(agent);
  } catch (error) {
    console.error("update delivery agent error", error);
    res.status(500).json({ error: "Failed to update delivery agent" });
  }
});

// ---------------- Extended Admin: Notification Campaigns ----------------
router.get("/campaigns", requireAdmin, async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const [total, rows] = await Promise.all([
      NotificationCampaign.countDocuments(filter),
      NotificationCampaign.find(filter)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);
    res.json({ page, limit, total, rows });
  } catch (e) {
    console.error("admin campaigns list error", e);
    res.status(500).json({ error: "failed to list campaigns" });
  }
});
router.post("/campaigns", requireAdmin, async (req, res) => {
  try {
    const { title, message, segment, scheduled_at } = req.body;
    if (!title || !message)
      return res.status(400).json({ error: "title & message required" });
    const doc = await NotificationCampaign.create({
      title,
      message,
      segment,
      scheduled_at,
      status: scheduled_at ? "scheduled" : "draft",
    });
    res.status(201).json(doc);
  } catch (e) {
    console.error("create campaign error", e);
    res.status(500).json({ error: "failed to create campaign" });
  }
});
router.patch("/campaigns/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id))
      return res.status(400).json({ error: "invalid id" });
    const upd = await NotificationCampaign.findByIdAndUpdate(
      id,
      { $set: req.body },
      { new: true }
    );
    if (!upd) return res.status(404).json({ error: "not found" });
    res.json(upd);
  } catch (e) {
    console.error("update campaign error", e);
    res.status(500).json({ error: "failed to update campaign" });
  }
});

// ---------------- Extended Admin: Feedback Tickets ----------------
router.get("/feedback", requireAdmin, async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const [total, rows] = await Promise.all([
      Feedback.countDocuments(filter),
      Feedback.find(filter)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);
    res.json({ page, limit, total, rows });
  } catch (e) {
    console.error("admin feedback list error", e);
    res.status(500).json({ error: "failed to list feedback" });
  }
});
router.post("/feedback", requireAdmin, async (req, res) => {
  try {
    const { user_id, type, message } = req.body;
    if (!user_id || !message)
      return res.status(400).json({ error: "user_id & message required" });
    const doc = await Feedback.create({ user_id, type, message });
    res.status(201).json(doc);
  } catch (e) {
    console.error("create feedback error", e);
    res.status(500).json({ error: "failed to create feedback" });
  }
});
router.patch("/feedback/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id))
      return res.status(400).json({ error: "invalid id" });
    const upd = await Feedback.findByIdAndUpdate(
      id,
      { $set: req.body },
      { new: true }
    );
    if (!upd) return res.status(404).json({ error: "not found" });
    res.json(upd);
  } catch (e) {
    console.error("update feedback error", e);
    res.status(500).json({ error: "failed to update feedback" });
  }
});

// ---------------- Payouts / Earnings Overview ----------------
// GET /api/admin/payouts/summary?sellerId=&from=&to=
router.get("/payouts/summary", requireAdmin, async (req, res) => {
  try {
    const { sellerId } = req.query;
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    const match = { "delivery.delivery_status": "delivered" };
    if (from || to) {
      match.created_at = {};
      if (from && !isNaN(from)) match.created_at.$gte = from;
      if (to && !isNaN(to)) match.created_at.$lte = to;
    }

    const settings = (await PlatformSettings.findOne().lean()) || {};
    const commissionRate = Number(settings.platform_commission_rate ?? 0.1);

    const pipeline = [
      { $match: match },
      {
        $lookup: {
          from: "products",
          let: { pids: "$order_items.product_id" },
          pipeline: [
            {
              $match: {
                $expr: { $in: ["$_id", "$$pids"] },
              },
            },
            { $project: { _id: 1, seller_id: 1 } },
          ],
          as: "prodInfo",
        },
      },
      { $unwind: "$prodInfo" },
      ...(req.query.sellerId
        ? [
            {
              $match: {
                "prodInfo.seller_id": new mongoose.Types.ObjectId(
                  String(sellerId)
                ),
              },
            },
          ]
        : []),
      { $unwind: "$order_items" },
      {
        $group: {
          _id: "$prodInfo.seller_id",
          item_total: {
            $sum: {
              $multiply: ["$order_items.price_snapshot", "$order_items.qty"],
            },
          },
          orders: { $addToSet: "$_id" },
        },
      },
      {
        $project: {
          seller_id: "$_id",
          _id: 0,
          item_total: 1,
          orders_count: { $size: "$orders" },
        },
      },
    ];

    const agg = await Order.aggregate(pipeline);
    const rows = agg.map((r) => {
      const platform_commission = +(r.item_total * commissionRate).toFixed(2);
      const seller_net = +(r.item_total - platform_commission).toFixed(2);
      return {
        ...r,
        platform_commission_rate: commissionRate,
        platform_commission,
        seller_net,
      };
    });
    const totals = rows.reduce(
      (acc, r) => {
        acc.item_total += r.item_total;
        acc.platform_commission += r.platform_commission;
        acc.seller_net += r.seller_net;
        acc.orders_count += r.orders_count;
        return acc;
      },
      { item_total: 0, platform_commission: 0, seller_net: 0, orders_count: 0 }
    );
    res.json({ from: from || null, to: to || null, totals, rows });
  } catch (e) {
    console.error("admin payouts summary error", e);
    res.status(500).json({ error: "failed to compute payouts summary" });
  }
});

// Detailed payout logs for drill-down (seller/delivery earnings)
// GET /api/admin/payouts/logs?role=seller|delivery&sellerId=&agentId=&from=&to=&paid=true|false&page=&limit=
router.get("/payouts/logs", requireAdmin, async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req);
    const role =
      String(req.query.role || "seller").toLowerCase() === "delivery"
        ? "delivery"
        : "seller";
    const { sellerId, agentId, from, to, paid } = req.query;

    const filter = { role };
    if (sellerId && mongoose.isValidObjectId(String(sellerId))) {
      filter.seller_id = new mongoose.Types.ObjectId(String(sellerId));
    }
    if (agentId && mongoose.isValidObjectId(String(agentId))) {
      filter.agent_id = new mongoose.Types.ObjectId(String(agentId));
    }
    if (paid === "true" || paid === "1") filter.paid = true;
    if (paid === "false" || paid === "0") filter.paid = { $ne: true };
    if (from || to) {
      const dt = {};
      if (from) {
        const d = new Date(from);
        if (!isNaN(d)) dt.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (!isNaN(d)) dt.$lte = d;
      }
      if (Object.keys(dt).length) filter.created_at = dt;
    }

    const [total, rawRows] = await Promise.all([
      EarningLog.countDocuments(filter),
      EarningLog.find(filter)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    // Enrich with minimal order info for context
    const orderIds = Array.from(
      new Set(
        rawRows
          .map((r) => (r.order_id ? r.order_id.toString() : null))
          .filter(Boolean)
      )
    );
    let ordersById = {};
    if (orderIds.length) {
      const orders = await Order.find({ _id: { $in: orderIds } })
        .select(
          "_id created_at delivery.delivery_status payment.method payment.status"
        )
        .lean();
      ordersById = Object.fromEntries(orders.map((o) => [o._id.toString(), o]));
    }

    const rows = rawRows.map((r) => ({
      ...r,
      order: r.order_id ? ordersById[r.order_id.toString()] || null : null,
    }));

    res.json({ page, limit, total, rows });
  } catch (e) {
    console.error("admin payouts logs error", e);
    res.status(500).json({ error: "failed to list payout logs" });
  }
});

// Toggle payout log paid flag (admin reconciliation)
// PATCH /api/admin/payouts/logs/:id/paid { paid: true|false }
router.patch("/payouts/logs/:id/paid", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { paid } = req.body || {};
    if (!mongoose.isValidObjectId(String(id))) {
      return res.status(400).json({ error: "invalid payout log id" });
    }
    const doc = await EarningLog.findByIdAndUpdate(
      id,
      { $set: { paid: !!paid } },
      { new: true }
    ).lean();
    if (!doc) return res.status(404).json({ error: "payout log not found" });
    res.json({ ok: true, log: doc });
  } catch (e) {
    console.error("admin mark payout paid error", e);
    res.status(500).json({ error: "failed to update payout paid flag" });
  }
});

// ==================== COMPREHENSIVE ADMIN CRUD OPERATIONS ====================

// ---------------- CLIENT/USER CRUD ----------------
router.post("/clients", requireAdmin, async (req, res) => {
  try {
    const { name, email, phone, avatar_url, firebase_uid } = req.body;

    if (!name || !email || !phone) {
      return res
        .status(400)
        .json({ error: "Name, email, and phone are required" });
    }

    const newClient = new Client({
      name,
      email,
      phone,
      avatar_url,
      firebase_uid,
      otp_verified: true, // Admin created users are auto-verified
    });

    await newClient.save();
    res.status(201).json(newClient);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: "Email already exists" });
    }
    console.error("create client error", error);
    res.status(500).json({ error: "Failed to create client" });
  }
});

router.put("/clients/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid client ID" });
    }

    const updatedClient = await Client.findByIdAndUpdate(
      id,
      { $set: req.body },
      { new: true, runValidators: true }
    );

    if (!updatedClient) {
      return res.status(404).json({ error: "Client not found" });
    }

    res.json(updatedClient);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: "Email already exists" });
    }
    console.error("update client error", error);
    res.status(500).json({ error: "Failed to update client" });
  }
});

router.delete("/sellers/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const full = req.query.full === "1" || req.query.full === "true";
    if (!mongoose.isValidObjectId(id))
      return res.status(400).json({ error: "invalid seller id" });
    const seller = await Seller.findById(id);
    if (!seller) return res.status(404).json({ error: "seller not found" });
    await seller.deleteOne();
    const cascade = await _deleteSellerCascade(seller, {}, full);
    res.json({ message: "Seller deleted", full, cascade });
  } catch (error) {
    console.error("delete seller error", error);
    res.status(500).json({ error: "Failed to delete seller" });
  }
});

// Delivery Agents full deletion
router.delete("/delivery-agents/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const full = req.query.full === "1" || req.query.full === "true";
    if (!mongoose.isValidObjectId(id))
      return res.status(400).json({ error: "invalid delivery agent id" });
    const agent = await DeliveryAgent.findById(id);
    if (!agent)
      return res.status(404).json({ error: "delivery agent not found" });
    await agent.deleteOne();
    const cascade = await _deleteDeliveryAgentCascade(agent, {}, full);
    res.json({ message: "Delivery agent deleted", full, cascade });
  } catch (e) {
    console.error("delete delivery agent error", e);
    res.status(500).json({ error: "Failed to delete delivery agent" });
  }
});

// ---------------- SELLER CRUD ----------------
router.post("/sellers", requireAdmin, async (req, res) => {
  try {
    const {
      business_name,
      email,
      phone,
      business_type,
      firebase_uid,
      approved,
      address,
      business_address, // compatibility from frontend
      cuisine,
      logo_url,
      banner_url,
      opening_hours,
      location,
      delivery_radius_km,
      password, // optional admin-set password for seller login (plaintext)
    } = req.body;

    const finalAddress = business_address || address;
    // Require location (lat,lng) as well as address so delivery/tracking works
    const hasLocation =
      location &&
      typeof location === "object" &&
      location.lat !== undefined &&
      location.lng !== undefined;
    if (!business_name || !email || !phone || !finalAddress || !hasLocation) {
      return res.status(400).json({
        error:
          "Business name, email, phone, address and location (lat,lng) are required",
      });
    }

    const newSeller = new Seller({
      business_name,
      email,
      phone,
      business_type,
      firebase_uid,
      approved: approved || false,
      address: finalAddress,
      cuisine,
      logo_url,
      banner_url,
      opening_hours,
      location: hasLocation
        ? { lat: Number(location.lat), lng: Number(location.lng) }
        : undefined,
      delivery_radius_km,
      ...(password ? { password } : {}),
    });

    await newSeller.save();
    res.status(201).json(newSeller);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: "Email already exists" });
    }
    console.error("create seller error", error);
    res.status(500).json({ error: "Failed to create seller" });
  }
});

router.put("/sellers/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid seller ID" });
    }

    const updatedSeller = await Seller.findByIdAndUpdate(
      id,
      { $set: req.body },
      { new: true, runValidators: true }
    );

    if (!updatedSeller) {
      return res.status(404).json({ error: "Seller not found" });
    }

    res.json(updatedSeller);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: "Email already exists" });
    }
    console.error("update seller error", error);
    res.status(500).json({ error: "Failed to update seller" });
  }
});

// Backward compatible PATCH for updating seller (frontend calls PATCH)
router.patch("/sellers/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid seller ID" });
    }

    const updatedSeller = await Seller.findByIdAndUpdate(
      id,
      { $set: req.body },
      { new: true, runValidators: true }
    );

    if (!updatedSeller) {
      return res.status(404).json({ error: "Seller not found" });
    }

    res.json(updatedSeller);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: "Email already exists" });
    }
    console.error("patch seller error", error);
    res.status(500).json({ error: "Failed to update seller" });
  }
});

router.delete("/sellers/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid seller ID" });
    }

    // Legacy route kept for backward compatibility now delegates to cascade-aware delete.
    const full = req.query.full === "1" || req.query.full === "true";
    const seller = await Seller.findById(id);
    if (!seller) {
      return res.status(404).json({ error: "Seller not found" });
    }
    await seller.deleteOne();
    const cascade = await _deleteSellerCascade(seller, {}, full);
    res.json({ message: "Seller deleted", full, cascade });
  } catch (error) {
    console.error("delete seller error", error);
    res.status(500).json({ error: "Failed to delete seller" });
  }
});

// ---------------- PRODUCT CRUD ----------------
router.post("/products", requireAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      price,
      seller_id,
      category,
      image_url,
      image,
      in_stock,
      published,
    } = req.body;

    if (!name || !price || !seller_id) {
      return res
        .status(400)
        .json({ error: "Name, price, and seller ID are required" });
    }

    const catStr = (category || "").toString().toLowerCase();
    const newProduct = new Product({
      name,
      description,
      price,
      seller_id: mongoose.isValidObjectId(seller_id) ? seller_id : undefined,
      category,
      image: image || image_url,
      stock:
        in_stock === false
          ? 0
          : typeof req.body.stock === "number"
          ? req.body.stock
          : catStr.includes("restaurant") || catStr.includes("food")
          ? 100000
          : 100,
      status: published === false ? "inactive" : "active",
    });

    await newProduct.save();
    res.status(201).json(newProduct);
  } catch (error) {
    console.error("create product error", error);
    res.status(500).json({ error: "Failed to create product" });
  }
});

// Allow both PUT and PATCH for flexibility
router.put("/products/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid product ID" });
    }

    const update = { ...req.body };
    if (update.published !== undefined) {
      update.status = update.published ? "active" : "inactive";
      delete update.published;
    }
    if (update.in_stock !== undefined) {
      // if explicit stock not given, toggle between 0 and keep/existing > 0
      if (update.in_stock === false) update.stock = 0;
      delete update.in_stock;
    }
    if (update.image_url && !update.image) {
      update.image = update.image_url;
      delete update.image_url;
    }

    const updatedProduct = await Product.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true, runValidators: true }
    );

    if (!updatedProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json(updatedProduct);
  } catch (error) {
    console.error("update product error", error);
    res.status(500).json({ error: "Failed to update product" });
  }
});

// Backward compatible PATCH update for products
router.patch("/products/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid product ID" });
    }

    const update = { ...req.body };
    if (update.published !== undefined) {
      update.status = update.published ? "active" : "inactive";
      delete update.published;
    }
    if (update.in_stock !== undefined) {
      if (update.in_stock === false) update.stock = 0;
      delete update.in_stock;
    }
    if (update.image_url && !update.image) {
      update.image = update.image_url;
      delete update.image_url;
    }

    const updatedProduct = await Product.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!updatedProduct)
      return res.status(404).json({ error: "Product not found" });
    res.json(updatedProduct);
  } catch (error) {
    console.error("patch product error", error);
    res.status(500).json({ error: "Failed to update product" });
  }
});

router.delete("/products/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid product ID" });
    }

    const deletedProduct = await Product.findByIdAndDelete(id);

    if (!deletedProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    console.error("delete product error", error);
    res.status(500).json({ error: "Failed to delete product" });
  }
});

// ---------------- ORDER MANAGEMENT ----------------
router.put("/orders/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid order ID" });
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      { $set: req.body },
      { new: true, runValidators: true }
    );

    if (!updatedOrder) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json(updatedOrder);
  } catch (error) {
    console.error("update order error", error);
    res.status(500).json({ error: "Failed to update order" });
  }
});

// Admin SSE stream for real-time order updates
router.get("/stream", requireAdmin, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const { addAdminClient } = require("../services/orderEvents");
  addAdminClient(res);

  // Keep alive initial ping
  res.write(":connected\n\n");

  req.on("close", () => {
    res.end();
  });
});
