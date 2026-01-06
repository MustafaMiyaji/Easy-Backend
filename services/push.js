const { DeviceToken, Admin, Product } = require("../models/models");

// Send notifications using Firebase Admin SDK (FCM v1). Falls back to skip when admin not initialized.
async function sendToFcm(tokens, payload) {
  // Ensure we have initialized admin (set in app.js)
  const admin = global.firebaseAdmin;
  if (!admin || !admin.messaging) {
    return { skipped: true, reason: "firebase admin not initialized" };
  }
  if (!tokens || tokens.length === 0) return { ok: true, sent: 0 };

  // FCM v1 requires data values to be strings.
  const data = {};
  if (payload.data) {
    for (const [k, v] of Object.entries(payload.data)) {
      data[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
  }

  // Build base notification
  const baseNotification = payload.notification || {};
  // Decide channel based on intent: offer / alert style messages should use the
  // loud custom-sound channel. We versioned the alerts channel to ensure custom
  // sound availability. Fallback to provided channel override.
  let channelId =
    data.android_channel_id ||
    baseNotification.android_channel_id ||
    "orders_updates";
  const isAlertLike =
    data.is_offer === "true" ||
    data.order_alert === "true" ||
    data.type === "ORDER_ALERT";
  if (isAlertLike) {
    channelId = "orders_alerts_v2"; // new channel with custom sound
  }

  // Chunk tokens to max 500 per multicast request
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 500) {
    chunks.push(tokens.slice(i, i + 500));
  }

  let successCount = 0;
  let failureCount = 0;
  const results = [];

  for (const chunk of chunks) {
    const message = {
      tokens: chunk,
      notification: {
        title: baseNotification.title,
        body: baseNotification.body,
      },
      data,
      android: {
        priority: "high",
        notification: {
          channelId,
          clickAction: "FLUTTER_NOTIFICATION_CLICK",
          // Use custom sound for alert channel; default otherwise.
          sound: channelId === "orders_alerts_v2" ? "order_alarm" : "default",
        },
      },
    };
    try {
      const resp = await admin.messaging().sendEachForMulticast(message);
      successCount += resp.successCount || 0;
      failureCount += resp.failureCount || 0;
      results.push(resp);
    } catch (err) {
      results.push({ error: err.message || String(err) });
    }
  }

  return { ok: true, sent: successCount, failed: failureCount, results };
}

function computeKinds(order, snapshot) {
  try {
    const kinds = new Set();
    const items = order?.order_items || snapshot?.order_items || [];
    for (const it of items) {
      const cat = it?.product_id?.category || it?.category;
      const k = (cat || "").toString().toLowerCase();
      if (!k) continue;
      if (k.includes("vegetable")) kinds.add("vegetables");
      else if (k.includes("grocery")) kinds.add("grocery");
      else if (k.includes("restaurant") || k.includes("food"))
        kinds.add("food");
    }
    if (!kinds.size) {
      const bt = order?.seller_id?.business_type?.toString().toLowerCase();
      if (bt) {
        if (bt.includes("grocery")) kinds.add("grocery");
        else if (bt.includes("restaurant") || bt.includes("food"))
          kinds.add("food");
      }
    }
    return Array.from(kinds);
  } catch (_) {
    return [];
  }
}

async function notifyOrderUpdate(order, snapshot, opts = {}) {
  try {
    const exclude = new Set(
      Array.isArray(opts.excludeRoles) ? opts.excludeRoles.map(String) : []
    );
    // Collect tokens per role for customized notifications
    const clientTokens = new Set();
    const sellerTokens = new Set();
    const agentTokens = new Set();
    const adminTokens = new Set();

    // Resolve client tokens robustly: client_id may be a string (firebase uid) or an embedded object
    try {
      const clientIds = new Set();
      const addId = (v) => {
        if (!v) return;
        const s = String(v).trim();
        if (s && s !== "[object Object]") clientIds.add(s);
      };
      const fromObj = (obj) => {
        if (!obj || typeof obj !== "object") return;
        addId(obj.firebase_uid);
        addId(obj._id);
        addId(obj.id);
        addId(obj.user_id);
        addId(obj.uid);
        // sometimes email/phone based ids aren't used for tokens; skip here
      };
      addId(order.client_id);
      fromObj(order.client_id);
      addId(snapshot.client_id);
      fromObj(snapshot.client);
      // Query tokens for any resolved ids
      if (clientIds.size) {
        const rows = await DeviceToken.find({
          user_id: { $in: Array.from(clientIds) },
        }).lean();
        for (const t of rows) clientTokens.add(t.token);
      }
    } catch (_) {}
    if (order.seller_id) {
      const rows = await DeviceToken.find({
        user_id: String(order.seller_id),
      }).lean();
      for (const t of rows) sellerTokens.add(t.token);
    }
    // Include product owners (sellers) for each item (some orders have split sellers)
    try {
      const pids = (order.order_items || [])
        .map((oi) => oi.product_id)
        .filter(Boolean);
      if (pids.length > 0) {
        const prods = await Product.find(
          { _id: { $in: pids } },
          { seller_id: 1 }
        ).lean();
        const sellerIds = [...new Set(prods.map((p) => String(p.seller_id)))];
        if (sellerIds.length > 0) {
          const perItemSellerTokens = await DeviceToken.find({
            user_id: { $in: sellerIds },
          }).lean();
          for (const t of perItemSellerTokens) sellerTokens.add(t.token);
        }
      }
    } catch (e) {
      console.warn("seller per-item tokens fetch failed", e.message);
    }
    // Include delivery agent notifications when assigned/updated
    if (order.delivery && order.delivery.delivery_agent_id) {
      const rows = await DeviceToken.find({
        user_id: String(order.delivery.delivery_agent_id),
      }).lean();
      for (const t of rows) agentTokens.add(t.token);
    }
    // Broadcast to all admins (device tokens saved under admin firebase_uid or internal id)
    try {
      const admins = await Admin.find({}).lean();
      const adminIds = admins
        .map((a) => a.firebase_uid || a._id)
        .filter(Boolean)
        .map(String);
      if (adminIds.length > 0) {
        const rows = await DeviceToken.find({
          user_id: { $in: adminIds },
        }).lean();
        for (const t of rows) adminTokens.add(t.token);
      }
    } catch (e) {
      console.warn("admin tokens fetch failed", e.message);
    }
    // Prepare role-aware title/body
    const kinds = computeKinds(order, snapshot);
    const kindsText = kinds.length ? ` (${kinds.join(", ")})` : "";
    const shortId = String(order._id).slice(-6);
    const dStatus = (
      snapshot.delivery?.status ||
      snapshot.delivery_status ||
      snapshot.status ||
      ""
    ).toString();
    const pStatus = (
      snapshot.payment?.status ||
      order.payment?.status ||
      ""
    ).toString();

    // Extract cancellation reason (if any)
    const cancelReason =
      snapshot?.delivery?.cancellation_reason ||
      order?.delivery?.cancellation_reason ||
      null;
    const cancelledBy =
      snapshot?.delivery?.cancelled_by || order?.delivery?.cancelled_by || null;

    const baseTitle = `Order ${shortId} ${dStatus || "update"}`;
    const clientTitle = `Your order ${shortId}${kindsText}`;
    const clientBody = dStatus
      ? dStatus === "assigned"
        ? `A delivery agent has been assigned${kindsText}`
        : dStatus === "picked_up"
        ? `Picked up by agent${kindsText}`
        : dStatus === "in_transit"
        ? `On the way to you${kindsText}`
        : dStatus === "cancelled"
        ? cancelReason
          ? `Order cancelled${
              cancelledBy ? ` by ${cancelledBy}` : ""
            }: ${cancelReason}`
          : `Order cancelled${cancelledBy ? ` by ${cancelledBy}` : ""}`
        : `Status: ${dStatus}${kindsText}`
      : `Payment ${pStatus}`;

    const sellerTitle = `New order ${shortId}`;
    const itemCount = (order.order_items || []).reduce(
      (s, it) => s + Number(it?.qty || 0),
      0
    );
    const amount = order.payment?.amount || snapshot.payment?.amount;
    const sellerBody = `Items: ${itemCount} • Amount: ₹${Number(
      amount || 0
    ).toFixed(2)}`;

    const agentTitle = `Offer ${shortId}`;
    const agentBody = `Pickup: ${
      snapshot.seller?.business_name || snapshot.seller_name || "Store"
    } • To: ${
      snapshot.delivery?.delivery_address?.recipient_name || "Customer"
    }`;

    // Helper to send one multicast with role-specific title/body
    const dataCommon = {
      order_id: String(order._id),
      status: snapshot.status,
      delivery_status: snapshot.delivery?.status || "pending",
      type: "order_update",
      kinds: JSON.stringify(kinds),
      cancellation_reason: cancelReason || "",
      cancelled_by: cancelledBy || "",
      client_title: clientTitle,
      client_body: clientBody,
      seller_title: sellerTitle,
      seller_body: sellerBody,
      agent_title: agentTitle,
      agent_body: agentBody,
      click_action: "FLUTTER_NOTIFICATION_CLICK",
      android_channel_id: "orders_updates",
      priority: "high",
    };

    const results = [];
    if (clientTokens.size && !exclude.has("client")) {
      results.push(
        await sendToFcm(Array.from(clientTokens), {
          notification: {
            title: clientTitle,
            body: clientBody,
            android_channel_id: "orders_updates",
            sound: "default",
          },
          data: { ...dataCommon, route: "/order-tracking", audience: "client" },
        })
      );
    }
    if (sellerTokens.size && !exclude.has("seller")) {
      // Enrich seller body with first two item names + qty when available
      try {
        const items = (order.order_items || []).slice(0, 2).map((it) => {
          const name = it?.product_id?.name || it?.name || "Item";
          const qty = Number(it?.qty || 0);
          return `${name}×${qty}`;
        });
        const extra = items.length ? ` • ${items.join(", ")}` : "";
        results.push(
          await sendToFcm(Array.from(sellerTokens), {
            notification: {
              title: sellerTitle,
              body: sellerBody + extra,
              android_channel_id: "orders_updates",
              sound: "default",
            },
            data: { ...dataCommon, route: "/seller-order", audience: "seller" },
          })
        );
      } catch (_) {
        results.push(
          await sendToFcm(Array.from(sellerTokens), {
            notification: {
              title: sellerTitle,
              body: sellerBody,
              android_channel_id: "orders_updates",
              sound: "default",
            },
            data: { ...dataCommon, route: "/seller-order", audience: "seller" },
          })
        );
      }
    }
    if (
      agentTokens.size &&
      !exclude.has("agent") &&
      !exclude.has("delivery") &&
      !exclude.has("delivery_agent")
    ) {
      const agentBodyFull = `${agentBody} • Items: ${itemCount} • Amount: ₹${Number(
        amount || 0
      ).toFixed(2)}`;
      results.push(
        await sendToFcm(Array.from(agentTokens), {
          notification: {
            title: agentTitle,
            body: agentBodyFull,
            android_channel_id: "orders_alerts",
            sound: "default",
          },
          data: {
            ...dataCommon,
            is_offer: "true",
            android_channel_id: "orders_alerts",
            route: "/agent-offer",
            audience: "agent",
          },
        })
      );
    }
    if (adminTokens.size && !exclude.has("admin")) {
      const adminTitle = baseTitle;
      const adminBody = `Payment ${pStatus || "pending"}; Delivery ${
        dStatus || "pending"
      }`;
      results.push(
        await sendToFcm(Array.from(adminTokens), {
          notification: {
            title: adminTitle,
            body: adminBody,
            android_channel_id: "orders_updates",
            sound: "default",
          },
          data: { ...dataCommon, route: "/admin-dashboard", audience: "admin" },
        })
      );
    }

    // Summarize
    const summary = { ok: true, results };
    return summary;
  } catch (e) {
    console.warn("notifyOrderUpdate error", e.message);
    return { error: e.message };
  }
}

module.exports = { notifyOrderUpdate };
