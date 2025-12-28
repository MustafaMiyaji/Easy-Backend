const express = require("express");
const router = express.Router();
const { Order } = require("../models/models");
const {
  buildSnapshot,
  buildEnrichedSnapshot,
} = require("../controllers/ordersController");
const {
  createOrder,
  getStatus,
  verifyPayment,
  getHistory,
  updateDelivery,
} = require("../controllers/ordersController");
const { addClient } = require("../services/orderEvents");
const {
  validate,
  sanitize,
  createOrderSchema,
} = require("../middleware/validation");

// Create new order (COD-only) - with validation
router.post("/", sanitize, validate(createOrderSchema), createOrder);

// Get order status
router.get("/:id/status", getStatus);

// Admin enriched detail: snapshot + earnings/commission breakdown
router.get("/:id/admin-detail", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      Order,
      Product,
      PlatformSettings,
      EarningLog,
    } = require("../models/models");
    const order = await Order.findById(id).lean();
    if (!order) return res.status(404).json({ message: "Order not found" });
    const {
      buildEnrichedSnapshot,
    } = require("../controllers/ordersController");
    const snap = await buildEnrichedSnapshot(order);
    // Commission & earnings (on-demand computation if EarningLog not yet written)
    const settings = await PlatformSettings.findOne(
      {},
      { platform_commission_rate: 1, delivery_agent_share_rate: 1 }
    )
      .lean()
      .catch(() => null);
    const commissionRate = Number(settings?.platform_commission_rate ?? 0.1);
    const agentShareRate = Number(settings?.delivery_agent_share_rate ?? 0.8);
    // Item totals per seller
    const pids = (order.order_items || [])
      .map((oi) => oi.product_id)
      .filter(Boolean);
    let prodMap = new Map();
    if (pids.length) {
      const prods = await Product.find(
        { _id: { $in: pids } },
        { _id: 1, seller_id: 1 }
      ).lean();
      for (const p of prods) prodMap.set(String(p._id), String(p.seller_id));
    }
    const sellerTotals = new Map();
    for (const oi of order.order_items || []) {
      const sid = prodMap.get(String(oi.product_id));
      if (!sid) continue;
      const line = Number(oi.price_snapshot || 0) * Number(oi.qty || 0);
      sellerTotals.set(sid, (sellerTotals.get(sid) || 0) + line);
    }
    const sellers = [];
    for (const [sid, itemTotal] of sellerTotals.entries()) {
      const commission = +(itemTotal * commissionRate).toFixed(2);
      const net = +(itemTotal - commission).toFixed(2);
      sellers.push({
        seller_id: sid,
        item_total: +itemTotal.toFixed(2),
        platform_commission: commission,
        net_earning: net,
      });
    }
    // Prefer delivery charge from enriched snapshot (includes fallback for legacy orders)
    const deliveryCharge = Number(
      snap?.delivery_charge ?? order.delivery?.delivery_charge ?? 0
    );
    let agentNet = null;
    if (order.delivery?.delivery_agent_id && deliveryCharge > 0) {
      agentNet = +(deliveryCharge * agentShareRate).toFixed(2);
    }
    // If EarningLog entries exist (post-delivery) prefer stored values
    try {
      const logs = await EarningLog.find({ order_id: id }).lean();
      if (Array.isArray(logs) && logs.length) {
        const sellersFromLogs = logs
          .filter((l) => l.role === "seller")
          .map((l) => ({
            seller_id: String(l.seller_id),
            item_total: l.item_total,
            platform_commission: l.platform_commission,
            net_earning: l.net_earning,
          }));
        if (sellersFromLogs.length) snap.earnings_sellers = sellersFromLogs;
        const agentLog = logs.find((l) => l.role === "delivery");
        if (agentLog)
          snap.earnings_agent = {
            agent_id: String(agentLog.agent_id),
            delivery_charge: agentLog.delivery_charge,
            net_earning: agentLog.net_earning,
          };
      } else {
        if (sellers.length) snap.earnings_sellers = sellers;
        if (agentNet != null)
          snap.earnings_agent = {
            delivery_charge: deliveryCharge,
            net_earning: agentNet,
          };
      }
    } catch (_) {
      if (sellers.length) snap.earnings_sellers = sellers;
      if (agentNet != null)
        snap.earnings_agent = {
          delivery_charge: deliveryCharge,
          net_earning: agentNet,
        };
    }
    snap.platform_commission_rate = commissionRate;
    snap.delivery_agent_share_rate = agentShareRate;
    return res.json(snap);
  } catch (e) {
    console.error("admin-detail error", e?.message || e);
    res.status(500).json({ message: "Failed to fetch admin detail" });
  }
});

