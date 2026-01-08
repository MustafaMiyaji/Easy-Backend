const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const {
  Order,
  DeliveryAgent,
  DeviceToken,
  EarningLog,
  Product,
  PlatformSettings,
  Seller,
  Client,
} = require("../models/models");
const { publish, publishToSeller } = require("../services/orderEvents");
const { notifyOrderUpdate } = require("../services/push");
const { buildSnapshot } = require("../controllers/ordersController");
// Simple in-memory cache for route optimization results (key -> { data, exp })
const _routeCache = new Map();
const ROUTE_CACHE_TTL_MS = 60 * 1000; // 60s
const router = express.Router();

// Admin authentication middleware
function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || req.headers.Authorization;
    if (!auth || !/^Bearer /i.test(auth)) {
      return res.status(401).json({ error: "Admin authentication required" });
    }

    const token = auth.split(/\s+/)[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    req.admin = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired admin token" });
  }
}

// Haversine distance calculation (in kilometers)
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

// Compute agent earning from delivery charge (based on platform settings)
// Now handles admin-paid compensation for "free" deliveries
async function _calculateAgentEarning(deliveryCharge, order = null) {
  try {
    // Check if admin is paying for this delivery (when delivery is free to customer)
    if (order?.delivery?.admin_pays_agent === true) {
      const adminPayment = Number(order.delivery.admin_agent_payment || 0);
      if (adminPayment > 0) return +adminPayment.toFixed(2);
    }

    // Standard delivery charge split
    if (!deliveryCharge || deliveryCharge <= 0) return 0;
    const ps = (await PlatformSettings.findOne().lean()) || {};
    const agentShare = Number(ps.delivery_agent_share_rate ?? 0.8);
    return +(Number(deliveryCharge) * agentShare).toFixed(2);
  } catch (_) {
    return +(Number(deliveryCharge) * 0.8).toFixed(2); // fallback to 80%
  }
}

// Compute effective delivery charge when not persisted on the order
async function _effectiveDeliveryCharge(order) {
  try {
    const persisted = Number(order?.delivery?.delivery_charge || 0);
    if (persisted > 0) return +persisted.toFixed(2);

    // Subtotal from order item snapshots
    const items = Array.isArray(order?.order_items) ? order.order_items : [];
    const subtotal = items.reduce(
      (s, it) => s + Number(it.price_snapshot || 0) * Number(it.qty || 0),
      0
    );

    // Platform base charges and threshold
    const ps = (await PlatformSettings.findOne().lean()) || {};
    const baseGrocery = Number(ps.delivery_charge_grocery ?? 30) || 0;
    const baseFood = Number(ps.delivery_charge_food ?? 40) || 0;
    const threshold = Number(ps.min_total_for_delivery_charge ?? 100);

    const applyCharge =
      !(Number.isFinite(threshold) && threshold > 0) || subtotal <= threshold;
    if (!applyCharge) return 0; // waived above threshold

    // Decide bucket based on product categories (from populated product or snapshot)
    let isFood = false;
    for (const it of items) {
      const cat = (it?.product_id?.category || it?.category || "")
        .toString()
        .toLowerCase();
      if (cat.includes("restaurant") || cat.includes("food")) {
        isFood = true;
        break;
      }
    }
    const eff = isFood ? baseFood : baseGrocery;
    return +Number(eff || 0).toFixed(2);
  } catch (_) {
    return 0;
  }
}

// Get pending orders for delivery agent
router.get("/pending-orders/:agentId", async (req, res) => {
  try {
    const { agentId } = req.params;
    // Cast agentId for comparisons against ObjectId fields
    let agentObjId = null;
    try {
      agentObjId = new mongoose.Types.ObjectId(agentId);
    } catch (_) {}

    // Check if agent has any active orders
    const activeOrderCount = await Order.countDocuments({
      "delivery.delivery_agent_id": agentId,
      "delivery.delivery_status": {
        $in: ["accepted", "picked_up", "in_transit"],
      },
    });

    // Get orders that are accepted by seller but not yet assigned to delivery agent
    const baseFilter = {
      "payment.status": "paid",
      "delivery.delivery_status": "pending",
    };
    // Pending orders include: unassigned OR previously rejected (by someone else)
    const orFilter = [
      { "delivery.delivery_agent_id": null },
      { "delivery.delivery_agent_id": { $exists: false } },
      {
        "delivery.delivery_agent_id": { $ne: null },
        "delivery.delivery_agent_response": "rejected",
      },
    ];
    // Exclude any order that this agent has already been offered/rejected before
    const notTriedByAgent = agentObjId
      ? {
          "delivery.assignment_history": {
            $not: { $elemMatch: { agent_id: agentObjId } },
          },
        }
      : {};

    const pendingOrders = await Order.find({
      ...baseFilter,
      $or: orFilter,
      ...(notTriedByAgent || {}),
    })
      .populate("client_id", "name phone")
      .populate(
        "seller_id",
        "business_name phone address location business_type place_id"
      )
      .populate("order_items.product_id", "category seller_id")
      .sort({ created_at: -1 })
      .limit(10);

    // Format orders for delivery agent UI (with optional server-side geocode)
    const formattedOrders = await Promise.all(
      pendingOrders.map(async (order) => {
        const kindsSet = new Set();
        for (const it of order.order_items || []) {
          const cat = it?.product_id?.category || it?.category;
          const k = (cat || "").toString().toLowerCase();
          if (!k) continue;
          if (k.includes("vegetable")) kindsSet.add("vegetables");
          else if (k.includes("grocery")) kindsSet.add("grocery");
          else if (k.includes("restaurant") || k.includes("food"))
            kindsSet.add("food");
        }
        if (!kindsSet.size) {
          const bt = order.seller_id?.business_type?.toString().toLowerCase();
          if (bt) {
            if (bt.includes("grocery")) kindsSet.add("grocery");
            else if (bt.includes("restaurant") || bt.includes("food"))
              kindsSet.add("food");
          }
        }
        const kinds = Array.from(kindsSet);
        // Compose readable pickup/destination strings with fallbacks (and server geocode when enabled)
        // Resolve seller object: prefer direct order.seller_id; fallback to first product's seller_id
        let sellerObj = order.seller_id;
        if (
          !sellerObj &&
          Array.isArray(order.order_items) &&
          order.order_items.length > 0
        ) {
          const pSeller = order.order_items[0]?.product_id?.seller_id;
          if (pSeller) {
            try {
              sellerObj = await Seller.findById(pSeller)
                .select(
                  "business_name phone address location business_type place_id"
                )
                .lean();
            } catch (_) {}
          }
        }
        const sellerAddr = sellerObj?.address;
        const sellerLoc = sellerObj?.location;
        let pickupAddr = sellerAddr && sellerAddr.trim() ? sellerAddr : null;
        if (!pickupAddr) {
          try {
            const {
              reverseGeocode,
              placeDetails,
              ENABLED,
            } = require("../services/geocode");
            if (ENABLED) {
              if (order.seller_id?.place_id) {
                const pd = await placeDetails(order.seller_id.place_id);
                if (pd) pickupAddr = pd;
              }
              if (
                !pickupAddr &&
                sellerLoc &&
                sellerLoc.lat != null &&
                sellerLoc.lng != null
              ) {
                const rg = await reverseGeocode(
                  Number(sellerLoc.lat),
                  Number(sellerLoc.lng)
                );
                if (rg) pickupAddr = rg;
              }
            }
          } catch (_) {}
          if (!pickupAddr) {
            pickupAddr =
              sellerLoc && sellerLoc.lat != null && sellerLoc.lng != null
                ? `${Number(sellerLoc.lat).toFixed(5)}, ${Number(
                    sellerLoc.lng
                  ).toFixed(5)}`
                : "Store address";
          }
        }
        const clientAddr = order.delivery?.delivery_address?.full_address;
        const clientLoc = order.delivery?.delivery_address?.location;
        const destAddr =
          clientAddr && clientAddr.trim()
            ? clientAddr
            : clientLoc && clientLoc.lat != null && clientLoc.lng != null
            ? `${Number(clientLoc.lat).toFixed(5)}, ${Number(
                clientLoc.lng
              ).toFixed(5)}`
            : "Address not available";
        const deliveryCharge = await _effectiveDeliveryCharge(order);
        const agentEarning = await _calculateAgentEarning(
          deliveryCharge,
          order
        );
        const collectionAmount = Number(order.payment?.amount || 0);
        return {
          order_id: order._id,
          store:
            sellerObj?.business_name ||
            order.seller_id?.business_name ||
            "Store",
          delivery_to: destAddr,
          recipient_name:
            order.delivery?.delivery_address?.recipient_name ||
            order.client_id?.name,
          recipient_phone:
            order.delivery?.delivery_address?.recipient_phone ||
            order.client_id?.phone,
          collection_amount: collectionAmount, // Total to collect from customer
          delivery_charge: deliveryCharge,
          agent_earning: agentEarning, // Agent's share of delivery charge
          items: order.order_items?.length || 0,
          created_at: order.created_at,
          pickup_address: pickupAddr,
          // Provide coordinates to avoid client-side geocoding where possible
          store_location:
            sellerObj?.location || order.seller_id?.location || null,
          client_location: order.delivery?.delivery_address?.location || null,
          kinds,
        };
      })
    );

    res.json({
      orders: formattedOrders,
      hasActiveOrder: activeOrderCount > 0,
      activeOrderCount: activeOrderCount,
    });
  } catch (error) {
    console.error("Error fetching pending orders:", error);
    res.status(500).json({ error: "Failed to fetch pending orders" });
  }
});

