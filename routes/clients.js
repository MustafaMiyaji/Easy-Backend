const express = require("express");
const router = express.Router();
const {
  upsertClient,
  completeProfile,
} = require("../controllers/clientsController");
const { Client } = require("../models/models");

// Upsert (create/update) client profile by firebase UID
router.post("/upsert", upsertClient);
router.post("/complete-profile", completeProfile);

// Get user profile by firebase UID
router.get("/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid) return res.status(400).json({ message: "uid required" });
    const client = await Client.findOne({ firebase_uid: uid }).lean();
    if (!client) return res.status(404).json({ message: "not found" });
    return res.json({
      name: client.name,
      firebase_uid: client.firebase_uid,
    });
  } catch (e) {
    console.error("fetch profile error", e);
    res.status(500).json({ message: "failed to fetch profile" });
  }
});

// Update user profile by firebase UID
router.put("/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    const { name, /*email,*/ phone, avatar_url } = req.body || {};
    if (!uid) return res.status(400).json({ message: "uid required" });
    const update = {};
    if (name) update.name = name;
    // email ignored
    if (phone) update.phone = phone;
    if (avatar_url) update.avatar_url = avatar_url;
    let client = await Client.findOneAndUpdate(
      { firebase_uid: uid },
      { $set: update },
      { new: true }
    ).lean();
    if (!client) {
      client = await Client.findOneAndUpdate(
        { firebase_uid: uid },
        {},
        { upsert: true, new: true }
      ).lean();
    }
    return res.json({
      name: client.name,
      phone: client.phone,
      avatar_url: client.avatar_url,
      firebase_uid: client.firebase_uid,
    });
  } catch (e) {
    console.error("update profile error", e);
    res.status(500).json({ message: "failed to update profile" });
  }
});

module.exports = router;
