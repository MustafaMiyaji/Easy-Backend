const { Client } = require("../models/models");

// Upsert a client profile by firebase UID (email removed from spec Oct 2025)
// Body: { firebase_uid, name, first_name, last_name, dob, phone }
async function upsertClient(req, res) {
  try {
    // One-time lazy migration: drop legacy email index causing null duplicate conflicts
    // Safe to attempt each request until success; afterward a cached flag prevents re-run.
    if (!global.__CLIENT_EMAIL_INDEX_DROPPED) {
      try {
        const indexes = await Client.collection.indexes();
        const emailIdx = indexes.find((i) =>
          Array.isArray(i.key)
            ? false
            : Object.keys(i.key).length === 1 && i.key.email === 1
        );
        if (emailIdx) {
          await Client.collection.dropIndex("email_1").catch(() => {});
          console.warn("[clientsController] Dropped legacy email_1 index");
        }
        global.__CLIENT_EMAIL_INDEX_DROPPED = true;
      } catch (migrateErr) {
        // Ignore migration failure; will retry next request
      }
    }
    const { firebase_uid, name, first_name, last_name, dob, phone } =
      req.body || {};
    if (!firebase_uid)
      return res.status(400).json({ message: "firebase_uid required" });
    // If this is a brand new profile (no existing doc) require at least one identity field
    const existingDoc = await Client.findOne({ firebase_uid }).lean();
    if (!existingDoc) {
      // Email removed from client logic (2025-10). Only require one of phone/name/first_name on first creation.
      if (!phone && !first_name && !name) {
        return res.status(400).json({
          message: "At least one of phone/name/first_name required",
        });
      }
    }

    // Prevent creating a Client document if this firebase_uid already mapped to a Seller/Admin
    const mongooseModels = require("../models/models");
    const existingPrivileged =
      (await mongooseModels.Admin.findOne({ firebase_uid }).lean()) ||
      (await mongooseModels.Seller.findOne({ firebase_uid }).lean());
    if (existingPrivileged) {
      return res.status(409).json({
        message:
          "UID belongs to a privileged role (seller/admin); skip client upsert",
      });
    }

    // Uniqueness guards (explicit before upsert for clearer 409 response)
    // Email logic removed: clients are now phone/Firebase UID only.
    if (phone) {
      let existingPhone = await Client.findOne({
        phone,
        firebase_uid: { $ne: firebase_uid },
      }).lean();
      if (existingPhone) {
        console.warn(
          `[upsertClient] phone conflict phone=${phone} incomingUID=${firebase_uid} existingUID=${existingPhone.firebase_uid}`
        );
        // Optional adoption logic: allow claiming an unclaimed (no firebase_uid) or sparse legacy record
        const allowClaim = process.env.ALLOW_PHONE_CLAIM === "1";
        if (
          allowClaim &&
          (!existingPhone.firebase_uid ||
            existingPhone.firebase_uid.trim() === "")
        ) {
          console.log(
            `[upsertClient] claiming legacy phone record _id=${existingPhone._id} for uid=${firebase_uid}`
          );
          await Client.updateOne(
            { _id: existingPhone._id },
            { $set: { firebase_uid } }
          );
          existingPhone = await Client.findById(existingPhone._id).lean();
          // Continue (do NOT return conflict); treat as existingDoc for later profile_completed logic
        } else if (
          allowClaim &&
          existingPhone.firebase_uid &&
          existingPhone.profile_completed !== true &&
          existingPhone.first_name == null &&
          existingPhone.last_name == null
        ) {
          // Potential orphaned placeholder profile: allow re-assignment
          console.log(
            `[upsertClient] reassigning orphan phone record from uid=${existingPhone.firebase_uid} to uid=${firebase_uid}`
          );
          await Client.updateOne(
            { _id: existingPhone._id },
            { $set: { firebase_uid } }
          );
          existingPhone = await Client.findById(existingPhone._id).lean();
        } else {
          return res.status(409).json({ message: "phone_in_use" });
        }
      }
    }

    const update = {};
    if (name) update.name = name; // legacy fallback
    if (first_name) update.first_name = first_name;
    if (last_name) update.last_name = last_name;
    if (dob) {
      const parsed = new Date(dob);
      if (!isNaN(parsed.getTime())) update.dob = parsed;
    }
    // Email ignored for clients (2025-10 spec change)
    if (phone) update.phone = phone;
    update.firebase_uid = firebase_uid;
    if (!update.name && update.first_name)
      update.name =
        update.first_name + (update.last_name ? " " + update.last_name : "");
    if (!update.name) update.name = "Anonymous"; // default name
    // Diagnostic: log update payload during development (exclude in production unless DEBUG_UPSERT=1)
    if (process.env.DEBUG_UPSERT === "1") {
      console.log("[upsertClient] update payload", update);
    }
    // Mark profile_completed if core fields present (first_name + phone + dob)
    if (
      update.first_name &&
      (existingDoc?.phone || update.phone) &&
      (update.dob || existingDoc?.dob)
    ) {
      update.profile_completed = true;
    }

    let client;
    try {
      client = await Client.findOneAndUpdate(
        { firebase_uid },
        { $setOnInsert: { created_at: new Date() }, $set: update },
        { upsert: true, new: true }
      ).lean();
    } catch (dbErr) {
      if (dbErr && dbErr.code === 11000) {
        if (dbErr.keyPattern?.phone)
          return res.status(409).json({ message: "phone_in_use" });
        if (dbErr.keyPattern?.email) {
          console.warn(
            "Ignored legacy email unique index conflict for client upsert; fetching existing doc"
          );
          client = await Client.findOne({ firebase_uid }).lean();
        } else {
          throw dbErr;
        }
      } else {
        throw dbErr;
      }
    }

    res.json({
      ok: true,
      client_id: client.firebase_uid, // frontend uses firebase UID as client_id
      profile: {
        name: client.name,
        first_name: client.first_name,
        last_name: client.last_name,
        dob: client.dob,
        // email removed from client surface (legacy kept in DB but not exposed/updated)
        phone: client.phone,
        profile_completed: client.profile_completed,
      },
    });
  } catch (err) {
    console.error("upsertClient error:", err);
    res.status(500).json({ message: err.message || "Failed to upsert client" });
  }
}

