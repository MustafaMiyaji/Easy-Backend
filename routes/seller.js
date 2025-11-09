const express = require("express");
const router = express.Router();
const {
  Product,
  Order,
  Seller,
  DeliveryAgent,
  Feedback,
  PlatformSettings,
  Review,
} = require("../models/models");
const {
  publish,
  addSellerClient,
  publishToSeller,
} = require("../services/orderEvents");
const { notifyOrderUpdate } = require("../services/push");
const { buildSnapshot } = require("../controllers/ordersController");
const mongoose = require("mongoose");

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

// Toggle seller open/closed status (availability)
router.post("/toggle-open", requireSeller, async (req, res) => {
  try {
    const { open } = req.body || {};
    if (typeof open !== "boolean")
      return res.status(400).json({ error: "boolean open required" });
    const updated = await Seller.findByIdAndUpdate(
      req.sellerId,
      { $set: { is_open: open } },
      { new: true, projection: { business_name: 1, is_open: 1 } }
    );
    if (!updated) return res.status(404).json({ error: "seller not found" });
    res.json({ success: true, is_open: updated.is_open });
  } catch (e) {
    console.error("toggle-open error", e);
    res.status(500).json({ error: "failed to update open state" });
  }
});

// Middleware placeholder: in real scenario authenticate seller and attach seller_id
function requireSeller(req, res, next) {
  // For now expect ?sellerId= in query or seller_id in body (temporary until auth).
  const sellerId =
    req.query.sellerId || req.body.seller_id || req.headers["x-seller-id"];
  if (!sellerId || !mongoose.isValidObjectId(sellerId)) {
    return res.status(400).json({ error: "valid sellerId required" });
  }
  req.sellerId = sellerId;
  next();
}

// Create product
router.post("/products", requireSeller, async (req, res) => {
  try {
    const { name, category, price, stock, image, description, status } =
      req.body || {};
    if (!name || typeof price !== "number")
      return res.status(400).json({ error: "name and numeric price required" });
    const prod = await Product.create({
      seller_id: req.sellerId,
      name,
      category,
      price,
      // For restaurant items, stock isn't tracked; default to a generous number
      stock:
        typeof stock === "number"
          ? stock
          : (category || "").toString().toLowerCase().includes("restaurant") ||
            (category || "").toString().toLowerCase().includes("food")
          ? 100000
          : 0,
      image,
      description,
      status: status || "active",
    });
    res.status(201).json(prod);
  } catch (e) {
    console.error("Error creating product", e);
    res.status(500).json({ error: "failed to create product" });
  }
});

// Update product (full replace fields provided)
router.put("/products/:id", requireSeller, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id))
      return res.status(400).json({ error: "invalid product id" });
    const update = { ...req.body };
    delete update.seller_id; // prevent seller takeover
    const prod = await Product.findOneAndUpdate(
      { _id: id, seller_id: req.sellerId },
      update,
      { new: true }
    );
    if (!prod) return res.status(404).json({ error: "product not found" });
    res.json(prod);
  } catch (e) {
    console.error("Error updating product", e);
    res.status(500).json({ error: "failed to update product" });
  }
});

// Patch product (partial update)
router.patch("/products/:id", requireSeller, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id))
      return res.status(400).json({ error: "invalid product id" });
    const update = { ...req.body };
    delete update.seller_id;
    const prod = await Product.findOneAndUpdate(
      { _id: id, seller_id: req.sellerId },
      { $set: update },
      { new: true }
    );
    if (!prod) return res.status(404).json({ error: "product not found" });
    res.json(prod);
  } catch (e) {
    console.error("Error patching product", e);
    res.status(500).json({ error: "failed to patch product" });
  }
});

// Delete (soft deactivate)
router.delete("/products/:id", requireSeller, async (req, res) => {
  try {
    const { id } = req.params;
    const { permanent } = req.query; // Check if permanent delete requested

    if (!mongoose.isValidObjectId(id))
      return res.status(400).json({ error: "invalid product id" });

    // If permanent=true, actually delete the product
    if (permanent === "true") {
      const prod = await Product.findOneAndDelete({
        _id: id,
        seller_id: req.sellerId,
      });
      if (!prod) return res.status(404).json({ error: "product not found" });
      return res.json({ success: true, deleted: true, product: prod });
    }

    // Otherwise, soft delete (deactivate)
    const prod = await Product.findOneAndUpdate(
      { _id: id, seller_id: req.sellerId },
      { $set: { status: "inactive" } },
      { new: true }
    );
    if (!prod) return res.status(404).json({ error: "product not found" });
    res.json({ success: true, product: prod });
  } catch (e) {
    console.error("Error deleting product", e);
    res.status(500).json({ error: "failed to delete product" });
  }
});

// List seller products
router.get("/products", requireSeller, async (req, res) => {
  try {
    const prods = await Product.find({ seller_id: req.sellerId }).lean();
    res.json(prods);
  } catch (e) {
    console.error("Error listing products", e);
    res.status(500).json({ error: "failed to list products" });
  }
});

