const express = require("express");
const router = express.Router();
const { UserAddress, Client, Order, Feedback } = require("../models/models");

// Middleware to verify user authentication
const requireUser = (req, res, next) => {
  const uid = req.headers.uid || req.headers["x-user-id"];
  if (!uid) {
    return res.status(401).json({ error: "User ID required" });
  }
  req.userId = uid;
  next();
};

// GET /api/users/:uid/addresses - Get all addresses for a user
router.get("/:uid/addresses", async (req, res) => {
  try {
    const { uid } = req.params;
    const addresses = await UserAddress.find({ user_id: uid }).sort({
      created_at: -1,
    });
    res.json({ addresses });
  } catch (error) {
    console.error("Error fetching addresses:", error);
    res.status(500).json({ error: "Failed to fetch addresses" });
  }
});

// POST /api/users/:uid/addresses - Add new address
router.post("/:uid/addresses", async (req, res) => {
  try {
    const { uid } = req.params;
    const addressData = { ...req.body, user_id: uid };

    // If this is marked as default, unset other defaults
    if (addressData.is_default) {
      await UserAddress.updateMany(
        { user_id: uid, is_default: true },
        { is_default: false }
      );
    }

    const address = new UserAddress(addressData);
    await address.save();
    res.status(201).json(address);
  } catch (error) {
    console.error("Error creating address:", error);
    res.status(500).json({ error: "Failed to create address" });
  }
});

// PUT /api/users/:uid/addresses/:addressId - Update address
router.put("/:uid/addresses/:addressId", async (req, res) => {
  try {
    const { uid, addressId } = req.params;
    const updateData = req.body;

    // If this is marked as default, unset other defaults
    if (updateData.is_default) {
      await UserAddress.updateMany(
        { user_id: uid, is_default: true, _id: { $ne: addressId } },
        { is_default: false }
      );
    }

    const address = await UserAddress.findOneAndUpdate(
      { _id: addressId, user_id: uid },
      updateData,
      { new: true }
    );

    if (!address) {
      return res.status(404).json({ error: "Address not found" });
    }

    res.json(address);
  } catch (error) {
    console.error("Error updating address:", error);
    res.status(500).json({ error: "Failed to update address" });
  }
});

// DELETE /api/users/:uid/addresses/:addressId - Delete address
router.delete("/:uid/addresses/:addressId", async (req, res) => {
  try {
    const { uid, addressId } = req.params;
    const address = await UserAddress.findOneAndDelete({
      _id: addressId,
      user_id: uid,
    });

    if (!address) {
      return res.status(404).json({ error: "Address not found" });
    }

    res.json({ message: "Address deleted successfully" });
  } catch (error) {
    console.error("Error deleting address:", error);
    res.status(500).json({ error: "Failed to delete address" });
  }
});

// GET /api/users/:uid/profile - Get user profile
router.get("/:uid/profile", async (req, res) => {
  try {
    const { uid } = req.params;
    const client = await Client.findOne({ firebase_uid: uid });
    if (!client) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json(client);
  } catch (error) {
    console.error("Error fetching profile:", error);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// PUT /api/users/:uid/profile - Update user profile
router.put("/:uid/profile", async (req, res) => {
  try {
    const { uid } = req.params;
    const updateData = req.body;

    const client = await Client.findOneAndUpdate(
      { firebase_uid: uid },
      updateData,
      { new: true, upsert: true }
    );

    res.json(client);
  } catch (error) {
    console.error("Error updating profile:", error);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// PUT /api/users/:uid/preferences - Update notification preferences
router.put("/:uid/preferences", async (req, res) => {
  try {
    const { uid } = req.params;
    const { order_status_notifications } = req.body;

    const client = await Client.findOneAndUpdate(
      { firebase_uid: uid },
      {
        preferences: {
          order_status_notifications: order_status_notifications ?? true,
        },
      },
      { new: true, upsert: true }
    );

    res.json({
      message: "Preferences updated",
      preferences: client.preferences,
    });
  } catch (error) {
    console.error("Error updating preferences:", error);
    res.status(500).json({ error: "Failed to update preferences" });
  }
});

// GET /api/users/:uid/orders - Get user order history
router.get("/:uid/orders", async (req, res) => {
  try {
    const { uid } = req.params;
    const { page = 1, pageSize = 10, status } = req.query;

    const filter = { client_id: uid };
    if (status) filter["payment.status"] = status;

    const skip = (parseInt(page) - 1) * parseInt(pageSize);

    const orders = await Order.find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(parseInt(pageSize))
      .populate("order_items.product_id");

    const total = await Order.countDocuments(filter);

    res.json({
      orders,
      pagination: {
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        total,
        totalPages: Math.ceil(total / parseInt(pageSize)),
      },
    });
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

module.exports = router;

// ---------------- FEEDBACK (User-submitted) ----------------
// POST /api/users/:uid/feedback - Create a feedback/support ticket
router.post("/:uid/feedback", async (req, res) => {
  try {
    const { uid } = req.params;
    const { message, type } = req.body || {};
    if (!message || String(message).trim().length < 3) {
      return res
        .status(400)
        .json({ error: "message is required (min 3 chars)" });
    }
    const doc = await Feedback.create({
      user_id: uid,
      message: String(message).trim(),
      ...(type ? { type } : {}),
    });
    res.status(201).json(doc);
  } catch (error) {
    console.error("Error creating feedback:", error);
    res.status(500).json({ error: "Failed to submit feedback" });
  }
});