// Lightweight "offers" feed for an agent: orders currently assigned to them and awaiting response
router.get("/offers/:agentId", async (req, res) => {
  try {
    const { agentId } = req.params;

    // Check if agent exists and is active
    const agent = await DeliveryAgent.findById(agentId)
      .select("active available approved")
      .lean();

    // If agent is not active, return empty offers (they shouldn't see any offers when inactive)
    if (!agent || !agent.active) {
      return res.json({
        orders: [],
        hasActiveOrder: false,
        activeOrderCount: 0,
        message: agent
          ? "You are currently inactive. Turn on to receive offers."
          : "Agent not found",
      });
    }

    let agentObjId = null;
    try {
      agentObjId = new mongoose.Types.ObjectId(agentId);
    } catch (_) {}

    // Check if agent has any active orders
    const activeOrderCount = await Order.countDocuments({
      "delivery.delivery_agent_id": agentId,
      "delivery.delivery_status": {
        $in: ["accepted", "picked_up", "in_transit"],
      },
    });

    const offers = await Order.find({
      "delivery.delivery_agent_id": agentId,
      "delivery.delivery_agent_response": "pending",
      "delivery.delivery_status": { $in: ["assigned", "pending"] },
      ...(agentObjId
        ? {
            "delivery.assignment_history": {
              $not: {
                $elemMatch: {
                  agent_id: agentObjId,
                  response: { $in: ["rejected"] },
                },
              },
            },
          }
        : {}),
    })
      .populate(
        "seller_id",
        "business_name address location business_type place_id"
      )
      .populate("order_items.product_id", "category seller_id")
      .sort({ created_at: -1 })
      .lean();
    const offersOut = await Promise.all(
      offers.map(async (o) => {
        const kindsSet = new Set();
        for (const it of o.order_items || []) {
          const cat = it?.product_id?.category || it?.category;
          const k = (cat || "").toString().toLowerCase();
          if (!k) continue;
          if (k.includes("vegetable")) kindsSet.add("vegetables");
          else if (k.includes("grocery")) kindsSet.add("grocery");
          else if (k.includes("restaurant") || k.includes("food"))
            kindsSet.add("food");
        }
        if (!kindsSet.size) {
          const bt = o.seller_id?.business_type?.toString().toLowerCase();
          if (bt) {
            if (bt.includes("grocery")) kindsSet.add("grocery");
            else if (bt.includes("restaurant") || bt.includes("food"))
              kindsSet.add("food");
          }
        }
        const kinds = Array.from(kindsSet);
        // Resolve seller object: direct or via first product's seller
        let sellerObj = o.seller_id;
        if (
          !sellerObj &&
          Array.isArray(o.order_items) &&
          o.order_items.length > 0
        ) {
          const pSeller = o.order_items[0]?.product_id?.seller_id;
          if (pSeller) {
            try {
              sellerObj = await Seller.findById(pSeller)
                .select("business_name address location business_type place_id")
                .lean();
            } catch (_) {}
          }
        }
        const sellerAddr = sellerObj?.address;
        const sellerLoc = sellerObj?.location;
        let pickupAddr = sellerAddr && sellerAddr.trim() ? sellerAddr : null;
        if (!pickupAddr) {
          try {
            const {
              reverseGeocode,
              placeDetails,
              ENABLED,
            } = require("../services/geocode");
            if (ENABLED) {
              if (o.seller_id?.place_id) {
                const pd = await placeDetails(o.seller_id.place_id);
                if (pd) pickupAddr = pd;
              }
              if (
                !pickupAddr &&
                sellerLoc &&
                sellerLoc.lat != null &&
                sellerLoc.lng != null
              ) {
                const rg = await reverseGeocode(
                  Number(sellerLoc.lat),
                  Number(sellerLoc.lng)
                );
                if (rg) pickupAddr = rg;
              }
            }
          } catch (_) {}
          if (!pickupAddr) {
            pickupAddr =
              sellerLoc && sellerLoc.lat != null && sellerLoc.lng != null
                ? `${Number(sellerLoc.lat).toFixed(5)}, ${Number(
                    sellerLoc.lng
                  ).toFixed(5)}`
                : "Store address";
          }
        }
        const clientAddr = o.delivery?.delivery_address?.full_address;
        const clientLoc = o.delivery?.delivery_address?.location;
        const destAddr =
          clientAddr && clientAddr.trim()
            ? clientAddr
            : clientLoc && clientLoc.lat != null && clientLoc.lng != null
            ? `${Number(clientLoc.lat).toFixed(5)}, ${Number(
                clientLoc.lng
              ).toFixed(5)}`
            : "Address not available";
        const deliveryCharge = await _effectiveDeliveryCharge(o);
        const agentEarning = await _calculateAgentEarning(deliveryCharge, o);
        const collectionAmount = Number(o.payment?.amount || 0);

        const storeLocation =
          sellerObj?.location || o.seller_id?.location || null;
        const clientLocation = o.delivery?.delivery_address?.location || null;

        return {
          order_id: o._id,
          store:
            sellerObj?.business_name || o.seller_id?.business_name || "Store",
          pickup_address: pickupAddr,
          // Provide destination address so the app can preview trip distance/time
          delivery_to: destAddr,
          collection_amount: collectionAmount, // Total to collect from customer
          delivery_charge: deliveryCharge,
          agent_earning: agentEarning, // Agent's share of delivery charge
          status: o.delivery?.delivery_status || "assigned",
          // Provide coordinates to avoid client-side geocoding where possible
          store_location: storeLocation,
          client_location: clientLocation,
          kinds,
        };
      })
    );
    res.json({
      orders: offersOut,
      hasActiveOrder: activeOrderCount > 0,
      activeOrderCount: activeOrderCount,
    });
  } catch (e) {
    console.error("Error fetching offers:", e);
    res.status(500).json({ error: "Failed to fetch offers" });
  }
});

// Get assigned orders for delivery agent
router.get("/assigned-orders/:agentId", async (req, res) => {
  try {
    const { agentId } = req.params;

    const assignedOrders = await Order.find({
      "delivery.delivery_agent_id": agentId,
      "delivery.delivery_agent_response": "accepted",
      "delivery.delivery_status": {
        $in: ["accepted", "picked_up", "in_transit"],
      },
    })
      .populate("client_id", "name phone")
      .populate(
        "seller_id",
        "business_name phone address location business_type"
      )
      // include seller_id on product so we can fallback when order.seller_id is missing
      .populate("order_items.product_id", "category seller_id")
      .sort({ created_at: -1 });

    const formattedOrders = await Promise.all(
      assignedOrders.map(async (order) => {
        const kindsSet = new Set();
        for (const it of order.order_items || []) {
          const cat = it?.product_id?.category || it?.category;
          const k = (cat || "").toString().toLowerCase();
          if (!k) continue;
          if (k.includes("vegetable")) kindsSet.add("vegetables");
          else if (k.includes("grocery")) kindsSet.add("grocery");
          else if (k.includes("restaurant") || k.includes("food"))
            kindsSet.add("food");
        }
        if (!kindsSet.size) {
          const bt = order.seller_id?.business_type?.toString().toLowerCase();
          if (bt) {
            if (bt.includes("grocery")) kindsSet.add("grocery");
            else if (bt.includes("restaurant") || bt.includes("food"))
              kindsSet.add("food");
          }
        }
        const kinds = Array.from(kindsSet);
        // Resolve seller object: prefer direct order.seller_id; fallback to first product's seller_id
        let sellerObj = order.seller_id;
        if (
          !sellerObj &&
          Array.isArray(order.order_items) &&
          order.order_items.length > 0
        ) {
          const pSeller = order.order_items[0]?.product_id?.seller_id;
          if (pSeller) {
            try {
              sellerObj = await Seller.findById(pSeller)
                .select(
                  "business_name phone address location business_type place_id"
                )
                .lean();
            } catch (_) {}
          }
        }
        // Compose pickup address with same fallback chain as offers/pending
        const sellerAddr = sellerObj?.address || order.seller_id?.address;
        const sellerLoc = sellerObj?.location || order.seller_id?.location;
        let pickupAddr = sellerAddr && sellerAddr.trim() ? sellerAddr : null;
        if (!pickupAddr) {
          try {
            const {
              reverseGeocode,
              placeDetails,
              ENABLED,
            } = require("../services/geocode");
            if (ENABLED) {
              const placeId = sellerObj?.place_id || order.seller_id?.place_id;
              if (placeId) {
                const pd = await placeDetails(placeId);
                if (pd) pickupAddr = pd;
              }
              if (
                !pickupAddr &&
                sellerLoc &&
                sellerLoc.lat != null &&
                sellerLoc.lng != null
              ) {
                const rg = await reverseGeocode(
                  Number(sellerLoc.lat),
                  Number(sellerLoc.lng)
                );
                if (rg) pickupAddr = rg;
              }
            }
          } catch (_) {}
          if (!pickupAddr) {
            pickupAddr =
              sellerLoc && sellerLoc.lat != null && sellerLoc.lng != null
                ? `${Number(sellerLoc.lat).toFixed(5)}, ${Number(
                    sellerLoc.lng
                  ).toFixed(5)}`
                : "Store address";
          }
        }

        // Normalize recipient/client contact details with robust fallbacks
        const da = order.delivery?.delivery_address || {};

        // Resolve client document similar to admin snapshot enrichment (supports firebase_uid or ObjectId)
        let clientDoc = null;
        try {
          const cid = order.client_id;
          if (cid) {
            const orQ = [{ firebase_uid: cid }];
            if (
              typeof cid === "string" &&
              cid.length === 24 &&
              /^[0-9a-fA-F]{24}$/.test(cid)
            ) {
              try {
                orQ.push({ _id: new mongoose.Types.ObjectId(cid) });
              } catch (_) {}
            }
            clientDoc = await Client.findOne({ $or: orQ })
              .select("name phone")
              .lean();
          }
        } catch (_) {}
        const recName =
          da.recipient_name ||
          da.name ||
          da.full_name ||
          da.display_name ||
          order.client_id?.name ||
          clientDoc?.name ||
          undefined;
        const recPhone =
          da.recipient_phone ||
          da.phone ||
          da.mobile ||
          da.contact ||
          da.contact_number ||
          da.mobile_number ||
          order.client_id?.phone ||
          clientDoc?.phone ||
          undefined;

        // Prefer populated seller object if available
        const sellerPhone = sellerObj?.phone || order.seller_id?.phone || null;
        // Compute effective delivery charge if not persisted
        const deliveryCharge = await _effectiveDeliveryCharge(order);

        // Fetch agent's current location from DeliveryAgent document
        let agentLocation = null;
        if (order.delivery?.delivery_agent_id) {
          try {
            const agent = await DeliveryAgent.findById(
              order.delivery.delivery_agent_id
            )
              .select("current_location updated_at")
              .lean();
            if (
              agent?.current_location?.lat != null &&
              agent?.current_location?.lng != null
            ) {
              agentLocation = {
                lat: agent.current_location.lat,
                lng: agent.current_location.lng,
                updated_at:
                  agent.current_location.updated_at || agent.updatedAt || null,
              };
            }
          } catch (err) {
            console.error("Error fetching agent location:", err);
          }
        }
        // Fallback to accept_location if current location unavailable
        if (
          !agentLocation &&
          order.delivery?.accept_location?.lat != null &&
          order.delivery?.accept_location?.lng != null
        ) {
          agentLocation = {
            lat: order.delivery.accept_location.lat,
            lng: order.delivery.accept_location.lng,
            updated_at: null,
          };
        }

        return {
          order_id: order._id,
          store:
            sellerObj?.business_name ||
            order.seller_id?.business_name ||
            "Store",
          delivery_to:
            order.delivery?.delivery_address?.full_address ||
            "Address not available",
          recipient_name: recName,
          recipient_phone: recPhone,
          // Canonical aliases to maximize client compatibility
          customer_phone: recPhone,
          contact_number: recPhone,
          mobile_number: recPhone,
          // Direct contact fields for quick access
          client_name:
            order.client_id?.name || clientDoc?.name || recName || null,
          client_phone:
            order.client_id?.phone || clientDoc?.phone || recPhone || null,
          seller_name:
            sellerObj?.business_name || order.seller_id?.business_name || null,
          seller_phone: sellerPhone,
          // Alias used by some clients
          store_phone: sellerPhone,
          // Nested objects for UI components expecting these keys
          client:
            (order.client_id &&
              (order.client_id.name || order.client_id.phone)) ||
            clientDoc
              ? {
                  name:
                    order.client_id &&
                    (order.client_id.name || order.client_id.phone)
                      ? order.client_id.name
                      : clientDoc?.name,
                  phone:
                    order.client_id &&
                    (order.client_id.name || order.client_id.phone)
                      ? order.client_id.phone
                      : clientDoc?.phone,
                }
              : recName || recPhone
              ? { name: recName, phone: recPhone }
              : undefined,
          customer:
            recName || recPhone
              ? { name: recName, phone: recPhone }
              : undefined,
          recipient:
            recName || recPhone
              ? { name: recName, phone: recPhone }
              : undefined,
          seller: sellerObj
            ? {
                name: sellerObj.business_name,
                phone: sellerObj.phone,
                address: sellerObj.address,
              }
            : undefined,
          total_amount: order.payment?.amount || 0,
          delivery_charge: deliveryCharge,
          status: order.delivery?.delivery_status || "accepted",
          // Provide explicit delivery_status as well for clients that prefer it
          delivery_status: order.delivery?.delivery_status || "accepted",
          pickup_time: order.delivery?.pickup_time,
          estimated_delivery: order.delivery?.estimated_delivery_time,
          pickup_address: pickupAddr,
          store_location:
            sellerObj?.location || order.seller_id?.location || null,
          client_location: order.delivery?.delivery_address?.location || null,
          agent_location: agentLocation,
          kinds,
          collection_amount: Number(order.payment?.amount || 0),
          agent_earning: await _calculateAgentEarning(deliveryCharge, order),
        };
      })
    );

    res.json(formattedOrders);
  } catch (error) {
    console.error("Error fetching assigned orders:", error);
    res.status(500).json({ error: "Failed to fetch assigned orders" });
  }
});