// Seller orders listing (parity): list any order that contains at least one product owned by this seller
router.get("/orders", requireSeller, async (req, res) => {
  try {
    const sellerObjectId = new mongoose.Types.ObjectId(req.sellerId);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const pageSize = Math.min(
      Math.max(parseInt(req.query.pageSize) || 50, 1),
      200
    );
    const skip = (page - 1) * pageSize;

    const pipeline = [
      {
        $lookup: {
          from: "products",
          let: { itemProductIds: "$order_items.product_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $in: ["$_id", "$$itemProductIds"] },
                    { $eq: ["$seller_id", sellerObjectId] },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: "matchingProducts",
        },
      },
      { $match: { matchingProducts: { $ne: [] } } },
      {
        $facet: {
          data: [
            { $sort: { _id: -1 } },
            { $skip: skip },
            { $limit: pageSize },
            { $project: { matchingProducts: 0 } },
          ],
          totalCount: [{ $count: "count" }],
        },
      },
      {
        $project: {
          data: 1,
          total: { $ifNull: [{ $arrayElemAt: ["$totalCount.count", 0] }, 0] },
        },
      },
    ];

    const agg = await Order.aggregate(pipeline);
    const { data: orders = [], total = 0 } = agg[0] || {};
    // Ensure consistent order_id field for frontend compatibility
    const formatted = orders.map((o) => ({ ...o, order_id: o._id }));
    const wantMeta =
      req.query.meta === "1" ||
      req.query.meta === "true" ||
      typeof req.query.page !== "undefined" ||
      typeof req.query.pageSize !== "undefined";
    if (wantMeta) return res.json({ page, pageSize, total, orders: formatted });
    return res.json(formatted);
  } catch (e) {
    console.error("Error listing seller orders", e);
    res.status(500).json({ error: "failed to list seller orders" });
  }
});
// Get pending orders for seller approval
router.get("/orders/pending", requireSeller, async (req, res) => {
  try {
    const sellerObjectId = new mongoose.Types.ObjectId(req.sellerId);
    const pipeline = [
      { $match: { "payment.status": "pending" } },
      {
        $lookup: {
          from: "products",
          let: { itemProductIds: "$order_items.product_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $in: ["$_id", "$$itemProductIds"] },
                    { $eq: ["$seller_id", sellerObjectId] },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: "matchingProducts",
        },
      },
      { $match: { matchingProducts: { $ne: [] } } },
      { $sort: { created_at: -1 } },
      { $project: { matchingProducts: 0 } },
    ];

    const pendingOrders = await Order.aggregate(pipeline);

    const formattedOrders = pendingOrders.map((order) => ({
      order_id: order._id,
      order_number: `ORD${order._id
        .toString()
        .slice(-3)
        .toUpperCase()}${Math.floor(Math.random() * 100)}`,
      customer_name: order.client_id?.name || "Customer",
      customer_phone: order.client_id?.phone || "N/A",
      delivery_to:
        order.delivery?.delivery_address?.full_address ||
        "Address not available",
      total_amount: order.payment?.amount || 0,
      items: order.order_items || [],
      created_at: order.created_at,
    }));

    res.json(formattedOrders);
  } catch (error) {
    console.error("Error fetching pending orders:", error);
    res.status(500).json({ error: "Failed to fetch pending orders" });
  }
});

// Get a single order details (validated for this seller)
router.get("/orders/:id", requireSeller, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid order ID" });
    }
    const order = await Order.findById(id)
      .populate({
        path: "order_items.product_id",
        select: "name price category seller_id",
      })
      .lean();
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Validate this order includes at least one item for this seller
    const itemProductIds = (order.order_items || [])
      .map((i) => i && i.product_id && i.product_id._id)
      .filter(Boolean);
    if (!itemProductIds.length) {
      return res
        .status(403)
        .json({ error: "Order has no items to validate for seller" });
    }
    const sellerHasItems = await Product.exists({
      _id: { $in: itemProductIds },
      seller_id: req.sellerId,
    });
    if (!sellerHasItems) {
      return res
        .status(403)
        .json({ error: "Order does not include any items from this seller" });
    }

    // Build a concise payload
    const items = (order.order_items || []).map((it) => ({
      product_id: it.product_id?._id || it.product_id,
      name: it.product_id?.name || it.name_snapshot || "Item",
      price:
        typeof it.price_snapshot === "number"
          ? it.price_snapshot
          : it.product_id?.price || null,
      qty: it.qty,
      category: it.product_id?.category,
    }));
    const resp = {
      _id: order._id,
      order_id: order._id,
      status:
        order.status ||
        order.payment?.status ||
        order.delivery?.delivery_status ||
        "pending",
      payment: order.payment || {},
      delivery: order.delivery || {},
      items,
      created_at: order.created_at,
    };
    return res.json(resp);
  } catch (e) {
    console.error("Error fetching seller order by id", e);
    res.status(500).json({ error: "Failed to fetch order" });
  }
});

// SSE stream for all seller-related order updates (subscribe once per seller)
router.get("/stream", requireSeller, async (req, res) => {
  try {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(": connected\n\n");
    addSellerClient(String(req.sellerId), res);
  } catch (e) {
    console.error("seller stream error", e);
    try {
      res.status(500).end();
    } catch (_) {}
  }
});

