const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { Seller } = require("../models/models");

// Simple seller auth placeholder similar to seller routes
function requireSeller(req, res, next) {
  const sellerId =
    req.query.sellerId || req.body.seller_id || req.headers["x-seller-id"];
  if (!sellerId || !mongoose.isValidObjectId(sellerId)) {
    return res.status(400).json({ error: "valid sellerId required" });
  }
  req.sellerId = sellerId;
  next();
}

// GET current restaurant profile (seller details)
router.get("/me", requireSeller, async (req, res) => {
  try {
    const seller = await Seller.findById(req.sellerId).lean();
    if (!seller) return res.status(404).json({ error: "seller not found" });
    return res.json(seller);
  } catch (e) {
    console.error("restaurant get error", e);
    res.status(500).json({ error: "failed to fetch" });
  }
});

// Update restaurant details
router.put("/me", requireSeller, async (req, res) => {
  try {
    const allowed = [
      "business_name",
      // allow switching business_type between 'restaurant' and others
      "business_type",
      "address",
      "description",
      "cuisine",
      "logo_url",
      "banner_url",
      "opening_hours",
      "location",
      "place_id",
      "delivery_radius_km",
    ];
    const update = {};
    for (const k of allowed) if (k in req.body) update[k] = req.body[k];
    const seller = await Seller.findOneAndUpdate(
      { _id: req.sellerId },
      { $set: update },
      { new: true }
    ).lean();
    if (!seller) return res.status(404).json({ error: "seller not found" });
    return res.json(seller);
  } catch (e) {
    console.error("restaurant update error", e);
    res.status(500).json({ error: "failed to update" });
  }
});

module.exports = router;