// Get delivery history for agent
// Helper: Calculate distance in KM between two {lat, lng} objects
function calcDistanceKM(a, b) {
  if (
    !a ||
    !b ||
    typeof a.lat !== "number" ||
    typeof a.lng !== "number" ||
    typeof b.lat !== "number" ||
    typeof b.lng !== "number"
  )
    return null;
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371; // Earth radius in KM
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const aVal =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
  return +(R * c).toFixed(2);
}

router.get("/history/:agentId", async (req, res) => {
  try {
    const { agentId } = req.params;

    const deliveredOrders = await Order.find({
      "delivery.delivery_agent_id": agentId,
      "delivery.delivery_status": "delivered",
    })
      .populate("client_id", "name")
      .populate("seller_id", "business_name location")
      .sort({ "delivery.delivery_end_time": -1 })
      .limit(50);

    const formattedOrders = await Promise.all(
      deliveredOrders.map(async (order) => {
        // Always compute delivery charge if missing or zero
        let deliveryCharge = Number(order.delivery?.delivery_charge || 0);
        // Always use computed charge if missing or zero
        const computedCharge = await _effectiveDeliveryCharge(order);
        if (!deliveryCharge || deliveryCharge <= 0) {
          deliveryCharge = computedCharge;
        }
        // If still zero, use computed value
        if (!deliveryCharge || deliveryCharge <= 0) {
          deliveryCharge = computedCharge;
        }

        // Route info: from agent accept location to store, then store to client
        // Try multiple sources for store location
        let storeLocation = null;
        // Priority 1: From delivery pickup_address (always check this first)
        const pickupLoc = order.delivery?.pickup_address?.location;
        if (pickupLoc) {
          if (process.env.DEBUG_DELIVERY_ROUTING === "1") {
            console.log(
              `🔎 pickup_address.location for order ${order._id}:`,
              pickupLoc
            );
          }
          // Accept if lat/lng are present and numbers or numeric strings
          let lat = pickupLoc.lat;
          let lng = pickupLoc.lng;
          if (typeof lat === "string") lat = parseFloat(lat);
          if (typeof lng === "string") lng = parseFloat(lng);
          if (
            typeof lat === "number" &&
            !isNaN(lat) &&
            typeof lng === "number" &&
            !isNaN(lng)
          ) {
            storeLocation = { lat, lng };
          }
        }
        // Priority 2: From populated seller
        if (
          !storeLocation &&
          order.seller_id?.location?.lat &&
          order.seller_id?.location?.lng
        ) {
          storeLocation = order.seller_id.location;
        }
        // Priority 3: Fetch seller separately if we have seller_id
        if (!storeLocation && order.seller_id?._id) {
          try {
            const seller = await Seller.findById(order.seller_id._id)
              .select("location")
              .lean();
            if (seller?.location?.lat && seller?.location?.lng) {
              storeLocation = seller.location;
            }
          } catch (err) {
            console.error(
              `Error fetching seller location for order ${order._id}:`,
              err
            );
          }
        }

        const routeInfo = {
          accept_location: order.delivery?.accept_location || null,
          store_location: storeLocation,
          client_location: order.delivery?.delivery_address?.location || null,
          pickup_time: order.delivery?.pickup_time || null,
          delivered_time: order.delivery?.delivery_end_time || null,
        };

        // Debug logging for route info
        if (!routeInfo.store_location) {
          if (process.env.DEBUG_DELIVERY_ROUTING === "1") {
            console.log(`⚠️ Missing store_location for order ${order._id}:`, {
              has_seller: !!order.seller_id,
              seller_id: order.seller_id?._id,
              seller_has_location: !!order.seller_id?.location,
              has_pickup_address: !!order.delivery?.pickup_address,
              pickup_has_location: !!order.delivery?.pickup_address?.location,
            });
          }
        }

        // Calculate KM if locations are available
        let km_agent_to_store = null,
          km_store_to_client = null;
        if (routeInfo.accept_location && routeInfo.store_location) {
          km_agent_to_store = calcDistanceKM(
            routeInfo.accept_location,
            routeInfo.store_location
          );
        }
        if (routeInfo.store_location && routeInfo.client_location) {
          km_store_to_client = calcDistanceKM(
            routeInfo.store_location,
            routeInfo.client_location
          );
        }

        return {
          order_id: order._id,
          store: order.seller_id?.business_name || "Store",
          delivered_to:
            order.delivery?.delivery_address?.full_address || "Address",
          delivery_date: order.delivery?.delivery_end_time,
          total_amount: order.payment?.amount || 0,
          delivery_charge: deliveryCharge,
          collection_amount: Number(order.payment?.amount || 0),
          agent_earning: await _calculateAgentEarning(deliveryCharge, order),
          route_info: routeInfo,
          km_agent_to_store,
          km_store_to_client,
        };
      })
    );

    res.json(formattedOrders);
  } catch (error) {
    console.error("Error fetching delivery history:", error);
    res.status(500).json({ error: "Failed to fetch delivery history" });
  }
});

// Accept order delivery
router.post("/accept-order", async (req, res) => {
  try {
    const { orderId, agentId, agentLocation } = req.body;

    const order = await Order.findById(orderId).populate("seller_id");
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Idempotency: if already accepted by this agent, return success without side effects
    if (
      String(order.delivery?.delivery_agent_id || "") === String(agentId) &&
      String(order.delivery?.delivery_agent_response || "") === "accepted" &&
      ["accepted", "picked_up", "in_transit"].includes(
        String(order.delivery?.delivery_status || "").toLowerCase()
      )
    ) {
      return res.json({ message: "Order already accepted", order });
    }

    // Check if agent has any active orders (not yet delivered or cancelled)
    const activeOrders = await Order.countDocuments({
      "delivery.delivery_agent_id": agentId,
      "delivery.delivery_status": {
        $in: ["accepted", "picked_up", "in_transit"],
      },
    });

    if (activeOrders > 0) {
      return res.status(400).json({
        error: "Cannot accept new order",
        message:
          "Please complete your current order before accepting a new one",
        hasActiveOrder: true,
      });
    }

    // Prepare update fields
    const updateFields = {
      "delivery.delivery_agent_id": agentId,
      "delivery.delivery_agent_response": "accepted",
      "delivery.delivery_status": "accepted",
    };

    // Capture agent's location at acceptance time
    if (agentLocation && agentLocation.lat && agentLocation.lng) {
      updateFields["delivery.accept_location"] = {
        lat: agentLocation.lat,
        lng: agentLocation.lng,
      };
    }

    // Always set pickup_address.location if possible
    let pickupLocation = null;
    let pickupFullAddress = order.seller_id?.business_name || "Store";
    if (order.seller_id?.location?.lat && order.seller_id?.location?.lng) {
      pickupLocation = {
        lat: order.seller_id.location.lat,
        lng: order.seller_id.location.lng,
      };
    } else if (
      order.delivery?.pickup_address?.location?.lat &&
      order.delivery?.pickup_address?.location?.lng
    ) {
      pickupLocation = {
        lat: order.delivery.pickup_address.location.lat,
        lng: order.delivery.pickup_address.location.lng,
      };
      pickupFullAddress =
        order.delivery.pickup_address.full_address || pickupFullAddress;
    }
    if (pickupLocation) {
      updateFields["delivery.pickup_address"] = {
        full_address: pickupFullAddress,
        location: pickupLocation,
      };
    } else {
      // Pickup location not available - may be set later
      // console.warn(
      //   `⚠️ Could not set pickup_address.location for order ${order._id}`
      // );
    }

    // Update order with delivery agent assignment
    let updatedOrder = await Order.findByIdAndUpdate(
      orderId,
      {
        $set: updateFields,
        $push: {
          "delivery.assignment_history": {
            agent_id: agentId,
            assigned_at: new Date(),
            response: "accepted",
            response_at: new Date(),
          },
        },
      },
      { new: true }
    );

    // Generate OTP if not already present
    if (!updatedOrder.delivery) updatedOrder.delivery = {};
    if (!updatedOrder.delivery.otp_code || updatedOrder.delivery.otp_verified) {
      updatedOrder.delivery.otp_code = String(
        Math.floor(1000 + Math.random() * 9000)
      );
      updatedOrder.delivery.otp_verified = false;
      updatedOrder.delivery.otp_verified_at = undefined;
      await updatedOrder.save();
    }

    // Update agent's assigned orders count
    await DeliveryAgent.findByIdAndUpdate(agentId, {
      $inc: { assigned_orders: 1 },
    });

    // Publish SSE + push (suppress seller/admin to avoid repeated pings, but notify client)
    try {
      const {
        buildEnrichedSnapshot,
      } = require("../controllers/ordersController");
      const snapshot = await buildEnrichedSnapshot(updatedOrder);
      publish(String(updatedOrder._id), snapshot);
      // Do not publish to seller channel here to avoid duplicate buzz; rely on SSE for live UIs
      await notifyOrderUpdate(
        updatedOrder.toObject ? updatedOrder.toObject() : updatedOrder,
        snapshot,
        {
          excludeRoles: [
            "agent",
            "delivery",
            "delivery_agent",
            "seller",
            "admin",
          ],
        }
      );
    } catch (_) {}

    res.json({ message: "Order accepted successfully", order: updatedOrder });
  } catch (error) {
    console.error("Error accepting order:", error);
    res.status(500).json({ error: "Failed to accept order" });
  }
});