// Admin verifies payment result
router.post("/:id/verify", verifyPayment);

// Order history for a client (recent orders)
router.get("/history/:clientId", getHistory);

// Update delivery status & ETA (temporary open endpoint)
router.patch("/:id/delivery", updateDelivery);

// SSE stream for live order updates
router.get("/:id/stream", async (req, res) => {
  const { id } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(": connected\n\n");

  // Send an initial snapshot immediately so clients don't wait for the next update
  try {
    const order = await Order.findById(id);
    if (order) {
      const snap = await buildEnrichedSnapshot(order);
      const data = `event: update\ndata: ${JSON.stringify(snap)}\n\n`;
      res.write(data);
    }
  } catch (_) {
    // ignore; stream will still deliver future updates
  }
  addClient(id, res);
});

// Cancel order endpoint (COD only, no refunds)
router.post("/:orderId/cancel", async (req, res) => {
  try {
    const { orderId } = req.params;
    const { cancelled_by, cancellation_reason } = req.body;

    if (!cancelled_by) {
      return res.status(400).json({
        error: "cancelled_by is required (user_id or seller_id or agent_id)",
      });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Check if order can be cancelled (not already delivered/cancelled)
    if (order.status === "delivered") {
      return res.status(400).json({ error: "Cannot cancel delivered orders" });
    }

    if (order.status === "cancelled") {
      return res.status(400).json({ error: "Order is already cancelled" });
    }

    // Update order to cancelled
    order.status = "cancelled";
    order.cancelled_by = cancelled_by;
    order.cancellation_reason = cancellation_reason || "No reason provided";
    order.cancelled_at = new Date();

    const savedOrder = await order.save();

    // If order had a delivery agent assigned, free them up
    if (order.delivery?.delivery_agent_id) {
      const { DeliveryAgent } = require("../models/models");
      const agent = await DeliveryAgent.findById(
        order.delivery.delivery_agent_id
      );
      if (agent) {
        agent.available = true;
        agent.assigned_orders = Math.max(0, (agent.assigned_orders || 1) - 1);
        await agent.save();
      }
    }

    // Publish SSE updates to all connected clients (customer, seller, admin, delivery agent)
    try {
      const {
        buildEnrichedSnapshot,
      } = require("../controllers/ordersController");
      const {
        publish,
        publishToSeller,
        publishToAdmin,
      } = require("../services/orderEvents");
      const { notifyOrderUpdate } = require("../services/push");

      const snapshot = await buildEnrichedSnapshot(order);

      // Publish to customer
      publish(String(order._id), snapshot);

      // Publish to seller/restaurant
      if (snapshot.seller_id) {
        publishToSeller(String(snapshot.seller_id), snapshot);
      }

      // Publish to admin dashboard
      publishToAdmin(snapshot);

      // Send push notifications
      await notifyOrderUpdate(
        order.toObject ? order.toObject() : order,
        snapshot
      );

      console.log(
        `Order ${order._id} cancelled - SSE and push notifications sent to customer, seller, and admin`
      );
    } catch (sseError) {
      console.error("Failed to publish cancel event:", sseError);
      // Don't fail the request if SSE/push fails
    }

    res.json({
      message: "Order cancelled successfully",
      order: {
        _id: order._id,
        status: order.status,
        cancelled_by: order.cancelled_by,
        cancellation_reason: order.cancellation_reason,
        cancelled_at: order.cancelled_at,
      },
    });
  } catch (error) {
    console.error("Cancel order error:", error);
    res.status(500).json({ error: "Failed to cancel order" });
  }
});

module.exports = router;
