// Real-time seller status updates via SSE
// Broadcasts when sellers open/close their shops

const clients = new Set(); // All connected clients listening to seller status changes

function addClient(res) {
  clients.add(res);
  res.on("close", () => {
    removeClient(res);
  });
  res.on("error", () => {
    removeClient(res);
  });
}

function removeClient(res) {
  clients.delete(res);
}

function broadcastSellerStatus(sellerId, isOpen) {
  if (clients.size === 0) return;

  const payload = {
    type: "seller_status",
    seller_id: sellerId.toString(),
    is_open: isOpen,
    timestamp: new Date().toISOString(),
  };

  const data = `event: seller_status\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const res of clients) {
    try {
      res.write(data);
    } catch (err) {
      console.error("SSE write error:", err);
      removeClient(res);
    }
  }
}

function getStats() {
  return {
    connectedClients: clients.size,
  };
}

module.exports = {
  addClient,
  removeClient,
  broadcastSellerStatus,
  getStats,
};