// Reject order delivery
router.post("/reject-order", async (req, res) => {
  try {
    const { orderId, agentId } = req.body;

    // Update assignment history
    await Order.findByIdAndUpdate(orderId, {
      $push: {
        "delivery.assignment_history": {
          agent_id: agentId,
          assigned_at: new Date(),
          response: "rejected",
          response_at: new Date(),
        },
      },
    });

    // Find next available delivery agent who hasn't been offered before
    const order = await Order.findById(orderId).lean();
    const triedAgentIds = new Set(
      (order?.delivery?.assignment_history || []).map((h) => String(h.agent_id))
    );
    triedAgentIds.add(String(agentId));

    // Get store location for distance calculation
    let storeLat, storeLng;
    const itemProductIds = (order.order_items || [])
      .map((i) => i && i.product_id)
      .filter(Boolean);
    if (itemProductIds.length) {
      const firstProduct = await Product.findById(itemProductIds[0]).populate(
        "seller_id"
      );
      if (
        firstProduct?.seller_id?.location?.lat &&
        firstProduct?.seller_id?.location?.lng
      ) {
        storeLat = firstProduct.seller_id.location.lat;
        storeLng = firstProduct.seller_id.location.lng;
      }
    }

    // Fallback to pickup_address or delivery address
    if (!storeLat || !storeLng) {
      storeLat =
        order.pickup_address?.location?.lat ||
        order.delivery_address?.location?.lat;
      storeLng =
        order.pickup_address?.location?.lng ||
        order.delivery_address?.location?.lng;
    }

    // Find all available agents who haven't been tried yet
    const availableAgents = await DeliveryAgent.find({
      approved: true,
      active: true,
      available: true,
      _id: { $nin: Array.from(triedAgentIds) },
    }).lean();

    let nextAgent = null;
    if (availableAgents.length > 0 && storeLat && storeLng) {
      // Calculate distance for each agent and select nearest
      const agentsWithDistance = availableAgents
        .filter(
          (agent) => agent.current_location?.lat && agent.current_location?.lng
        )
        .map((agent) => ({
          agent,
          distance: calculateDistance(
            storeLat,
            storeLng,
            agent.current_location.lat,
            agent.current_location.lng
          ),
        }))
        .sort((a, b) => a.distance - b.distance);

      if (agentsWithDistance.length > 0) {
        nextAgent = agentsWithDistance[0].agent;
        console.log(
          `Order ${orderId} reassigned to nearest agent ${
            nextAgent.name
          } (${agentsWithDistance[0].distance.toFixed(2)} km away)`
        );
      } else {
        // Fallback: if no agents have location, use least assigned
        nextAgent = availableAgents.sort(
          (a, b) => a.assigned_orders - b.assigned_orders
        )[0];
        console.log(
          `Order ${orderId} reassigned to agent ${nextAgent.name} (least assigned, no location data)`
        );
      }
    } else if (availableAgents.length > 0) {
      // No store location, fallback to least assigned
      nextAgent = availableAgents.sort(
        (a, b) => a.assigned_orders - b.assigned_orders
      )[0];
      console.log(
        `Order ${orderId} reassigned to agent ${nextAgent.name} (least assigned, no store location)`
      );
    }

    let updatedOrder = null;
    if (nextAgent) {
      // Assign to next agent
      updatedOrder = await Order.findByIdAndUpdate(
        orderId,
        {
          $set: {
            "delivery.delivery_agent_id": nextAgent._id,
            "delivery.delivery_agent_response": "pending",
            "delivery.delivery_status": "assigned",
          },
          $push: {
            "delivery.assignment_history": {
              agent_id: nextAgent._id,
              assigned_at: new Date(),
              response: "pending",
            },
          },
        },
        { new: true }
      );
    } else {
      // No agent available -> reset assignment
      updatedOrder = await Order.findByIdAndUpdate(
        orderId,
        {
          $set: {
            "delivery.delivery_agent_id": null,
            "delivery.delivery_agent_response": "rejected",
            "delivery.delivery_status": "pending",
          },
        },
        { new: true }
      );
    }

    // Publish SSE + push (acceptance: notify all roles)
    try {
      const {
        buildEnrichedSnapshot,
      } = require("../controllers/ordersController");
      const snapshot = await buildEnrichedSnapshot(updatedOrder);
      publish(String(updatedOrder._id), snapshot);
      if (snapshot.seller_id)
        publishToSeller(String(snapshot.seller_id), snapshot); // sanitized in publisher
      await notifyOrderUpdate(
        updatedOrder.toObject ? updatedOrder.toObject() : updatedOrder,
        snapshot
      );
    } catch (_) {}

    res.json({
      message: nextAgent
        ? "Order rejected, assigned to next agent"
        : "Order rejected, no agents available (reset to pending)",
    });
  } catch (error) {
    console.error("Error rejecting order:", error);
    res.status(500).json({ error: "Failed to reject order" });
  }
});

// Admin force reassign order (for timeout or manual intervention)
router.post("/force-reassign/:orderId", requireAdmin, async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const currentAgentId = order.delivery?.delivery_agent_id;
    const triedAgentIds = new Set(
      (order?.delivery?.assignment_history || []).map((h) => String(h.agent_id))
    );
    if (currentAgentId) {
      triedAgentIds.add(String(currentAgentId));
    }

    // Get store location for distance calculation
    let storeLat, storeLng;
    const itemProductIds = (order.order_items || [])
      .map((i) => i && i.product_id)
      .filter(Boolean);
    if (itemProductIds.length) {
      const firstProduct = await Product.findById(itemProductIds[0]).populate(
        "seller_id"
      );
      if (
        firstProduct?.seller_id?.location?.lat &&
        firstProduct?.seller_id?.location?.lng
      ) {
        storeLat = firstProduct.seller_id.location.lat;
        storeLng = firstProduct.seller_id.location.lng;
      }
    }

    // Fallback to pickup_address or delivery address
    if (!storeLat || !storeLng) {
      storeLat =
        order.pickup_address?.location?.lat ||
        order.delivery?.delivery_address?.location?.lat;
      storeLng =
        order.pickup_address?.location?.lng ||
        order.delivery?.delivery_address?.location?.lng;
    }

    // Find all available agents who haven't been tried yet
    const availableAgents = await DeliveryAgent.find({
      approved: true,
      active: true,
      available: true,
      _id: { $nin: Array.from(triedAgentIds) },
    }).lean();

    let nextAgent = null;
    if (availableAgents.length > 0 && storeLat && storeLng) {
      // Calculate distance for each agent and select nearest
      const agentsWithDistance = availableAgents
        .filter(
          (agent) => agent.current_location?.lat && agent.current_location?.lng
        )
        .map((agent) => ({
          agent,
          distance: calculateDistance(
            storeLat,
            storeLng,
            agent.current_location.lat,
            agent.current_location.lng
          ),
        }))
        .sort((a, b) => a.distance - b.distance);

      if (agentsWithDistance.length > 0) {
        nextAgent = agentsWithDistance[0].agent;
        console.log(
          `Order ${orderId} force-reassigned to nearest agent ${
            nextAgent.name
          } (${agentsWithDistance[0].distance.toFixed(2)} km away)`
        );
      } else {
        // Fallback: if no agents have location, use least assigned
        nextAgent = availableAgents.sort(
          (a, b) => a.assigned_orders - b.assigned_orders
        )[0];
        console.log(
          `Order ${orderId} force-reassigned to agent ${nextAgent.name} (least assigned, no location data)`
        );
      }
    } else if (availableAgents.length > 0) {
      // No store location, fallback to least assigned
      nextAgent = availableAgents.sort(
        (a, b) => a.assigned_orders - b.assigned_orders
      )[0];
      console.log(
        `Order ${orderId} force-reassigned to agent ${nextAgent.name} (least assigned, no store location)`
      );
    }

    let updatedOrder = null;
    if (nextAgent) {
      // Assign to next agent
      updatedOrder = await Order.findByIdAndUpdate(
        orderId,
        {
          $set: {
            "delivery.delivery_agent_id": nextAgent._id,
            "delivery.delivery_agent_response": "pending",
            "delivery.delivery_status": "assigned",
          },
          $push: {
            "delivery.assignment_history": {
              agent_id: nextAgent._id,
              assigned_at: new Date(),
              response: "pending",
            },
          },
        },
        { new: true }
      );

      // Increment agent assigned_orders counter
      await DeliveryAgent.findByIdAndUpdate(nextAgent._id, {
        $inc: { assigned_orders: 1 },
      });

      // Decrement previous agent's counter if exists (but don't go below 0)
      if (currentAgentId) {
        const currentAgent = await DeliveryAgent.findById(currentAgentId);
        if (currentAgent && currentAgent.assigned_orders > 0) {
          await DeliveryAgent.findByIdAndUpdate(currentAgentId, {
            $inc: { assigned_orders: -1 },
          });
        }
      }
    } else {
      // No agent available -> reset assignment
      updatedOrder = await Order.findByIdAndUpdate(
        orderId,
        {
          $set: {
            "delivery.delivery_agent_id": null,
            "delivery.delivery_agent_response": "pending",
            "delivery.delivery_status": "pending",
          },
        },
        { new: true }
      );

      // Decrement previous agent's counter if exists (but don't go below 0)
      if (currentAgentId) {
        const currentAgent = await DeliveryAgent.findById(currentAgentId);
        if (currentAgent && currentAgent.assigned_orders > 0) {
          await DeliveryAgent.findByIdAndUpdate(currentAgentId, {
            $inc: { assigned_orders: -1 },
          });
        }
      }
    }

    // Publish SSE
    try {
      const {
        buildEnrichedSnapshot,
      } = require("../controllers/ordersController");
      const snapshot = await buildEnrichedSnapshot(updatedOrder);
      publish(String(updatedOrder._id), snapshot);
      if (snapshot.seller_id)
        publishToSeller(String(snapshot.seller_id), snapshot);
      await notifyOrderUpdate(
        updatedOrder.toObject ? updatedOrder.toObject() : updatedOrder,
        snapshot
      );
    } catch (_) {}

    res.json({
      message: nextAgent
        ? "Order force-reassigned to next agent"
        : "Order force-reassigned, no agents available (reset to pending)",
      agent: nextAgent ? { id: nextAgent._id, name: nextAgent.name } : null,
    });
  } catch (error) {
    console.error("Error force-reassigning order:", error);
    res.status(500).json({ error: "Failed to force-reassign order" });
  }
});

// Update order status (picked up, in transit, delivered)
router.post("/update-status", async (req, res) => {
  try {
    const { orderId, status, agentId } = req.body;

    const updateData = {
      "delivery.delivery_status": status,
    };

    // Set timestamps based on status
    if (status === "picked_up") {
      updateData["delivery.pickup_time"] = new Date();
      updateData["delivery.estimated_delivery_time"] = new Date(
        Date.now() + 30 * 60 * 1000
      ); // 30 minutes from now
      // Ensure OTP exists when pickup occurs
      const orderDoc = await Order.findById(orderId);
      if (orderDoc) {
        if (!orderDoc.delivery) orderDoc.delivery = {};
        if (!orderDoc.delivery.otp_code || orderDoc.delivery.otp_verified) {
          orderDoc.delivery.otp_code = String(
            Math.floor(1000 + Math.random() * 9000)
          );
          orderDoc.delivery.otp_verified = false;
          orderDoc.delivery.otp_verified_at = undefined;
          await orderDoc.save();
        }
      }
    } else if (status === "delivered") {
      // Require OTP verification before marking delivered
      const orderDoc = await Order.findById(orderId).lean();
      if (!orderDoc) return res.status(404).json({ error: "Order not found" });
      if (!orderDoc.delivery?.otp_verified) {
        return res.status(400).json({
          error: "OTP not verified",
          code: "OTP_REQUIRED",
          message:
            "Delivery OTP must be verified by the client before completing delivery",
        });
      }
      updateData["delivery.delivery_end_time"] = new Date();

      // AUTO-UPDATE PAYMENT STATUS TO PAID ON DELIVERY (COD)
      // This is the correct behavior - payment is collected when order is delivered
      updateData["payment.status"] = "paid";

      // Update agent's completed orders count
      await DeliveryAgent.findByIdAndUpdate(agentId, {
        $inc: {
          assigned_orders: -1,
          completed_orders: 1,
        },
      });

      // Persist EarningLog for seller(s) and agent upon delivery completion
      try {
        const settings = (await PlatformSettings.findOne().lean()) || {};
        const commissionRate = Number(settings.platform_commission_rate ?? 0.1);
        const agentShare = Number(settings.delivery_agent_share_rate ?? 0.8);

        const orderFull = await Order.findById(orderId).lean();
        if (orderFull) {
          const pids = (orderFull.order_items || [])
            .map((oi) => oi.product_id)
            .filter(Boolean);
          const prodMap = new Map();
          if (pids.length) {
            const prods = await Product.find(
              { _id: { $in: pids } },
              { _id: 1, seller_id: 1 }
            ).lean();
            for (const p of prods)
              prodMap.set(String(p._id), String(p.seller_id));
          }
          const sellerTotals = new Map();
          for (const oi of orderFull.order_items || []) {
            const sid = prodMap.get(String(oi.product_id));
            if (!sid) continue;
            const line = Number(oi.price_snapshot || 0) * Number(oi.qty || 0);
            sellerTotals.set(sid, (sellerTotals.get(sid) || 0) + line);
          }
          for (const [sid, itemTotal] of sellerTotals.entries()) {
            const commission = +(itemTotal * commissionRate).toFixed(2);
            const net = +(itemTotal - commission).toFixed(2);
            await EarningLog.updateOne(
              { role: "seller", order_id: orderFull._id, seller_id: sid },
              {
                $setOnInsert: { created_at: new Date() },
                $set: {
                  role: "seller",
                  order_id: orderFull._id,
                  seller_id: sid,
                  item_total: +itemTotal.toFixed(2),
                  platform_commission: commission,
                  net_earning: net,
                },
              },
              { upsert: true }
            );
          }
          const delCharge = Number(orderFull.delivery?.delivery_charge || 0);
          if (agentId && delCharge > 0) {
            const agentNet = +(delCharge * agentShare).toFixed(2);
            await EarningLog.updateOne(
              { role: "delivery", order_id: orderFull._id, agent_id: agentId },
              {
                $setOnInsert: { created_at: new Date() },
                $set: {
                  role: "delivery",
                  order_id: orderFull._id,
                  agent_id: agentId,
                  delivery_charge: delCharge,
                  net_earning: agentNet,
                },
              },
              { upsert: true }
            );
          }
        }
      } catch (persistErr) {
        console.error(
          "earning log persist (delivery) error",
          persistErr?.message || persistErr
        );
      }
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      orderId,
      { $set: updateData },
      { new: true }
    );

    // Publish SSE + push
    // Exclude agent (no self-notification) and seller (no repeated "new order" alerts)
    // Only notify client about delivery status changes
    try {
      const {
        buildEnrichedSnapshot,
      } = require("../controllers/ordersController");
      const snapshot = await buildEnrichedSnapshot(updatedOrder);
      publish(String(updatedOrder._id), snapshot);
      if (snapshot.seller_id)
        publishToSeller(String(snapshot.seller_id), snapshot); // sanitized in publisher (SSE only, no push)
      await notifyOrderUpdate(
        updatedOrder.toObject ? updatedOrder.toObject() : updatedOrder,
        snapshot,
        { excludeRoles: ["agent", "delivery", "delivery_agent", "seller"] }
      );
    } catch (_) {}

    res.json({
      message: `Order status updated to ${status}`,
      order: updatedOrder,
    });
  } catch (error) {
    console.error("Error updating order status:", error);
    res.status(500).json({ error: "Failed to update order status" });
  }
});

