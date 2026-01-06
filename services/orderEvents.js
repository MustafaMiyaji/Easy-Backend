// In-memory pub-sub for order status events with SSE delivery.
// NOTE: Not production-ready (no clustering, memory leak protections, or auth). For demo / dev usage.
const clients = new Map(); // orderId -> Set(res)
const sellerClients = new Map(); // sellerId -> Set(res)
const adminClients = new Set(); // admin SSE streams

function addClient(orderId, res) {
  if (!clients.has(orderId)) clients.set(orderId, new Set());
  clients.get(orderId).add(res);
  res.on("close", () => {
    removeClient(orderId, res);
  });
  res.on("error", () => {
    removeClient(orderId, res);
  });
}

function removeClient(orderId, res) {
  const set = clients.get(orderId);
  if (set) {
    set.delete(res);
    if (set.size === 0) clients.delete(orderId);
  }
}

function publish(orderId, payload) {
  const set = clients.get(orderId);
  if (!set || set.size === 0) return;
  const data = `event: update\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try {
      res.write(data);
    } catch (_) {
      // On write failure remove client
      removeClient(orderId, res);
    }
  }
  // Also broadcast to admin aggregator
  publishToAdmin(payload);
}

// Seller stream management
function addSellerClient(sellerId, res) {
  if (!sellerClients.has(sellerId)) sellerClients.set(sellerId, new Set());
  sellerClients.get(sellerId).add(res);
  const cleanup = () => {
    const set = sellerClients.get(sellerId);
    if (set) {
      set.delete(res);
      if (set.size === 0) sellerClients.delete(sellerId);
    }
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
}

function publishToSeller(sellerId, payload) {
  const set = sellerClients.get(String(sellerId));
  if (!set || set.size === 0) return;
  // Sanitize payload for seller audience: never expose delivery.otp_code
  const safePayload = (() => {
    try {
      if (!payload) return payload;
      const copy = { ...payload };
      if (copy.delivery) {
        copy.delivery = { ...copy.delivery };
        delete copy.delivery.otp_code;
      }
      return copy;
    } catch (_) {
      return payload;
    }
  })();
  const data = `event: update\ndata: ${JSON.stringify(safePayload)}\n\n`;
  for (const res of set) {
    try {
      res.write(data);
    } catch (_) {
      const s = sellerClients.get(String(sellerId));
      if (s) s.delete(res);
    }
  }
}

// Admin stream management
function addAdminClient(res) {
  adminClients.add(res);
  const cleanup = () => {
    adminClients.delete(res);
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
}

function publishToAdmin(payload) {
  if (adminClients.size === 0) return;
  const data = `event: update\ndata: ${JSON.stringify(payload)}\n\n`;
  const toRemove = [];
  for (const res of adminClients) {
    try {
      res.write(data);
    } catch (_) {
      toRemove.push(res);
    }
  }
  for (const res of toRemove) {
    adminClients.delete(res);
  }
}

function heartbeat() {
  for (const [orderId, set] of clients.entries()) {
    for (const res of set) {
      try {
        res.write(":hb\n\n");
      } catch {
        removeClient(orderId, res);
      }
    }
  }
  for (const [sellerId, set] of sellerClients.entries()) {
    for (const res of set) {
      try {
        res.write(":hb\n\n");
      } catch {
        const s = sellerClients.get(sellerId);
        if (s) s.delete(res);
      }
    }
  }
  for (const res of adminClients) {
    try {
      res.write(":hb\n\n");
    } catch {
      adminClients.delete(res);
    }
  }
}
setInterval(heartbeat, 25000).unref();

module.exports = {
  addClient,
  publish,
  addSellerClient,
  publishToSeller,
  addAdminClient,
  publishToAdmin,
};
