const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const { Seller } = require("../models/models");

const uri =
  process.env.DB_CONNECTION_STRING || "mongodb://127.0.0.1:27017/easy_app";

async function setRestaurantPassword() {
  try {
    await mongoose.connect(uri);
    console.log("✅ Connected to MongoDB");

    // Set password for spicegarden restaurant
    const email = "restaurant@new.com";
    const password = "restaurant123"; // Default password for testing

    const seller = await Seller.findOne({ email });
    if (!seller) {
      console.log(`❌ No seller found with email: ${email}`);
      process.exit(1);
    }

    console.log(`📝 Setting password for ${email}...`);
    seller.password = password; // Will be hashed by the pre-save hook
    await seller.save();

    console.log(`✅ Password set successfully for ${seller.business_name}`);
    console.log(`   Email: ${email}`);
    console.log(`   Password: ${password}`);
    console.log(`   Business Type: ${seller.business_type}`);
    console.log(`   Approved: ${seller.approved}`);

    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

setRestaurantPassword();