// Generate or return current OTP for an active delivery
router.post("/generate-otp", async (req, res) => {
  try {
    const { orderId, agentId } = req.body;
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    // Only allow when order is in accepted/picked_up/in_transit
    const allowed = ["accepted", "picked_up", "in_transit", "assigned"];
    const st = order.delivery?.delivery_status;
    if (!allowed.includes(st)) {
      return res
        .status(400)
        .json({ error: "OTP can only be generated during active delivery" });
    }
    // Ensure correct agent context if assigned
    if (
      order.delivery?.delivery_agent_id &&
      agentId &&
      String(order.delivery.delivery_agent_id) !== String(agentId)
    ) {
      return res.status(403).json({ error: "Not authorized for this order" });
    }
    // Reuse existing code if present and not verified; else generate a new 4-digit code
    let code = order.delivery?.otp_code;
    if (!code || order.delivery?.otp_verified) {
      code = String(Math.floor(1000 + Math.random() * 9000));
      order.delivery = order.delivery || {};
      order.delivery.otp_code = code;
      order.delivery.otp_verified = false;
      order.delivery.otp_verified_at = undefined;
      await order.save();
      // Publish SSE snapshot so the client can see OTP in-app
      // Exclude agent and seller from push notifications (only notify client about OTP)
      try {
        const {
          buildEnrichedSnapshot,
        } = require("../controllers/ordersController");
        const snapshot = await buildEnrichedSnapshot(order);
        publish(String(order._id), snapshot);
        if (snapshot.seller_id)
          publishToSeller(String(snapshot.seller_id), snapshot); // SSE only, no push
        await notifyOrderUpdate(
          order.toObject ? order.toObject() : order,
          snapshot,
          { excludeRoles: ["agent", "delivery", "delivery_agent", "seller"] }
        );
      } catch (_) {}
    }
    res.json({ otp: code });
  } catch (error) {
    console.error("Error generating OTP:", error);
    res.status(500).json({ error: "Failed to generate OTP" });
  }
});

// Verify OTP provided by client to complete delivery
router.post("/verify-otp", async (req, res) => {
  try {
    const { orderId, otp } = req.body;
    if (!otp) return res.status(400).json({ error: "OTP required" });
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!order.delivery?.otp_code)
      return res.status(400).json({ error: "No OTP generated for this order" });
    if (String(order.delivery.otp_code) !== String(otp)) {
      return res.status(400).json({ error: "Invalid OTP" });
    }
    order.delivery.otp_verified = true;
    order.delivery.otp_verified_at = new Date();
    await order.save();
    // publish update so both client and seller UIs refresh
    // Exclude agent (no self-notification) and seller (OTP is only between customer and delivery agent)
    try {
      const {
        buildEnrichedSnapshot,
      } = require("../controllers/ordersController");
      const snapshot = await buildEnrichedSnapshot(order);
      publish(String(order._id), snapshot);
      if (snapshot.seller_id)
        publishToSeller(String(snapshot.seller_id), snapshot); // SSE only, no push
      await notifyOrderUpdate(
        order.toObject ? order.toObject() : order,
        snapshot,
        { excludeRoles: ["agent", "delivery", "delivery_agent", "seller"] }
      );
    } catch (_) {}
    res.json({ ok: true, message: "OTP verified successfully" });
  } catch (error) {
    console.error("Error verifying OTP:", error);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

// Mark order as delivered (for delivery agent)
router.put("/mark-delivered/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Update order status and delivery status
    order.status = "delivered";
    order.delivery = order.delivery || {};
    order.delivery.delivery_status = "delivered";
    order.delivery.delivered_at = new Date();
    order.delivery.delivery_end_time = new Date();

    await order.save();

    // Publish SSE updates
    try {
      const {
        buildEnrichedSnapshot,
      } = require("../controllers/ordersController");
      const snapshot = await buildEnrichedSnapshot(order);
      publish(String(order._id), snapshot);
      if (snapshot.seller_id) {
        publishToSeller(String(snapshot.seller_id), snapshot);
      }
      await notifyOrderUpdate(
        order.toObject ? order.toObject() : order,
        snapshot,
        { excludeRoles: [] }
      );
    } catch (error) {
      console.log("SSE publish error (non-blocking):", error.message);
    }

    res.status(200).json({
      message: "Order marked as delivered successfully",
      order: order,
    });
  } catch (error) {
    console.error("Error marking order as delivered:", error);
    res.status(500).json({ error: "Failed to mark order as delivered" });
  }
});

// Update agent location
router.post("/update-location", async (req, res) => {
  try {
    const { agentId, latitude, longitude } = req.body;

    await DeliveryAgent.findByIdAndUpdate(agentId, {
      $set: {
        "current_location.lat": latitude,
        "current_location.lng": longitude,
        "current_location.updated_at": new Date(),
      },
    });

    // Broadcast to any active orders assigned to this agent for sub-10s latency on client side
    try {
      const activeOrders = await Order.find(
        {
          "delivery.delivery_agent_id": agentId,
          "delivery.delivery_status": {
            $in: ["accepted", "picked_up", "in_transit", "assigned"],
          },
        },
        { _id: 1 }
      ).lean();
      const payload = {
        // top-level for client convenience
        agent_location: {
          lat: latitude,
          lng: longitude,
          updated_at: new Date(),
        },
        // nested (back-compat for any existing clients)
        delivery: {
          agent: {
            location: { lat: latitude, lng: longitude, updated_at: new Date() },
          },
        },
      };
      for (const o of activeOrders) {
        publish(String(o._id), payload);
      }
    } catch (_) {}

    res.json({ message: "Location updated successfully" });
  } catch (error) {
    console.error("Error updating location:", error);
    res.status(500).json({ error: "Failed to update location" });
  }
});

// Toggle agent availability
router.post("/toggle-availability", async (req, res) => {
  try {
    const { agentId, available, forceOffline } = req.body;

    if (!agentId || !mongoose.isValidObjectId(agentId)) {
      console.error("Invalid or missing agentId:", agentId);
      return res.status(400).json({ error: "Valid agentId required" });
    }

    // Check if agent exists
    const agent = await DeliveryAgent.findById(agentId);
    if (!agent) {
      console.error("DeliveryAgent not found for agentId:", agentId);
      return res.status(404).json({ error: "Delivery agent not found" });
    }

    // Declare these variables outside the if block so they're accessible in the response
    let activeDeliveries = [];
    let pendingOffers = [];

    // If going offline (available=false), check for active deliveries
    if (!available) {
      activeDeliveries = await Order.find({
        "delivery.delivery_agent_id": agentId,
        "delivery.delivery_status": {
          $in: ["assigned", "picked_up", "in_transit"],
        },
      }).lean();

      if (activeDeliveries.length > 0) {
        // Agent has active deliveries
        const pendingPickup = activeDeliveries.filter(
          (o) => o.delivery.delivery_status === "assigned"
        );
        const inProgress = activeDeliveries.filter((o) =>
          ["picked_up", "in_transit"].includes(o.delivery.delivery_status)
        );

        if (!forceOffline) {
          // Block offline toggle, return active delivery info
          return res.status(400).json({
            error: "Cannot go offline with active deliveries",
            canGoOffline: false,
            activeDeliveries: {
              total: activeDeliveries.length,
              pendingPickup: pendingPickup.length,
              inProgress: inProgress.length,
            },
            message:
              inProgress.length > 0
                ? `You have ${inProgress.length} order(s) in progress. Complete deliveries before going offline.`
                : `You have ${pendingPickup.length} order(s) waiting for pickup. Accept or reject them before going offline.`,
            orders: activeDeliveries.map((o) => ({
              orderId: o._id,
              status: o.delivery.delivery_status,
              customerAddress: o.delivery?.delivery_address?.full_address,
            })),
          });
        } else {
          // Force offline: reassign all active deliveries
          console.log(
            `⚠️ FORCE OFFLINE: Reassigning ${activeDeliveries.length} active deliveries from agent ${agentId}`
          );

          for (const order of activeDeliveries) {
            // Mark current assignment as "abandoned"
            await Order.findByIdAndUpdate(order._id, {
              $push: {
                "delivery.assignment_history": {
                  agent_id: agentId,
                  assigned_at: new Date(),
                  response: "timeout", // Using timeout to indicate forced reassignment
                  response_at: new Date(),
                },
              },
            });

            // Find next available agent
            const triedAgentIds = new Set(
              (order.delivery?.assignment_history || []).map((h) =>
                String(h.agent_id)
              )
            );
            triedAgentIds.add(String(agentId));

            const availableAgents = await DeliveryAgent.find({
              approved: true,
              active: true,
              available: true,
              _id: { $nin: Array.from(triedAgentIds) },
            }).lean();

            if (availableAgents.length > 0) {
              const nextAgent = availableAgents[0];
              await Order.findByIdAndUpdate(order._id, {
                $set: {
                  "delivery.delivery_agent_id": nextAgent._id,
                  "delivery.delivery_agent_response": "pending",
                  "delivery.delivery_status": "assigned",
                },
                $push: {
                  "delivery.assignment_history": {
                    agent_id: nextAgent._id,
                    assigned_at: new Date(),
                    response: "pending",
                  },
                },
              });
              console.log(
                `  ✓ Order ${order._id} reassigned to ${nextAgent.name}`
              );
            } else {
              // No agents available
              await Order.findByIdAndUpdate(order._id, {
                $set: {
                  "delivery.delivery_agent_id": null,
                  "delivery.delivery_agent_response": "pending",
                  "delivery.delivery_status": "pending",
                },
              });
              console.log(
                `  ⚠️ Order ${order._id} reset to pending (no agents available)`
              );
            }
          }
        }
      }

      // Reassign pending offers (orders agent hasn't accepted yet)
      // This includes both "pending" and "assigned" status with "pending" response
      pendingOffers = await Order.find({
        "delivery.delivery_agent_id": agentId,
        "delivery.delivery_agent_response": "pending", // Agent hasn't responded yet
        "delivery.delivery_status": { $in: ["pending", "assigned"] }, // Include both statuses
        "payment.status": "paid",
      });

      if (pendingOffers.length > 0) {
        console.log(
          `🔄 Reassigning ${pendingOffers.length} pending offers from agent ${agentId} (going offline)`
        );

        for (const order of pendingOffers) {
          try {
            // Mark this assignment as abandoned in history and reset to unassigned in one atomic update
            const updatedOrder = await Order.findByIdAndUpdate(
              order._id,
              {
                $push: {
                  "delivery.assignment_history": {
                    agent_id: agentId,
                    assigned_at:
                      order.delivery?.assignment_history?.slice(-1)[0]
                        ?.assigned_at || new Date(),
                    response: "agent_went_offline",
                    response_at: new Date(),
                  },
                },
                $set: {
                  "delivery.delivery_agent_id": null,
                  "delivery.delivery_agent_response": "pending",
                  "delivery.delivery_status": "pending",
                },
              },
              { new: true }
            );

            if (updatedOrder) {
              try {
                const snapshot = await buildSnapshot(updatedOrder);
                publish(String(updatedOrder._id), snapshot);
                if (snapshot.seller_id) {
                  publishToSeller(String(snapshot.seller_id), snapshot);
                }
              } catch (publishErr) {
                console.error(
                  "Error publishing reassignment event:",
                  publishErr
                );
              }
            }
          } catch (reassignErr) {
            console.error(`Error reassigning order ${order._id}:`, reassignErr);
            // Continue with other orders even if one fails
          }
        }
      }
    }

    // Update agent availability and active flag together.
    // Rationale: Assignment filters require both {active:true, available:true}.
    // After logout we set both false; when toggling ON, set both true so the agent is discoverable.
    const updateResult = await DeliveryAgent.findByIdAndUpdate(agentId, {
      $set: { available: available, active: available },
    });

    if (!updateResult) {
      console.error("Failed to update availability for agentId:", agentId);
      return res
        .status(500)
        .json({ error: "Failed to update availability (not updated)" });
    }

    res.json({
      message: `Availability updated to ${
        available ? "available" : "unavailable"
      }`,
      canGoOffline: true,
      reassignedOrders: !available
        ? (activeDeliveries?.length || 0) + (pendingOffers?.length || 0)
        : 0,
    });
  } catch (error) {
    console.error("Error updating availability:", error);
    res.status(500).json({ error: "Failed to update availability" });
  }
});