// Accept order
router.post("/orders/accept", requireSeller, async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!mongoose.isValidObjectId(orderId)) {
      return res.status(400).json({ error: "Invalid order ID" });
    }

    // Load order, then verify it contains at least one item owned by this seller
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const itemProductIds = (order.order_items || [])
      .map((i) => i && i.product_id)
      .filter(Boolean);
    if (!itemProductIds.length) {
      return res
        .status(403)
        .json({ error: "Order has no items to validate for seller" });
    }
    const sellerHasItems = await Product.exists({
      _id: { $in: itemProductIds },
      seller_id: req.sellerId,
    });
    if (!sellerHasItems) {
      return res
        .status(403)
        .json({ error: "Order does not include any items from this seller" });
    }

    // REMOVED: Manual payment status update - payment is now auto-set to 'paid' when order is delivered
    // Update order to move to delivery pending status
    let updatedOrder = await Order.findByIdAndUpdate(
      orderId,
      {
        $set: {
          "delivery.delivery_status": "pending",
        },
      },
      { new: true }
    );

    // Get store location from seller (for distance calculation)
    let storeLat, storeLng;
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

    // If we don't have store location, fallback to pickup_address or delivery address
    if (!storeLat || !storeLng) {
      storeLat =
        order.pickup_address?.location?.lat ||
        order.delivery_address?.location?.lat;
      storeLng =
        order.pickup_address?.location?.lng ||
        order.delivery_address?.location?.lng;
    }

    // Find all available delivery agents and assign to nearest one
    const MAX_CONCURRENT_DELIVERIES = 3; // Agent can handle max 3 active deliveries

    const availableAgents = await DeliveryAgent.find({
      approved: true,
      active: true,
      available: true,
    }).lean();

    // Filter agents by capacity
    const agentsWithCapacity = await Promise.all(
      availableAgents.map(async (agent) => {
        const activeDeliveries = await Order.countDocuments({
          "delivery.delivery_agent_id": agent._id,
          "delivery.delivery_status": {
            $in: ["assigned", "picked_up", "in_transit"],
          },
        });

        const hasCapacity = activeDeliveries < MAX_CONCURRENT_DELIVERIES;
        return hasCapacity ? agent : null;
      })
    );

    const availableAgentsWithCapacity = agentsWithCapacity.filter(
      (a) => a !== null
    );

    // LOW AVAILABILITY MODE: When agents are scarce (3 or fewer), ignore distance
    // and assign to ANY available agent to ensure orders get delivered
    const LOW_AVAILABILITY_THRESHOLD = 3;
    const isLowAvailability =
      availableAgentsWithCapacity.length <= LOW_AVAILABILITY_THRESHOLD;

    let selectedAgent = null;
    if (availableAgentsWithCapacity.length > 0 && storeLat && storeLng) {
      // Calculate distance for each agent and sort by nearest
      const agentsWithDistance = availableAgentsWithCapacity
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
        selectedAgent = agentsWithDistance[0].agent;
        const distanceKm = agentsWithDistance[0].distance.toFixed(2);
        console.log(
          `${
            isLowAvailability ? "⚠️ LOW AVAILABILITY MODE: " : ""
          }Order ${orderId} assigned to ${
            isLowAvailability ? "available" : "nearest"
          } agent ${selectedAgent.name} (${distanceKm} km away)${
            isLowAvailability
              ? " - ignoring distance due to low agent count"
              : ""
          }`
        );
      } else {
        // Fallback: if no agents have location, use least assigned
        selectedAgent = availableAgentsWithCapacity.sort(
          (a, b) => a.assigned_orders - b.assigned_orders
        )[0];
        console.log(
          `${
            isLowAvailability ? "⚠️ LOW AVAILABILITY MODE: " : ""
          }Order ${orderId} assigned to agent ${
            selectedAgent.name
          } (least assigned, no location data)`
        );
      }
    } else if (availableAgentsWithCapacity.length > 0) {
      // No store location, fallback to least assigned
      selectedAgent = availableAgentsWithCapacity.sort(
        (a, b) => a.assigned_orders - b.assigned_orders
      )[0];
      console.log(
        `${
          isLowAvailability ? "⚠️ LOW AVAILABILITY MODE: " : ""
        }Order ${orderId} assigned to agent ${
          selectedAgent.name
        } (least assigned, no store location)`
      );
    } else if (availableAgents.length > 0) {
      // All agents are at capacity - order will be queued
      console.log(
        `⚠️ Order ${orderId} queued - all ${availableAgents.length} agents at capacity`
      );
    }

    if (selectedAgent) {
      updatedOrder = await Order.findByIdAndUpdate(
        orderId,
        {
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
        },
        { new: true }
      );
    }

    // Publish SSE + push
    try {
      const freshOrder = updatedOrder || order;
      const snapshot = buildSnapshot(freshOrder);
      publish(String(freshOrder._id), snapshot);
      if (snapshot.seller_id)
        publishToSeller(String(snapshot.seller_id), snapshot); // sanitized in publisher
      await notifyOrderUpdate(
        freshOrder.toObject ? freshOrder.toObject() : freshOrder,
        snapshot,
        { excludeRoles: ["seller"] }
      );
    } catch (_) {}

    res.json({
      message: "Order accepted successfully",
      order: updatedOrder,
      delivery_agent: selectedAgent ? selectedAgent.name : "No agent available",
    });
  } catch (error) {
    console.error("Error accepting order:", error);
    res.status(500).json({ error: "Failed to accept order" });
  }
});

// Reject order
router.post("/orders/reject", requireSeller, async (req, res) => {
  try {
    const { orderId, reason } = req.body || {};

    if (!mongoose.isValidObjectId(orderId)) {
      return res.status(400).json({ error: "Invalid order ID" });
    }
    const reasonStr = (reason ?? "").toString().trim();
    if (!reasonStr || reasonStr.length < 3) {
      return res
        .status(400)
        .json({ error: "rejection reason is required (min 3 chars)" });
    }

    // Load order, then verify it contains at least one item owned by this seller
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    const itemProductIds = (order.order_items || [])
      .map((i) => i && i.product_id)
      .filter(Boolean);
    if (!itemProductIds.length) {
      return res
        .status(403)
        .json({ error: "Order has no items to validate for seller" });
    }
    const sellerHasItems = await Product.exists({
      _id: { $in: itemProductIds },
      seller_id: req.sellerId,
    });
    if (!sellerHasItems) {
      return res
        .status(403)
        .json({ error: "Order does not include any items from this seller" });
    }

    // Update order status to cancelled and store reason
    const updatedOrder = await Order.findByIdAndUpdate(
      orderId,
      {
        $set: {
          "payment.status": "canceled",
          "delivery.delivery_status": "cancelled",
          "delivery.cancellation_reason": reasonStr,
          "delivery.cancelled_by": "seller",
          "delivery.cancelled_at": new Date(),
        },
      },
      { new: true }
    );

    // Publish SSE + push
    try {
      const snapshot = buildSnapshot(updatedOrder);
      publish(String(updatedOrder._id), snapshot);
      if (snapshot.seller_id)
        publishToSeller(String(snapshot.seller_id), snapshot); // sanitized in publisher
      await notifyOrderUpdate(
        updatedOrder.toObject ? updatedOrder.toObject() : updatedOrder,
        snapshot,
        { excludeRoles: ["seller"] }
      );
    } catch (_) {}

    res.json({ message: "Order rejected successfully", order: updatedOrder });
  } catch (error) {
    console.error("Error rejecting order:", error);
    res.status(500).json({ error: "Failed to reject order" });
  }
});

// ============================================================================
// DELIVERY AGENT AVAILABILITY CHECK (Before Order Acceptance)
// ============================================================================

/**
 * Check delivery agent availability before accepting an order
 * Returns: total online agents, nearby agents, agent capacity info
 *
 * POST /api/seller/check-delivery-availability
 * Body: { storeLocation: { lat, lng }, orderId? }
 */