// Explicit profile completion endpoint (requires first_name + phone; dob now optional)
async function completeProfile(req, res) {
  try {
    const { firebase_uid, first_name, last_name, dob, /*email,*/ phone } =
      req.body || {};
    if (!firebase_uid)
      return res.status(400).json({ message: "firebase_uid required" });
    if (!first_name)
      return res.status(400).json({ message: "first_name required" });
    if (!phone) return res.status(400).json({ message: "phone required" });
    let parsedDob = null;
    if (dob) {
      parsedDob = new Date(dob);
      if (isNaN(parsedDob.getTime()))
        return res.status(400).json({ message: "dob invalid" });
    }

    const client = await Client.findOneAndUpdate(
      { firebase_uid },
      {
        $set: {
          first_name,
          last_name,
          ...(parsedDob ? { dob: parsedDob } : {}),
          phone,
          // email removed
          name: first_name + (last_name ? " " + last_name : ""),
          profile_completed: true,
        },
        $setOnInsert: { created_at: new Date(), firebase_uid },
      },
      { upsert: true, new: true }
    ).lean();

    res.json({
      client_id: client.firebase_uid,
      profile: {
        name: client.name,
        first_name: client.first_name,
        last_name: client.last_name,
        dob: client.dob,
        // email removed
        phone: client.phone,
        profile_completed: client.profile_completed,
      },
    });
  } catch (e) {
    console.error("completeProfile error", e);
    res.status(500).json({ message: "Failed to complete profile" });
  }
}

module.exports = { upsertClient, completeProfile };