// Get agent profile
router.get("/profile/:agentId", async (req, res) => {
  try {
    const { agentId } = req.params;

    const agent = await DeliveryAgent.findById(agentId);
    if (!agent) {
      return res.status(404).json({ error: "Delivery agent not found" });
    }

    res.json({
      name: agent.name,
      email: agent.email,
      phone: agent.phone,
      vehicle_type: agent.vehicle_type,
      license_number: agent.license_number,
      rating: agent.rating,
      completed_orders: agent.completed_orders,
      active: agent.active,
      available: agent.available,
      // Expose live location if available so clients can poll for tracking
      current_location: agent.current_location
        ? {
            lat: agent.current_location.lat,
            lng: agent.current_location.lng,
            updated_at:
              agent.current_location.updated_at || agent.updatedAt || null,
          }
        : null,
    });
  } catch (error) {
    console.error("Error fetching agent profile:", error);
    res.status(500).json({ error: "Failed to fetch agent profile" });
  }
});

// --------------- Delivery Agent Earnings ---------------
// Summary for delivery agent: product amount (0 for agent), delivery amount (delivery_charge), profit (agent share)
router.get("/:agentId/earnings/summary", async (req, res) => {
  try {
    const { agentId } = req.params;
    if (!agentId || !mongoose.isValidObjectId(agentId)) {
      return res.status(400).json({ error: "valid agentId required" });
    }
    const { from, to } = req.query;

    // Build query for delivered orders
    const orderQuery = {
      "delivery.delivery_agent_id": agentId,
      "delivery.delivery_status": "delivered",
      "payment.method": "COD", // Only COD orders
    };
    if (from || to) {
      orderQuery["delivery.delivery_end_time"] = {};
      if (from) orderQuery["delivery.delivery_end_time"].$gte = new Date(from);
      if (to) orderQuery["delivery.delivery_end_time"].$lte = new Date(to);
    }

    const deliveredOrders = await Order.find(orderQuery)
      .select("payment.amount delivery.delivery_charge")
      .lean();

    // Calculate totals
    let totalCodCollected = 0;
    let totalDeliveryCharges = 0;
    let totalAgentEarnings = 0;

    for (const order of deliveredOrders) {
      const itemsAmount = Number(order.payment?.amount || 0);
      const deliveryCharge = Number(order.delivery?.delivery_charge || 0);

      // Total COD collected from customer = items + delivery
      const codAmount = itemsAmount + deliveryCharge;
      totalCodCollected += codAmount;

      // Track delivery charges
      totalDeliveryCharges += deliveryCharge;

      // Agent gets 80% of delivery charge OR admin compensation for free deliveries
      const agentEarning = await _calculateAgentEarning(deliveryCharge, order);
      totalAgentEarnings += agentEarning;
    }

    // Amount agent needs to pay to company = COD collected - agent earnings
    const amountToPayCompany = totalCodCollected - totalAgentEarnings;

    res.json({
      from: from || null,
      to: to || null,
      wallet_balance: +totalCodCollected.toFixed(2), // Total cash collected from customers
      total_cod_collected: +totalCodCollected.toFixed(2), // Same as wallet balance
      total_delivery_charges: +totalDeliveryCharges.toFixed(2),
      agent_earnings: +totalAgentEarnings.toFixed(2), // Agent's 80% share of delivery charges
      amount_to_pay_company: +amountToPayCompany.toFixed(2), // Items + platform's 20% of delivery
      total_orders_delivered: deliveredOrders.length,
      // Legacy fields for backward compatibility
      product_amount: 0,
      delivery_amount: +totalDeliveryCharges.toFixed(2),
      profit: +totalAgentEarnings.toFixed(2),
    });
  } catch (e) {
    console.error("agent earnings summary error", e);
    res.status(500).json({ error: "failed to compute earnings" });
  }
});

// Detailed earnings breakdown for delivery agent
// Returns per-day totals and per-order entries for delivered COD orders
router.get("/:agentId/earnings/breakdown", async (req, res) => {
  try {
    const { agentId } = req.params;
    if (!agentId || !mongoose.isValidObjectId(agentId)) {
      return res.status(400).json({ error: "valid agentId required" });
    }
    const { from, to } = req.query;

    // Build query for delivered orders (COD only)
    const orderQuery = {
      "delivery.delivery_agent_id": agentId,
      "delivery.delivery_status": "delivered",
      "payment.method": "COD",
    };
    if (from || to) {
      orderQuery["delivery.delivery_end_time"] = {};
      if (from) orderQuery["delivery.delivery_end_time"].$gte = new Date(from);
      if (to) orderQuery["delivery.delivery_end_time"].$lte = new Date(to);
    }

    const orders = await Order.find(orderQuery)
      .select(
        "seller_id payment.amount delivery.delivery_charge delivery.delivery_end_time"
      )
      .populate("seller_id", "business_name")
      .lean();

    // Accumulators
    let totalCodCollected = 0;
    let totalDeliveryCharges = 0;
    let totalAgentEarnings = 0;

    // Per-day map
    const byDay = new Map(); // key: YYYY-MM-DD => { date, orders, cod_collected, agent_earnings, amount_to_pay_company }

    const ordersOut = [];

    for (const o of orders) {
      const itemsAmount = Number(o?.payment?.amount || 0);
      const deliveryCharge = Number(o?.delivery?.delivery_charge || 0);
      const agentEarning = await _calculateAgentEarning(deliveryCharge, o);
      const codCollected = itemsAmount + deliveryCharge;
      const toCompany = codCollected - agentEarning;

      totalCodCollected += codCollected;
      totalDeliveryCharges += deliveryCharge;
      totalAgentEarnings += agentEarning;

      const endTime = o?.delivery?.delivery_end_time
        ? new Date(o.delivery.delivery_end_time)
        : null;
      const yyyyMmDd = endTime
        ? new Date(endTime.getFullYear(), endTime.getMonth(), endTime.getDate())
            .toISOString()
            .slice(0, 10)
        : "unknown";

      const dayObj = byDay.get(yyyyMmDd) || {
        date: yyyyMmDd,
        orders: 0,
        cod_collected: 0,
        agent_earnings: 0,
        amount_to_pay_company: 0,
      };
      dayObj.orders += 1;
      dayObj.cod_collected += codCollected;
      dayObj.agent_earnings += agentEarning;
      dayObj.amount_to_pay_company += toCompany;
      byDay.set(yyyyMmDd, dayObj);

      ordersOut.push({
        order_id: o._id,
        delivered_at: endTime,
        store:
          (o.seller_id && (o.seller_id.business_name || o.seller_id.name)) ||
          undefined,
        items_amount: +itemsAmount.toFixed(2),
        delivery_charge: +deliveryCharge.toFixed(2),
        cod_collected: +codCollected.toFixed(2),
        agent_earning: +agentEarning.toFixed(2),
        amount_to_pay_company: +toCompany.toFixed(2),
      });
    }

    const byDayOut = Array.from(byDay.values())
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .map((d) => ({
        ...d,
        cod_collected: +Number(d.cod_collected || 0).toFixed(2),
        agent_earnings: +Number(d.agent_earnings || 0).toFixed(2),
        amount_to_pay_company: +Number(d.amount_to_pay_company || 0).toFixed(2),
      }));

    const amountToPayCompany = totalCodCollected - totalAgentEarnings;

    res.json({
      from: from || null,
      to: to || null,
      totals: {
        total_orders: orders.length,
        total_cod_collected: +totalCodCollected.toFixed(2),
        total_delivery_charges: +totalDeliveryCharges.toFixed(2),
        agent_earnings: +totalAgentEarnings.toFixed(2),
        amount_to_pay_company: +amountToPayCompany.toFixed(2),
      },
      by_day: byDayOut,
      orders: ordersOut,
    });
  } catch (e) {
    console.error("agent earnings breakdown error", e);
    res.status(500).json({ error: "failed to compute earnings breakdown" });
  }
});