router.post("/check-delivery-availability", requireSeller, async (req, res) => {
  try {
    const { storeLocation, orderId } = req.body;

    if (!storeLocation || !storeLocation.lat || !storeLocation.lng) {
      return res
        .status(400)
        .json({ error: "Store location (lat, lng) required" });
    }

    const MAX_CONCURRENT_DELIVERIES = 3; // Agent can handle max 3 active deliveries
    const NEARBY_RADIUS_KM = 10; // Consider agents within 10km as "nearby"

    // Get all approved, active agents
    const allAgents = await DeliveryAgent.find({
      approved: true,
      active: true,
    }).lean();

    // Count agents by availability status
    const onlineAgents = allAgents.filter((a) => a.available);
    const offlineAgents = allAgents.filter((a) => !a.available);

    // Calculate active deliveries for each online agent
    const agentsWithCapacity = await Promise.all(
      onlineAgents.map(async (agent) => {
        // Count active deliveries (assigned, picked_up, in_transit)
        const activeDeliveries = await Order.countDocuments({
          "delivery.delivery_agent_id": agent._id,
          "delivery.delivery_status": {
            $in: ["assigned", "picked_up", "in_transit"],
          },
        });

        const availableCapacity = MAX_CONCURRENT_DELIVERIES - activeDeliveries;
        const hasCapacity = availableCapacity > 0;

        // Calculate distance if location available
        let distance = null;
        if (agent.current_location?.lat && agent.current_location?.lng) {
          distance = calculateDistance(
            storeLocation.lat,
            storeLocation.lng,
            agent.current_location.lat,
            agent.current_location.lng
          );
        }

        return {
          agentId: agent._id,
          name: agent.name,
          activeDeliveries,
          availableCapacity,
          hasCapacity,
          distance,
          isNearby: distance !== null && distance <= NEARBY_RADIUS_KM,
        };
      })
    );

    // Filter agents with capacity
    const availableAgents = agentsWithCapacity.filter((a) => a.hasCapacity);
    const nearbyAvailableAgents = availableAgents.filter((a) => a.isNearby);

    // Find nearest available agent
    const agentsWithDistance = availableAgents.filter(
      (a) => a.distance !== null
    );
    agentsWithDistance.sort((a, b) => a.distance - b.distance);
    const nearestAgent =
      agentsWithDistance.length > 0 ? agentsWithDistance[0] : null;

    // Calculate estimated wait time based on agent load
    let estimatedWaitMinutes = 0;
    if (availableAgents.length === 0) {
      estimatedWaitMinutes = 15; // No agents available, might take 15+ min
    } else if (nearbyAvailableAgents.length === 0) {
      estimatedWaitMinutes = 10; // Agents available but far away
    } else {
      const avgLoad =
        nearbyAvailableAgents.reduce((sum, a) => sum + a.activeDeliveries, 0) /
        nearbyAvailableAgents.length;
      estimatedWaitMinutes = Math.ceil(avgLoad * 2); // Each active delivery adds ~2 min delay
    }

    // Recommendation
    let recommendation = "proceed";
    let message = "Delivery agents available";

    if (availableAgents.length === 0) {
      recommendation = "warn";
      message = "No delivery agents available. Order may be delayed or queued.";
    } else if (nearbyAvailableAgents.length === 0 && nearestAgent) {
      recommendation = "caution";
      message = `Nearest agent is ${nearestAgent.distance.toFixed(
        1
      )}km away. Pickup may be delayed.`;
    } else if (nearbyAvailableAgents.length <= 2) {
      recommendation = "caution";
      message = "Limited agents nearby. Consider order timing.";
    }

    res.json({
      success: true,
      availability: {
        totalAgents: allAgents.length,
        onlineAgents: onlineAgents.length,
        offlineAgents: offlineAgents.length,
        availableAgents: availableAgents.length,
        nearbyAvailableAgents: nearbyAvailableAgents.length,
        agentsAtCapacity: onlineAgents.length - availableAgents.length,
      },
      nearestAgent: nearestAgent
        ? {
            name: nearestAgent.name,
            distance: parseFloat(nearestAgent.distance.toFixed(2)),
            activeDeliveries: nearestAgent.activeDeliveries,
            availableCapacity: nearestAgent.availableCapacity,
          }
        : null,
      estimatedWaitMinutes,
      recommendation,
      message,
      details: {
        maxConcurrentDeliveries: MAX_CONCURRENT_DELIVERIES,
        nearbyRadiusKm: NEARBY_RADIUS_KM,
      },
    });
  } catch (error) {
    console.error("Error checking delivery availability:", error);
    res.status(500).json({ error: "Failed to check delivery availability" });
  }
});

module.exports = router;

// ---------------- Seller Feedback & Earnings (appended endpoints) ----------------
// Create feedback from seller perspective. Uses sellerId as user_id to keep traceable.
router.post("/:sellerId/feedback", async (req, res) => {
  try {
    const { sellerId } = req.params;
    const { message, type } = req.body || {};
    if (!sellerId || !mongoose.isValidObjectId(sellerId)) {
      return res.status(400).json({ error: "valid sellerId required" });
    }
    if (!message || String(message).trim().length < 3) {
      return res
        .status(400)
        .json({ error: "message is required (min 3 chars)" });
    }
    const fb = await Feedback.create({
      user_id: String(sellerId),
      message: String(message).trim(),
      ...(type ? { type } : {}),
    });
    res.status(201).json(fb);
  } catch (e) {
    console.error("seller feedback create error", e);
    res.status(500).json({ error: "failed to submit feedback" });
  }
});

// List feedback created by this seller
router.get("/:sellerId/feedback", async (req, res) => {
  try {
    const { sellerId } = req.params;
    if (!sellerId || !mongoose.isValidObjectId(sellerId)) {
      return res.status(400).json({ error: "valid sellerId required" });
    }
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const [total, rows] = await Promise.all([
      Feedback.countDocuments({ user_id: String(sellerId) }),
      Feedback.find({ user_id: String(sellerId) })
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);
    res.json({ page, limit, total, rows });
  } catch (e) {
    console.error("seller feedback list error", e);
    res.status(500).json({ error: "failed to list feedback" });
  }
});

// Seller earnings summary
// Computes totals from delivered orders containing seller's items.
router.get("/:sellerId/earnings/summary", async (req, res) => {
  try {
    const { sellerId } = req.params;
    if (!sellerId || !mongoose.isValidObjectId(sellerId)) {
      return res.status(400).json({ error: "valid sellerId required" });
    }
    // Optional date filters
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const sellerObjectId = new mongoose.Types.ObjectId(sellerId);
    const match = { "delivery.delivery_status": "delivered" };
    if (from || to) {
      match.created_at = {};
      if (from && !isNaN(from)) match.created_at.$gte = from;
      if (to && !isNaN(to)) match.created_at.$lte = to;
    }

    // Load settings for commission and delivery share
    const settings = (await PlatformSettings.findOne().lean()) || {};
    const commissionRate = Number(settings.platform_commission_rate ?? 0.1);

    // Aggregate item totals for this seller
    const pipeline = [
      { $match: match },
      {
        $lookup: {
          from: "products",
          let: { pids: "$order_items.product_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $in: ["$_id", "$$pids"] },
                    { $eq: ["$seller_id", sellerObjectId] },
                  ],
                },
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "sellerOwned",
        },
      },
      { $match: { sellerOwned: { $ne: [] } } },
      {
        $project: {
          order_items: 1,
          delivery_charge: "$delivery.delivery_charge",
          created_at: 1,
        },
      },
      { $unwind: "$order_items" },
      {
        $lookup: {
          from: "products",
          localField: "order_items.product_id",
          foreignField: "_id",
          as: "prod",
        },
      },
      { $unwind: "$prod" },
      { $match: { "prod.seller_id": sellerObjectId } },
      {
        $group: {
          _id: null,
          item_total: {
            $sum: {
              $multiply: ["$order_items.price_snapshot", "$order_items.qty"],
            },
          },
          orders: { $addToSet: "$_id" },
          delivery_total: { $sum: { $ifNull: ["$delivery_charge", 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          item_total: 1,
          orders_count: { $size: "$orders" },
          delivery_total: 1,
        },
      },
    ];

    const agg = await Order.aggregate(pipeline);
    const base = agg[0] || {
      item_total: 0,
      orders_count: 0,
      delivery_total: 0,
    };
    const platform_commission = +(base.item_total * commissionRate).toFixed(2);
    const seller_gross = +base.item_total.toFixed(2);
    const seller_net = +(seller_gross - platform_commission).toFixed(2);

    res.json({
      from: from || null,
      to: to || null,
      orders_count: base.orders_count,
      item_total: seller_gross,
      platform_commission_rate: commissionRate,
      platform_commission,
      seller_net,
    });
  } catch (e) {
    console.error("seller earnings summary error", e);
    res.status(500).json({ error: "failed to compute earnings" });
  }
});

// Seller earnings logs (history)
router.get("/:sellerId/earnings/logs", async (req, res) => {
  try {
    const { sellerId } = req.params;
    if (!sellerId || !mongoose.isValidObjectId(sellerId)) {
      return res.status(400).json({ error: "valid sellerId required" });
    }
    const { from, to } = req.query;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const { EarningLog } = require("../models/models");
    const q = { role: "seller", seller_id: sellerId };
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
    console.error("seller earnings logs error", e);
    res.status(500).json({ error: "failed to fetch earnings logs" });
  }
});

// ========================================
// SALES ANALYTICS DASHBOARD
// ========================================

/**
 * GET /api/seller/analytics
 * Sales analytics for seller dashboard
 * Query params:
 *   - period: 'today' | 'week' | 'month' | 'year' | 'all' (default: 'month')
 */
router.get("/analytics", requireSeller, async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const period = req.query.period || "month";

    // Calculate date range
    const now = new Date();
    let startDate;
    switch (period) {
      case "today":
        startDate = new Date(now.setHours(0, 0, 0, 0));
        break;
      case "week":
        startDate = new Date(now.setDate(now.getDate() - 7));
        break;
      case "month":
        startDate = new Date(now.setMonth(now.getMonth() - 1));
        break;
      case "year":
        startDate = new Date(now.setFullYear(now.getFullYear() - 1));
        break;
      case "all":
        startDate = new Date(0); // Beginning of time
        break;
      default:
        startDate = new Date(now.setMonth(now.getMonth() - 1));
    }

    // Aggregation pipeline for analytics
    // Use item-level price snapshots to compute revenue (more accurate than payment.amount for potential adjustments/discounts)
    const analytics = await Order.aggregate([
      {
        $match: {
          created_at: { $gte: startDate },
          $or: [
            { seller_id: new mongoose.Types.ObjectId(sellerId) },
            { "items.seller_id": new mongoose.Types.ObjectId(sellerId) }, // legacy orders
          ],
        },
      },
      // Normalize items array across legacy/new schemas and keep seller ObjectId for filtering
      {
        $addFields: {
          itemsNormalized: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$order_items", []] } }, 0] },
              "$order_items",
              { $ifNull: ["$items", []] },
            ],
          },
          _sellerOid: { $toObjectId: sellerId },
        },
      },
      {
        $facet: {
          overview: [
            {
              $addFields: {
                // Fallback to price if price_snapshot missing (older orders)
                computedItemTotal: {
                  $sum: {
                    $map: {
                      input: { $ifNull: ["$itemsNormalized", []] },
                      as: "it",
                      in: {
                        $cond: [
                          // If legacy item has seller_id, include only matching this seller; for new items (no seller_id), include all
                          { $ifNull: ["$$it.seller_id", false] },
                          {
                            $cond: [
                              { $eq: ["$$it.seller_id", "$_sellerOid"] },
                              {
                                $multiply: [
                                  {
                                    $ifNull: [
                                      "$$it.qty",
                                      { $ifNull: ["$$it.quantity", 0] },
                                    ],
                                  },
                                  {
                                    $ifNull: [
                                      "$$it.price_snapshot",
                                      { $ifNull: ["$$it.price", 0] },
                                    ],
                                  },
                                ],
                              },
                              0,
                            ],
                          },
                          {
                            $multiply: [
                              {
                                $ifNull: [
                                  "$$it.qty",
                                  { $ifNull: ["$$it.quantity", 0] },
                                ],
                              },
                              {
                                $ifNull: [
                                  "$$it.price_snapshot",
                                  { $ifNull: ["$$it.price", 0] },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
            {
              $group: {
                _id: null,
                totalRevenue: { $sum: "$computedItemTotal" },
                totalOrders: { $sum: 1 },
                completedOrders: {
                  $sum: {
                    $cond: [
                      { $eq: ["$delivery.delivery_status", "delivered"] },
                      1,
                      0,
                    ],
                  },
                },
                cancelledOrders: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0],
                  },
                },
                pendingOrders: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $ne: ["$status", "cancelled"] },
                          { $ne: ["$delivery.delivery_status", "delivered"] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ],
          topProducts: [
            {
              $unwind: {
                path: "$itemsNormalized",
                preserveNullAndEmptyArrays: false,
              },
            },
            {
              $group: {
                _id: "$itemsNormalized.product_id",
                productName: {
                  $first: {
                    $ifNull: [
                      "$itemsNormalized.name_snapshot",
                      "$itemsNormalized.name",
                    ],
                  },
                },
                totalQuantity: {
                  $sum: {
                    $ifNull: [
                      "$itemsNormalized.qty",
                      { $ifNull: ["$itemsNormalized.quantity", 0] },
                    ],
                  },
                },
                totalRevenue: {
                  $sum: {
                    $cond: [
                      { $ifNull: ["$itemsNormalized.seller_id", false] },
                      {
                        $cond: [
                          {
                            $eq: ["$itemsNormalized.seller_id", "$_sellerOid"],
                          },
                          {
                            $multiply: [
                              {
                                $ifNull: [
                                  "$itemsNormalized.qty",
                                  { $ifNull: ["$itemsNormalized.quantity", 0] },
                                ],
                              },
                              {
                                $ifNull: [
                                  "$itemsNormalized.price_snapshot",
                                  { $ifNull: ["$itemsNormalized.price", 0] },
                                ],
                              },
                            ],
                          },
                          0,
                        ],
                      },
                      {
                        $multiply: [
                          {
                            $ifNull: [
                              "$itemsNormalized.qty",
                              { $ifNull: ["$itemsNormalized.quantity", 0] },
                            ],
                          },
                          {
                            $ifNull: [
                              "$itemsNormalized.price_snapshot",
                              { $ifNull: ["$itemsNormalized.price", 0] },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                },
                orderCount: { $sum: 1 },
              },
            },
            { $sort: { totalRevenue: -1 } },
            { $limit: 10 },
          ],
          revenueByDay: [
            {
              $addFields: {
                dayItemTotal: {
                  $sum: {
                    $map: {
                      input: { $ifNull: ["$itemsNormalized", []] },
                      as: "it",
                      in: {
                        $cond: [
                          { $ifNull: ["$$it.seller_id", false] },
                          {
                            $cond: [
                              { $eq: ["$$it.seller_id", "$_sellerOid"] },
                              {
                                $multiply: [
                                  {
                                    $ifNull: [
                                      "$$it.qty",
                                      { $ifNull: ["$$it.quantity", 0] },
                                    ],
                                  },
                                  {
                                    $ifNull: [
                                      "$$it.price_snapshot",
                                      { $ifNull: ["$$it.price", 0] },
                                    ],
                                  },
                                ],
                              },
                              0,
                            ],
                          },
                          {
                            $multiply: [
                              {
                                $ifNull: [
                                  "$$it.qty",
                                  { $ifNull: ["$$it.quantity", 0] },
                                ],
                              },
                              {
                                $ifNull: [
                                  "$$it.price_snapshot",
                                  { $ifNull: ["$$it.price", 0] },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
            {
              $group: {
                _id: {
                  $dateToString: { format: "%Y-%m-%d", date: "$created_at" },
                },
                revenue: { $sum: "$dayItemTotal" },
                orders: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
            { $limit: 30 },
          ],
          paymentMethods: [
            {
              $addFields: {
                methodItemTotal: {
                  $sum: {
                    $map: {
                      input: { $ifNull: ["$itemsNormalized", []] },
                      as: "it",
                      in: {
                        $cond: [
                          { $ifNull: ["$$it.seller_id", false] },
                          {
                            $cond: [
                              { $eq: ["$$it.seller_id", "$_sellerOid"] },
                              {
                                $multiply: [
                                  {
                                    $ifNull: [
                                      "$$it.qty",
                                      { $ifNull: ["$$it.quantity", 0] },
                                    ],
                                  },
                                  {
                                    $ifNull: [
                                      "$$it.price_snapshot",
                                      { $ifNull: ["$$it.price", 0] },
                                    ],
                                  },
                                ],
                              },
                              0,
                            ],
                          },
                          {
                            $multiply: [
                              {
                                $ifNull: [
                                  "$$it.qty",
                                  { $ifNull: ["$$it.quantity", 0] },
                                ],
                              },
                              {
                                $ifNull: [
                                  "$$it.price_snapshot",
                                  { $ifNull: ["$$it.price", 0] },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
            {
              $group: {
                _id: "$payment.method",
                count: { $sum: 1 },
                revenue: { $sum: "$methodItemTotal" },
              },
            },
          ],
        },
      },
    ]);

    const result = analytics[0];
    const overview = result.overview[0] || {
      totalRevenue: 0,
      totalOrders: 0,
      completedOrders: 0,
      cancelledOrders: 0,
      pendingOrders: 0,
    };

    // Calculate average order value
    const avgOrderValue =
      overview.totalOrders > 0
        ? overview.totalRevenue / overview.totalOrders
        : 0;

    res.json({
      period,
      overview: {
        ...overview,
        avgOrderValue: Math.round(avgOrderValue * 100) / 100,
      },
      topProducts: result.topProducts,
      revenueByDay: result.revenueByDay,
      paymentMethods: result.paymentMethods,
    });
  } catch (e) {
    console.error("seller analytics error", e);
    res.status(500).json({ error: "failed to fetch analytics" });
  }
});

// ========================================
// PRODUCT REVIEWS & RATINGS
// ========================================

/**
 * GET /api/seller/products/reviews
 * Get all reviews for seller's products
 * Query params:
 *   - productId: (optional) filter by specific product
 *   - page: (default: 1)
 *   - limit: (default: 20)
 */
router.get("/products/reviews", requireSeller, async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { productId, page = 1, limit = 20 } = req.query;

    // First, get all seller's products
    const productsQuery = { seller_id: sellerId };
    if (productId) {
      productsQuery._id = productId;
    }
    const sellerProducts = await Product.find(productsQuery)
      .select("_id name")
      .lean();

    if (!sellerProducts.length) {
      return res.json({
        reviews: [],
        page: parseInt(page),
        limit: parseInt(limit),
        total: 0,
        stats: {
          totalReviews: 0,
          averageRating: 0,
          ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        },
      });
    }

    const productIds = sellerProducts.map((p) => p._id);

    // Get reviews from Review collection
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [reviews, total, stats] = await Promise.all([
      // Paginated reviews
      Review.find({ product_id: { $in: productIds } })
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate("product_id", "name image")
        .lean(),

      // Total count
      Review.countDocuments({ product_id: { $in: productIds } }),

      // Rating statistics
      Review.aggregate([
        { $match: { product_id: { $in: productIds } } },
        {
          $facet: {
            overall: [
              {
                $group: {
                  _id: null,
                  averageRating: { $avg: "$rating" },
                  totalReviews: { $sum: 1 },
                },
              },
            ],
            distribution: [
              {
                $group: {
                  _id: "$rating",
                  count: { $sum: 1 },
                },
              },
            ],
          },
        },
      ]),
    ]);

    // Format statistics
    const overall = stats[0]?.overall[0] || {
      averageRating: 0,
      totalReviews: 0,
    };
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    stats[0]?.distribution.forEach((d) => {
      distribution[d._id] = d.count;
    });

    res.json({
      reviews: reviews.map((r) => ({
        _id: r._id,
        rating: r.rating,
        comment: r.comment,
        created_at: r.created_at,
        customer: {
          name: r.client_id?.name || "Anonymous",
          email: r.client_id?.email,
        },
        product: {
          _id: r.product_id?._id,
          name: r.product_id?.name,
          image: r.product_id?.image,
        },
      })),
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      stats: {
        totalReviews: overall.totalReviews,
        averageRating: Math.round((overall.averageRating || 0) * 10) / 10,
        ratingDistribution: distribution,
      },
    });
  } catch (e) {
    console.error("seller product reviews error", e);
    res.status(500).json({ error: "failed to fetch product reviews" });
  }
});

// ========================================
// SELLER REVIEW RESPONSES
// ========================================

/**
 * POST /api/seller/reviews/:reviewId/respond
 * Seller responds to a customer review
 */
router.post("/reviews/:reviewId/respond", requireSeller, async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { reviewId } = req.params;
    const { message } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: "Response message is required" });
    }

    if (message.length > 500) {
      return res
        .status(400)
        .json({ error: "Response cannot exceed 500 characters" });
    }

    // Find the review
    const review = await Review.findById(reviewId).populate(
      "product_id",
      "seller_id"
    );
    if (!review) {
      return res.status(404).json({ error: "Review not found" });
    }

    // Verify this review is for seller's product
    if (String(review.product_id.seller_id) !== String(sellerId)) {
      return res
        .status(403)
        .json({ error: "You can only respond to reviews for your products" });
    }

    // Add/update seller response
    review.seller_response = {
      message: message.trim(),
      responded_at: new Date(),
      seller_id: sellerId,
    };
    review.updated_at = new Date();

    await review.save();

    res.json({
      success: true,
      review: {
        _id: review._id,
        seller_response: review.seller_response,
      },
    });
  } catch (e) {
    console.error("seller review response error", e);
    res.status(500).json({ error: "failed to respond to review" });
  }
});

/**
 * DELETE /api/seller/reviews/:reviewId/respond
 * Delete seller's response to a review
 */
router.delete("/reviews/:reviewId/respond", requireSeller, async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { reviewId } = req.params;

    const review = await Review.findById(reviewId).populate(
      "product_id",
      "seller_id"
    );
    if (!review) {
      return res.status(404).json({ error: "Review not found" });
    }

    // Verify this review is for seller's product
    if (String(review.product_id.seller_id) !== String(sellerId)) {
      return res.status(403).json({
        error: "You can only delete responses for your products",
      });
    }

    // Remove seller response
    review.seller_response = undefined;
    review.updated_at = new Date();

    await review.save();

    res.json({ success: true });
  } catch (e) {
    console.error("delete review response error", e);
    res.status(500).json({ error: "failed to delete response" });
  }
});

// ========================================
// ANALYTICS EXPORT (CSV)
// ========================================

/**
 * GET /api/seller/analytics/export
 * Export analytics as CSV
 * Query params:
 *   - period: 'today' | 'week' | 'month' | 'year' | 'all'
 */
router.get("/analytics/export", requireSeller, async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const period = req.query.period || "month";

    // Calculate date range (same logic as analytics endpoint)
    const now = new Date();
    let startDate;
    switch (period) {
      case "today":
        startDate = new Date(now.setHours(0, 0, 0, 0));
        break;
      case "week":
        startDate = new Date(now.setDate(now.getDate() - 7));
        break;
      case "month":
        startDate = new Date(now.setMonth(now.getMonth() - 1));
        break;
      case "year":
        startDate = new Date(now.setFullYear(now.getFullYear() - 1));
        break;
      case "all":
        startDate = new Date(0);
        break;
      default:
        startDate = new Date(now.setMonth(now.getMonth() - 1));
    }

    // Get orders
    const orders = await Order.find({
      seller_id: new mongoose.Types.ObjectId(sellerId),
      created_at: { $gte: startDate },
    })
      .sort({ created_at: -1 })
      .lean();

    // Generate CSV
    let csv = "Order ID,Date,Customer,Items,Amount,Payment Method,Status\n";

    for (const order of orders) {
      const orderId = String(order._id).slice(-8);
      const date = new Date(order.created_at).toISOString().split("T")[0];
      const customer = order.client_id || "N/A";
      const itemCount = order.order_items?.length || 0;
      const amount = order.payment?.amount || 0;
      const method = order.payment?.method || "N/A";
      const status =
        order.status || order.delivery?.delivery_status || "pending";

      csv += `${orderId},${date},${customer},${itemCount},${amount},${method},${status}\n`;
    }

    // Set headers for CSV download
    const filename = `analytics_${period}_${Date.now()}.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (e) {
    console.error("analytics export error", e);
    res.status(500).json({ error: "failed to export analytics" });
  }
});

// ========================================
// REAL-TIME ANALYTICS SSE
// ========================================

const sellerAnalyticsClients = new Map();

/**
 * GET /api/seller/analytics/stream
 * SSE endpoint for real-time analytics updates
 */
router.get("/analytics/stream", requireSeller, async (req, res) => {
  const sellerId = req.sellerId;

  // Setup SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Store client connection
  if (!sellerAnalyticsClients.has(sellerId)) {
    sellerAnalyticsClients.set(sellerId, new Set());
  }
  sellerAnalyticsClients.get(sellerId).add(res);

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  // Send analytics update every 30 seconds
  const interval = setInterval(async () => {
    try {
      // Quick stats for real-time updates
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const stats = await Order.aggregate([
        {
          $match: {
            seller_id: new mongoose.Types.ObjectId(sellerId),
            created_at: { $gte: today },
          },
        },
        {
          $group: {
            _id: null,
            todayRevenue: { $sum: "$payment.amount" },
            todayOrders: { $sum: 1 },
            pendingOrders: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: ["$status", "cancelled"] },
                      { $ne: ["$delivery.delivery_status", "delivered"] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]);

      const data = stats[0] || {
        todayRevenue: 0,
        todayOrders: 0,
        pendingOrders: 0,
      };

      res.write(
        `data: ${JSON.stringify({
          type: "update",
          data,
          timestamp: new Date(),
        })}\n\n`
      );
    } catch (error) {
      console.error("SSE analytics update error:", error);
    }
  }, 30000); // Update every 30 seconds

  // Cleanup on connection close
  req.on("close", () => {
    clearInterval(interval);
    const clients = sellerAnalyticsClients.get(sellerId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        sellerAnalyticsClients.delete(sellerId);
      }
    }
  });
});

/**
 * Helper function to broadcast analytics updates to all connected sellers
 * Call this when an order is created/updated
 */
function broadcastAnalyticsUpdate(sellerId, data) {
  const clients = sellerAnalyticsClients.get(String(sellerId));
  if (clients && clients.size > 0) {
    const message = `data: ${JSON.stringify({
      type: "order_update",
      data,
    })}\n\n`;
    clients.forEach((client) => {
      try {
        client.write(message);
      } catch (error) {
        console.error("Failed to send SSE update:", error);
      }
    });
  }
}

// Export for use in other files
router.broadcastAnalyticsUpdate = broadcastAnalyticsUpdate;

// ============================================================================
// INVENTORY MANAGEMENT (For Restaurants)
// ============================================================================

// Get inventory with low stock alerts
router.get("/inventory", requireSeller, async (req, res) => {
  try {
    const { lowStockOnly, threshold = 10 } = req.query;

    const query = { seller_id: req.sellerId };

    // Build products query
    const products = await Product.find(query)
      .select("name stock price category status image created_at updated_at")
      .sort({ stock: 1, name: 1 })
      .lean();

    // Filter low stock if requested
    let filteredProducts = products;
    if (lowStockOnly === "true") {
      filteredProducts = products.filter(
        (p) => (p.stock || 0) <= parseInt(threshold)
      );
    }

    // Calculate stats
    const stats = {
      totalProducts: products.length,
      lowStockCount: products.filter(
        (p) => (p.stock || 0) <= parseInt(threshold)
      ).length,
      outOfStockCount: products.filter((p) => (p.stock || 0) === 0).length,
      activeProducts: products.filter((p) => p.status === "active").length,
      inactiveProducts: products.filter((p) => p.status === "inactive").length,
    };

    res.json({
      success: true,
      data: {
        products: filteredProducts,
        stats,
        threshold: parseInt(threshold),
      },
    });
  } catch (error) {
    console.error("Get inventory error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch inventory",
      error: error.message,
    });
  }
});

// Update product stock
router.put("/inventory/:productId/stock", requireSeller, async (req, res) => {
  try {
    const { productId } = req.params;
    const { stock } = req.body;

    if (typeof stock !== "number" || stock < 0) {
      return res.status(400).json({
        success: false,
        message: "Stock must be a non-negative number",
      });
    }

    const product = await Product.findOne({
      _id: productId,
      seller_id: req.sellerId,
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    product.stock = stock;
    await product.save();

    res.json({
      success: true,
      message: "Stock updated successfully",
      data: {
        product_id: product._id,
        name: product.name,
        stock: product.stock,
      },
    });
  } catch (error) {
    console.error("Update stock error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update stock",
      error: error.message,
    });
  }
});

// Bulk update stock (for multiple products)
router.post("/inventory/bulk-update", requireSeller, async (req, res) => {
  try {
    const { updates } = req.body; // [{product_id, stock}, ...]

    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Updates array is required",
      });
    }

    const results = {
      success: [],
      failed: [],
    };

    for (const update of updates) {
      try {
        const { product_id, stock } = update;

        if (typeof stock !== "number" || stock < 0) {
          results.failed.push({
            product_id,
            reason: "Invalid stock value",
          });
          continue;
        }

        const product = await Product.findOneAndUpdate(
          { _id: product_id, seller_id: req.sellerId },
          { $set: { stock } },
          { new: true, select: "_id name stock" }
        );

        if (!product) {
          results.failed.push({
            product_id,
            reason: "Product not found",
          });
        } else {
          results.success.push({
            product_id: product._id,
            name: product.name,
            stock: product.stock,
          });
        }
      } catch (err) {
        results.failed.push({
          product_id: update.product_id,
          reason: err.message,
        });
      }
    }

    res.json({
      success: true,
      message: `Updated ${results.success.length} products, ${results.failed.length} failed`,
      data: results,
    });
  } catch (error) {
    console.error("Bulk update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to bulk update stock",
      error: error.message,
    });
  }
});

// ============================================================================
// BULK CSV UPLOAD (For Restaurants)
// ============================================================================

// Upload products via CSV
router.post("/products/upload-csv", requireSeller, async (req, res) => {
  try {
    const { products } = req.body; // Array of product objects from CSV

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Products array is required",
      });
    }

    const results = {
      created: [],
      updated: [],
      failed: [],
    };

    for (let i = 0; i < products.length; i++) {
      try {
        const productData = products[i];
        const { name, price, stock, category, description, image } =
          productData;

        // Validation
        if (!name || !price || typeof price !== "number") {
          results.failed.push({
            row: i + 1,
            data: productData,
            reason: "Missing or invalid name/price",
          });
          continue;
        }

        // Check if product exists (by name for same seller)
        const existing = await Product.findOne({
          seller_id: req.sellerId,
          name: name.trim(),
        });

        if (existing) {
          // Update existing product
          existing.price = price;
          existing.stock = stock || 0;
          if (category) existing.category = category;
          if (description) existing.description = description;
          if (image) existing.image = image;

          await existing.save();

          results.updated.push({
            row: i + 1,
            product_id: existing._id,
            name: existing.name,
          });
        } else {
          // Create new product
          const newProduct = new Product({
            seller_id: req.sellerId,
            name: name.trim(),
            price,
            stock: stock || 0,
            category: category || "General",
            description: description || "",
            image: image || "",
            status: "active",
          });

          await newProduct.save();

          results.created.push({
            row: i + 1,
            product_id: newProduct._id,
            name: newProduct.name,
          });
        }
      } catch (err) {
        results.failed.push({
          row: i + 1,
          data: products[i],
          reason: err.message,
        });
      }
    }

    res.json({
      success: true,
      message: `Processed ${products.length} products: ${results.created.length} created, ${results.updated.length} updated, ${results.failed.length} failed`,
      data: results,
    });
  } catch (error) {
    console.error("CSV upload error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to process CSV upload",
      error: error.message,
    });
  }
});

module.exports = router;