// ---------------- Route Optimization ----------------
// POST /api/delivery/:agentId/route/optimize
// Body: { order_ids?: [string], points?: [{lat,lng,type,label?}], allowReorder?: bool, profile?: 'driving', avoid?: {tolls?:bool, highways?:bool} }
router.post("/:agentId/route/optimize", async (req, res) => {
  try {
    const { agentId } = req.params;
    if (!agentId || !mongoose.isValidObjectId(agentId)) {
      return res.status(400).json({ error: "valid agentId required" });
    }
    const agent = await DeliveryAgent.findById(agentId)
      .select("active current_location")
      .lean();
    if (!agent || agent.active !== true) {
      return res.status(400).json({ error: "agent not active" });
    }
    const { order_ids, points, allowReorder = true } = req.body || {};
    if (
      (!Array.isArray(order_ids) || order_ids.length === 0) &&
      (!Array.isArray(points) || points.length === 0)
    ) {
      return res
        .status(400)
        .json({ error: "order_ids[] or points[] required" });
    }
    const maxStops = 10;

    // Build canonical cache key
    const keyObj = {
      agentId,
      order_ids: order_ids || null,
      points: points || null,
      allowReorder,
    }; // omit avoid/profile for now
    const cacheKey = JSON.stringify(keyObj);
    const now = Date.now();
    const hit = _routeCache.get(cacheKey);
    if (hit && hit.exp > now) {
      return res.json({ ...hit.data, cached: true });
    }

    // Resolve waypoints
    const stops = []; // {type, lat, lng, label?, order_id?}
    // Agent origin
    let agentLoc = null;
    if (
      agent.current_location &&
      agent.current_location.lat != null &&
      agent.current_location.lng != null
    ) {
      agentLoc = {
        lat: Number(agent.current_location.lat),
        lng: Number(agent.current_location.lng),
      };
    }
    if (!agentLoc) {
      // Fallback to first point or 0,0 (will be filtered); no geolocation from server side for privacy
      agentLoc = { lat: 0, lng: 0 };
    }
    stops.push({
      type: "agent",
      lat: agentLoc.lat,
      lng: agentLoc.lng,
      label: "Agent",
    });

    if (Array.isArray(order_ids) && order_ids.length) {
      // Fetch orders and extract pickup/dropoff
      const orders = await Order.find({ _id: { $in: order_ids } })
        .select(
          "delivery.delivery_address seller_id seller restaurant order_items"
        )
        .populate("seller_id", "business_name location")
        .lean();
      for (const o of orders) {
        if (stops.length >= maxStops * 2) break; // crude cap
        // Pickup: seller or restaurant location
        let pickup = null;
        const sellerLoc =
          o?.seller_id?.location ||
          o?.seller?.location ||
          o?.restaurant_id?.location ||
          o?.restaurant?.location;
        if (sellerLoc && sellerLoc.lat != null && sellerLoc.lng != null) {
          pickup = { lat: Number(sellerLoc.lat), lng: Number(sellerLoc.lng) };
        }
        // Dropoff: delivery address location
        let drop = null;
        const deliveryLoc = o?.delivery?.delivery_address?.location;
        if (deliveryLoc && deliveryLoc.lat != null && deliveryLoc.lng != null) {
          drop = { lat: Number(deliveryLoc.lat), lng: Number(deliveryLoc.lng) };
        }
        if (pickup) {
          stops.push({
            type: "pickup",
            lat: pickup.lat,
            lng: pickup.lng,
            label: "Pickup",
            order_id: o._id,
          });
        }
        if (drop) {
          stops.push({
            type: "dropoff",
            lat: drop.lat,
            lng: drop.lng,
            label: "Drop",
            order_id: o._id,
          });
        }
      }
    } else if (Array.isArray(points)) {
      for (const p of points) {
        if (!p || p.lat == null || p.lng == null) continue;
        stops.push({
          type: p.type || "waypoint",
          lat: Number(p.lat),
          lng: Number(p.lng),
          label: p.label,
          order_id: p.order_id,
        });
        if (stops.length >= maxStops + 1) break;
      }
    }

    // Filter invalid coordinates
    const validStops = stops.filter(
      (s) => Number.isFinite(s.lat) && Number.isFinite(s.lng)
    );
    if (validStops.length < 2) {
      return res.status(400).json({ error: "insufficient valid stops" });
    }

    // Build simple distance matrix (Haversine) for fallback ordering
    function haversine(a, b) {
      const R = 6371; // km
      const dLat = ((b.lat - a.lat) * Math.PI) / 180;
      const dLng = ((b.lng - a.lng) * Math.PI) / 180;
      const lat1 = (a.lat * Math.PI) / 180;
      const lat2 = (b.lat * Math.PI) / 180;
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 1000; // meters
    }

    let ordered = validStops.slice();
    let engine = "fallback";
    let warnings = [];
    // Simple nearest-neighbor if allowReorder and >2 stops
    if (allowReorder && ordered.length > 2) {
      const origin = ordered[0];
      const remaining = ordered.slice(1);
      const seq = [origin];
      let current = origin;
      while (remaining.length) {
        remaining.sort((a, b) => haversine(current, a) - haversine(current, b));
        const next = remaining.shift();
        seq.push(next);
        current = next;
      }
      ordered = seq;
    }

    // Compute legs distances
    const legs = [];
    let totalDist = 0;
    for (let i = 0; i < ordered.length - 1; i++) {
      const a = ordered[i];
      const b = ordered[i + 1];
      const d = haversine(a, b);
      totalDist += d;
      // Duration rough estimate: 40km/h -> 11.11 m/s
      const durSec = Math.round(d / 11.11);
      legs.push({
        from_index: i,
        to_index: i + 1,
        distance_m: Math.round(d),
        duration_s: durSec,
      });
    }
    const totalDuration = legs.reduce((s, l) => s + l.duration_s, 0);

    // Build a crude polyline (GeoJSON LineString) from ordered stops
    const geojson = {
      type: "LineString",
      coordinates: ordered.map((s) => [s.lng, s.lat]),
    };

    const out = {
      ordered_stops: ordered,
      total_distance_m: Math.round(totalDist),
      total_duration_s: totalDuration,
      legs,
      polyline: null, // Could add encoded polyline if calling Google/OSRM later
      geojson,
      diagnostics: { engine, warnings },
    };

    _routeCache.set(cacheKey, { data: out, exp: now + ROUTE_CACHE_TTL_MS });
    res.json(out);
  } catch (e) {
    console.error("route optimize error", e);
    res.status(500).json({ error: "failed to optimize route" });
  }
});

// Logout endpoint - set agent inactive and reassign pending orders
router.post("/logout", async (req, res) => {
  try {
    const { agentId } = req.body;

    if (!agentId || !mongoose.isValidObjectId(agentId)) {
      return res.status(400).json({ error: "Invalid agent ID" });
    }

    // Set agent inactive and offline
    await DeliveryAgent.findByIdAndUpdate(agentId, {
      $set: {
        active: false,
        available: false,
      },
    });

    // Reassign any pending orders (same logic as toggle-availability)
    const ordersToReassign = await Order.find({
      "delivery.delivery_agent_id": agentId,
      "delivery.delivery_status": "pending",
      "payment.status": "paid",
    });

    if (ordersToReassign.length > 0) {
      console.log(
        `🔄 Reassigning ${ordersToReassign.length} pending orders from agent ${agentId} (logout)`
      );

      for (const order of ordersToReassign) {
        order.delivery.delivery_agent_id = null;
        order.delivery.delivery_agent_response = "pending";
        await order.save();

        try {
          await publishToSeller(order._id.toString(), {
            event: "order-reassigned",
            data: await buildSnapshot(order._id),
          });
        } catch (publishErr) {
          console.error("Error publishing reassignment event:", publishErr);
        }
      }
    }

    res.json({
      message: "Logout successful. Agent set to inactive.",
      reassignedOrders: ordersToReassign.length,
    });
  } catch (error) {
    console.error("Error during agent logout:", error);
    res.status(500).json({ error: "Failed to process logout" });
  }
});

// Logs
router.get("/:agentId/earnings/logs", async (req, res) => {
  try {
    const { agentId } = req.params;
    if (!agentId || !mongoose.isValidObjectId(agentId)) {
      return res.status(400).json({ error: "valid agentId required" });
    }
    const { from, to } = req.query;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const q = { role: "delivery", agent_id: agentId };
    if (from || to) {
      q.created_at = {};
      if (from) q.created_at.$gte = new Date(from);
      if (to) q.created_at.$lte = new Date(to);
    }
    const [items, total] = await Promise.all([
      EarningLog.find(q)
        .sort({ created_at: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      EarningLog.countDocuments(q),
    ]);
    res.json({ page, limit, total, items });
  } catch (e) {
    console.error("agent earnings logs error", e);
    res.status(500).json({ error: "failed to fetch earnings logs" });
  }
});

// Check for timed-out orders and reassign to next nearest agent
// This endpoint should be called periodically (e.g., every minute) by a cron job or scheduler
router.post("/check-timeouts", async (req, res) => {
  try {
    const TIMEOUT_MINUTES = 3; // Orders pending acceptance for more than 3 minutes will be reassigned
    const timeoutThreshold = new Date(Date.now() - TIMEOUT_MINUTES * 60 * 1000);

    // Optimized: Find orders assigned to agents but not accepted within timeout period
    // Added limit and select to reduce memory usage
    const timedOutOrders = await Order.find({
      "delivery.delivery_status": "assigned",
      "delivery.delivery_agent_response": "pending",
      "payment.status": "paid",
    })
      .limit(50) // Process max 50 orders per cron run to prevent overload
      .lean();

    // Quick exit if no orders found
    if (timedOutOrders.length === 0) {
      console.log("⏰ Found 0 timed-out orders to reassign");
      return res.json({ timedOutOrders: 0, reassignedCount: 0 });
    }

    const ordersToReassign = [];
    for (const order of timedOutOrders) {
      // Check if the most recent assignment is past the timeout
      const history = order.delivery?.assignment_history || [];
      const lastAssignment = history[history.length - 1];
      if (
        lastAssignment &&
        lastAssignment.response === "pending" &&
        new Date(lastAssignment.assigned_at) < timeoutThreshold
      ) {
        ordersToReassign.push(order);
      }
    }

    console.log(
      `⏰ Found ${ordersToReassign.length} timed-out orders to reassign`
    );

    let reassignedCount = 0;
    for (const order of ordersToReassign) {
      try {
        // Get tried agent IDs
        const triedAgentIds = new Set(
          (order.delivery?.assignment_history || []).map((h) =>
            String(h.agent_id)
          )
        );

        // Get store location
        let storeLat, storeLng;
        const itemProductIds = (order.order_items || [])
          .map((i) => i && i.product_id)
          .filter(Boolean);
        if (itemProductIds.length) {
          const firstProduct = await Product.findById(
            itemProductIds[0]
          ).populate("seller_id");
          if (
            firstProduct?.seller_id?.location?.lat &&
            firstProduct?.seller_id?.location?.lng
          ) {
            storeLat = firstProduct.seller_id.location.lat;
            storeLng = firstProduct.seller_id.location.lng;
          }
        }

        if (!storeLat || !storeLng) {
          storeLat =
            order.pickup_address?.location?.lat ||
            order.delivery_address?.location?.lat;
          storeLng =
            order.pickup_address?.location?.lng ||
            order.delivery_address?.location?.lng;
        }

        // Find available agents who haven't been tried
        const availableAgents = await DeliveryAgent.find({
          approved: true,
          active: true,
          available: true,
          _id: { $nin: Array.from(triedAgentIds) },
        }).lean();

        let nextAgent = null;
        if (availableAgents.length > 0 && storeLat && storeLng) {
          const agentsWithDistance = availableAgents
            .filter(
              (agent) =>
                agent.current_location?.lat && agent.current_location?.lng
            )
            .map((agent) => ({
              agent,
              distance: calculateDistance(
                storeLat,
                storeLng,
                agent.current_location.lat,
                agent.current_location.lng
              ),
            }))
            .sort((a, b) => a.distance - b.distance);

          if (agentsWithDistance.length > 0) {
            nextAgent = agentsWithDistance[0].agent;
          } else {
            nextAgent = availableAgents.sort(
              (a, b) => a.assigned_orders - b.assigned_orders
            )[0];
          }
        } else if (availableAgents.length > 0) {
          nextAgent = availableAgents.sort(
            (a, b) => a.assigned_orders - b.assigned_orders
          )[0];
        }

        if (nextAgent) {
          // Step 1: Mark last assignment as "timeout"
          await Order.findByIdAndUpdate(
            order._id,
            {
              $set: {
                "delivery.assignment_history.$[last].response": "timeout",
                "delivery.assignment_history.$[last].response_at": new Date(),
              },
            },
            {
              arrayFilters: [{ "last.response": "pending" }],
            }
          );

          // Step 2: Add new assignment and update delivery info
          await Order.findByIdAndUpdate(order._id, {
            $set: {
              "delivery.delivery_agent_id": nextAgent._id,
              "delivery.delivery_agent_response": "pending",
              "delivery.delivery_status": "assigned",
            },
            $push: {
              "delivery.assignment_history": {
                agent_id: nextAgent._id,
                assigned_at: new Date(),
                response: "pending",
              },
            },
          });

          console.log(
            `⏰ Order ${order._id} reassigned from timeout to agent ${nextAgent.name}`
          );
          reassignedCount++;

          // Notify via SSE and Push Notifications
          try {
            const updatedOrder = await Order.findById(order._id)
              .populate("client_id")
              .populate("delivery.delivery_agent_id")
              .lean();
            const snapshot = await buildSnapshot(updatedOrder);
            publish(String(order._id), snapshot);
            if (snapshot.seller_id) {
              publishToSeller(String(snapshot.seller_id), snapshot);
            }
            // Send push notification to new delivery agent
            await notifyOrderUpdate(updatedOrder, snapshot, {
              exclude: ["seller"],
            });
          } catch (publishErr) {
            console.error("Error publishing timeout reassignment:", publishErr);
          }
        } else {
          // No agents available, mark as pending
          await Order.findByIdAndUpdate(order._id, {
            $set: {
              "delivery.delivery_agent_id": null,
              "delivery.delivery_agent_response": "pending",
              "delivery.delivery_status": "pending",
            },
          });
          console.log(
            `⏰ Order ${order._id} marked as pending (no agents available after timeout)`
          );
        }
      } catch (err) {
        console.error(`Error reassigning timed-out order ${order._id}:`, err);
      }
    }

    res.json({
      message: "Timeout check completed",
      timedOutOrders: ordersToReassign.length,
      reassignedCount,
    });
  } catch (error) {
    console.error("Error checking timeouts:", error);
    res.status(500).json({ error: "Failed to check timeouts" });
  }
});

// ========================================================================
// RETRY ABANDONED PENDING ORDERS
// ========================================================================
// Called by cron job to reassign orders that were marked "pending" due to
// no agents being available. Prevents orders from being abandoned indefinitely.
router.post("/retry-pending-orders", async (req, res) => {
  try {
    const MAX_RETRY_ATTEMPTS = 10; // Prevent infinite retries
    const RETRY_COOLDOWN_MINUTES = 2; // Wait 2 min between retries
    const MAX_CONCURRENT_DELIVERIES = 3; // Agent capacity limit

    // Optimized: Find truly pending orders (paid but no agent assigned)
    // Added limit to prevent processing too many orders at once
    const pendingOrders = await Order.find({
      "payment.status": "paid",
      "delivery.delivery_status": "pending",
      "delivery.delivery_agent_id": null,
    })
      .sort({ created_at: 1 }) // Oldest first (FIFO priority)
      .limit(20); // Process max 20 orders per cron run

    if (pendingOrders.length === 0) {
      // Silent return - no need to log every time
      return res.json({
        message: "No pending orders to retry",
        total_pending: 0,
        assigned: 0,
        escalated: 0,
      });
    }

    console.log(
      `🔄 Found ${pendingOrders.length} abandoned pending orders to retry`
    );

    let assignedCount = 0;
    let escalatedCount = 0;
    let skippedCount = 0;

    // Log available agents for debugging (only if there are pending orders)
    const allAgents = await DeliveryAgent.countDocuments({
      approved: true,
      active: true,
      available: true,
    });
    console.log(
      `📋 ${allAgents} delivery agents currently available (approved, active, available)`
    );

    // Quick exit if no agents available
    if (allAgents === 0) {
      console.log("⏳ No orders ready for retry (no agents available)");
      return res.json({
        message: "No agents available",
        total_pending: pendingOrders.length,
        assigned: 0,
        escalated: 0,
        skipped: pendingOrders.length,
      });
    }

    for (const order of pendingOrders) {
      // Check retry attempts
      const attemptCount = order.delivery?.assignment_history?.length || 0;

      if (attemptCount >= MAX_RETRY_ATTEMPTS) {
        // ESCALATE: Too many failed attempts
        console.log(
          `🚨 Order ${order._id} exceeded ${MAX_RETRY_ATTEMPTS} retry attempts - escalating for admin intervention`
        );

        await Order.findByIdAndUpdate(order._id, {
          $set: {
            "delivery.delivery_status": "escalated",
            "delivery.escalated_at": new Date(),
            "delivery.escalation_reason": `No delivery agents available after ${MAX_RETRY_ATTEMPTS} attempts`,
          },
        });
        escalatedCount++;

        // TODO: Send admin notification/email here
        // Example: await sendAdminNotification(order);

        continue;
      }

      // Check cooldown (don't retry same order constantly)
      const lastAttempt =
        order.delivery?.assignment_history?.[attemptCount - 1];
      if (lastAttempt) {
        const minutesSinceLastAttempt =
          (Date.now() - new Date(lastAttempt.assigned_at)) / 60000;
        if (minutesSinceLastAttempt < RETRY_COOLDOWN_MINUTES) {
          skippedCount++;
          continue; // Skip without logging (too noisy)
        }
      }

      // Get store location for distance calculation
      let storeLat, storeLng;
      const firstItem = order.items?.[0];
      if (firstItem?.product_id) {
        const product = await Product.findById(firstItem.product_id).populate(
          "seller_id"
        );
        if (
          product?.seller_id?.location?.lat &&
          product?.seller_id?.location?.lng
        ) {
          storeLat = product.seller_id.location.lat;
          storeLng = product.seller_id.location.lng;
        }
      }

      // Fallback to pickup or delivery address
      if (!storeLat || !storeLng) {
        storeLat =
          order.pickup_address?.location?.lat ||
          order.delivery_address?.location?.lat ||
          order.delivery?.pickup_address?.location?.lat ||
          order.delivery?.delivery_address?.location?.lat;
        storeLng =
          order.pickup_address?.location?.lng ||
          order.delivery_address?.location?.lng ||
          order.delivery?.pickup_address?.location?.lng ||
          order.delivery?.delivery_address?.location?.lng;
      }

      // Find available agents
      const availableAgents = await DeliveryAgent.find({
        approved: true,
        active: true,
        available: true,
      }).lean();

      if (availableAgents.length === 0) {
        skippedCount++;
        continue; // No agents online at all
      }

      // Filter by capacity
      const agentsWithCapacity = await Promise.all(
        availableAgents.map(async (agent) => {
          const activeDeliveries = await Order.countDocuments({
            "delivery.delivery_agent_id": agent._id,
            "delivery.delivery_status": {
              $in: ["assigned", "picked_up", "in_transit"],
            },
          });
          return activeDeliveries < MAX_CONCURRENT_DELIVERIES ? agent : null;
        })
      );

      const availableAgentsWithCapacity = agentsWithCapacity.filter(
        (a) => a !== null
      );

      if (availableAgentsWithCapacity.length === 0) {
        skippedCount++;
        continue; // All agents at capacity
      }

      // Get recently tried agent IDs (within last 5 minutes)
      // Allow re-trying agents after cooldown period
      const AGENT_RETRY_COOLDOWN_MINUTES = 5;
      const recentlyTriedAgentIds = new Set(
        (order.delivery?.assignment_history || [])
          .filter((h) => {
            const minutesSinceAttempt =
              (Date.now() - new Date(h.assigned_at)) / 60000;
            return minutesSinceAttempt < AGENT_RETRY_COOLDOWN_MINUTES;
          })
          .map((h) => String(h.agent_id))
      );

      // Filter out recently-tried agents (but allow agents tried >5 min ago)
      const untriedAgents = availableAgentsWithCapacity.filter(
        (agent) => !recentlyTriedAgentIds.has(String(agent._id))
      );

      if (untriedAgents.length === 0) {
        console.log(
          `⏳ Order ${order._id} - no agents available for retry (${availableAgentsWithCapacity.length} agents have capacity but tried within last ${AGENT_RETRY_COOLDOWN_MINUTES} min)`
        );
        skippedCount++;
        continue;
      }

      // Select nearest untried agent
      let selectedAgent = null;
      if (storeLat && storeLng) {
        const agentsWithDistance = untriedAgents
          .filter(
            (agent) =>
              agent.current_location?.lat && agent.current_location?.lng
          )
          .map((agent) => ({
            agent,
            distance: calculateDistance(
              storeLat,
              storeLng,
              agent.current_location.lat,
              agent.current_location.lng
            ),
          }))
          .sort((a, b) => a.distance - b.distance);

        if (agentsWithDistance.length > 0) {
          selectedAgent = agentsWithDistance[0].agent;
        }
      }

      // Fallback: least assigned
      if (!selectedAgent) {
        selectedAgent = untriedAgents.sort(
          (a, b) => (a.assigned_orders || 0) - (b.assigned_orders || 0)
        )[0];
      }

      // Assign order
      await Order.findByIdAndUpdate(order._id, {
        $set: {
          "delivery.delivery_agent_id": selectedAgent._id,
          "delivery.delivery_agent_response": "pending",
          "delivery.delivery_status": "assigned",
        },
        $push: {
          "delivery.assignment_history": {
            agent_id: selectedAgent._id,
            assigned_at: new Date(),
            response: "pending",
          },
        },
      });

      // Increment agent's assigned orders count
      await DeliveryAgent.findByIdAndUpdate(selectedAgent._id, {
        $inc: { assigned_orders: 1 },
      });

      console.log(
        `✅ Retry: Order ${order._id} assigned to agent ${
          selectedAgent.name
        } (attempt ${attemptCount + 1}/${MAX_RETRY_ATTEMPTS})`
      );
      assignedCount++;

      // Send SSE notification
      try {
        const updatedOrder = await Order.findById(order._id)
          .populate("client_id")
          .populate("delivery.delivery_agent_id")
          .lean();
        const snapshot = buildSnapshot(updatedOrder);
        publish(String(order._id), snapshot);
        await notifyOrderUpdate(updatedOrder, snapshot);
      } catch (err) {
        console.error(`Failed to notify order ${order._id}:`, err.message);
      }
    }

    const responseMessage =
      assignedCount > 0 || escalatedCount > 0
        ? `✅ Retry complete: ${assignedCount} assigned, ${escalatedCount} escalated, ${skippedCount} skipped`
        : null; // Don't log if nothing happened

    // Only log if there was actual activity
    if (responseMessage) {
      console.log(responseMessage);
    } else if (skippedCount > 0) {
      console.log(
        `⏳ No orders ready for retry (${skippedCount} in cooldown or no agents available)`
      );
    }

    res.json({
      message: responseMessage || "No action taken",
      assigned: assignedCount,
      escalated: escalatedCount,
      skipped: skippedCount,
      total_pending: pendingOrders.length,
    });
  } catch (error) {
    console.error("Error retrying pending orders:", error);
    res.status(500).json({ error: "Failed to retry pending orders" });
  }
});

module.exports = router;
