const mongoose = require("mongoose");
const { Schema } = mongoose;
const bcrypt = require("bcryptjs");

// Corresponds to the 'Admin' table
const adminSchema = new Schema({
  email: {
    type: String,
    required: [true, "Email is required"],
    unique: true,
    lowercase: true,
    trim: true,
    validate: {
      validator: function (v) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
      },
      message: "Please provide a valid email address",
    },
  },
  role: {
    type: String,
    enum: {
      values: ["superadmin", "moderator"],
      message: "Role must be either superadmin or moderator",
    },
    required: [true, "Role is required"],
  },
  // Hashed password (bcrypt)
  password: {
    type: String,
    minlength: [6, "Password must be at least 6 characters long"],
  },
  // Optional link to Firebase Auth UID for admin login mapping
  firebase_uid: { type: String, unique: true, sparse: true },
  created_at: { type: Date, default: Date.now },
  // Password reset fields
  resetPasswordToken: { type: String },
  resetPasswordExpires: { type: Date },
});

adminSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (e) {
    next(e);
  }
});

adminSchema.methods.comparePassword = async function (candidate) {
  if (!this.password) return false;
  return bcrypt.compare(candidate, this.password);
};

// Corresponds to the 'Client' table
const clientSchema = new Schema({
  // Legacy single name retained for backwards compatibility; new first/last fields below drive profile completion.
  name: { type: String },
  first_name: { type: String },
  last_name: { type: String },
  dob: { type: Date },
  phone: { type: String }, // primary identifier besides firebase_uid (email removed Oct 2025)
  // email removed from active client profile spec; legacy documents may still have this field but it's no longer enforced/updated
  // Keep field absence: do NOT declare email so Mongoose won't enforce validation; existing data remains in MongoDB.
  // Optional link to Firebase Auth UID for profile enrichment / mapping
  firebase_uid: { type: String, unique: true, sparse: true },
  // Optional profile image URL
  avatar_url: { type: String },
  otp_verified: { type: Boolean, default: false },
  profile_completed: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
});

// Corresponds to the 'Seller' table
const sellerSchema = new Schema({
  business_name: {
    type: String,
    required: [true, "Business name is required"],
    trim: true,
    minlength: [2, "Business name must be at least 2 characters long"],
    maxlength: [100, "Business name cannot exceed 100 characters"],
  },
  email: {
    type: String,
    required: [true, "Email is required"],
    lowercase: true,
    trim: true,
    validate: {
      validator: function (v) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
      },
      message: "Please provide a valid email address",
    },
  },
  phone: {
    type: String,
    required: [true, "Phone number is required"],
    trim: true,
    validate: {
      validator: function (v) {
        return /^[\d\s\-\+\(\)]+$/.test(v) && v.replace(/\D/g, "").length >= 10;
      },
      message: "Please provide a valid phone number (minimum 10 digits)",
    },
  },
  business_type: {
    type: String,
    enum: {
      values: ["restaurant", "grocery", "pharmacy", "other"],
      message: "Business type must be restaurant, grocery, pharmacy, or other",
    },
  },
  // Optional link to Firebase Auth UID for mapping
  firebase_uid: { type: String, unique: true, sparse: true },
  approved: { type: Boolean, default: false },
  // Open / closed (active) toggle exposed to dashboards
  is_open: { type: Boolean, default: false },
  // Optional password for admin-created accounts (hashed)
  password: { type: String },
  // Restaurant details (optional)
  address: { type: String },
  cuisine: { type: String },
  logo_url: { type: String },
  banner_url: { type: String },
  opening_hours: { type: String }, // simple text or JSON string
  // Short description/about for restaurant profile
  description: { type: String },
  location: {
    lat: {
      type: Number,
      min: [-90, "Latitude must be between -90 and 90"],
      max: [90, "Latitude must be between -90 and 90"],
    },
    lng: {
      type: Number,
      min: [-180, "Longitude must be between -180 and 180"],
      max: [180, "Longitude must be between -180 and 180"],
    },
  },
  // Google Place ID (for precise geocoding & details)
  place_id: { type: String },
  delivery_radius_km: {
    type: Number,
    default: 5,
    min: [0, "Delivery radius cannot be negative"],
    max: [100, "Delivery radius cannot exceed 100 km"],
  },
  created_at: { type: Date, default: Date.now },
  // Password reset fields
  resetPasswordToken: { type: String },
  resetPasswordExpires: { type: Date },
});

// Performance indexes for seller queries
// 1. Find approved sellers by business type
sellerSchema.index({ approved: 1, business_type: 1 });

// 2. Geospatial index for finding nearby sellers
sellerSchema.index({ location: "2dsphere" });

// 3. Firebase UID lookup
// NOTE: Do NOT add a separate schema.index here because the path-level
// unique:true,sparse:true on firebase_uid already creates the necessary index.
// Defining both causes Mongoose duplicate index warnings.

sellerSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (e) {
    next(e);
  }
});

sellerSchema.methods.comparePassword = async function (candidate) {
  if (!this.password) return false;
  return bcrypt.compare(candidate, this.password);
};

// Corresponds to the 'Product' table
const productSchema = new Schema({
  seller_id: {
    type: Schema.Types.ObjectId,
    ref: "Seller",
    required: [true, "Seller ID is required"],
  },
  name: {
    type: String,
    required: [true, "Product name is required"],
    trim: true,
    minlength: [2, "Product name must be at least 2 characters long"],
    maxlength: [200, "Product name cannot exceed 200 characters"],
  },
  category: {
    type: String,
    trim: true,
  }, // e.g., Grocery, Restaurant, Vegetables
  price: {
    type: Number,
    required: [true, "Price is required"],
    min: [0, "Price cannot be negative"],
  },
  stock: {
    type: Number,
    default: 100,
    min: [0, "Stock cannot be negative"],
  },
  image: { type: String }, // optional image URL
  description: {
    type: String,
    maxlength: [1000, "Description cannot exceed 1000 characters"],
  },
  status: {
    type: String,
    enum: {
      values: ["active", "inactive"],
      message: "Status must be either active or inactive",
    },
    default: "active",
  },
  created_at: { type: Date, default: Date.now },
});

// Performance indexes for product queries
// 1. Products by seller (for seller product management)
productSchema.index({ seller_id: 1, created_at: -1 });

// 2. Active products by category (for client browsing)
productSchema.index({ category: 1, status: 1 });

// 3. Text search on product name and description (for search functionality)
productSchema.index({ name: "text", description: "text" });

// 4. Stock level monitoring (for low stock alerts)
productSchema.index({ stock: 1, status: 1 });

// Corresponds to the 'Catalog' table
const catalogSchema = new Schema({
  seller_id: {
    type: Schema.Types.ObjectId,
    ref: "Seller",
    required: true,
    unique: true,
  },
  min_products_required: { type: Number, default: 0 },
  published: { type: Boolean, default: false },
});

// Corresponds to 'Orolog', 'OrderItem', 'Payment', and 'Delivery' tables combined
const orderSchema = new Schema({
  // Store Firebase Auth UID (string) directly as client identifier.
  // If later a separate Client collection mapping is needed, we can add client_ref ObjectId.
  client_id: { type: String, required: true }, // Removed index: true to avoid duplicate with compound index
  seller_id: { type: Schema.Types.ObjectId, ref: "Seller" },
  catalog_id: { type: Schema.Types.ObjectId, ref: "Catalog" }, // from Orolog
  published: { type: Boolean, default: true }, // from Orolog

  // Main order status (root level - most authoritative)
  status: {
    type: String,
    enum: [
      "pending",
      "confirmed",
      "processing",
      "cancelled",
      "delivered",
      "refunded",
    ],
    default: "pending",
  },

  // Cancellation metadata (root level for easy querying)
  cancelled_by: { type: String }, // 'customer', 'seller', 'admin', 'system', 'delivery_agent'
  cancellation_reason: { type: String },
  cancelled_at: { type: Date },

  order_items: [
    {
      // from OrderItem
      product_id: { type: Schema.Types.ObjectId, ref: "Product" },
      qty: { type: Number, required: true },
      // Best practice: snapshot price and name for historical accuracy
      price_snapshot: Number,
      name_snapshot: String,
    },
  ],

  payment: {
    // from Payment
    amount: { type: Number, required: true },
    method: {
      type: String,
      // Keep legacy values in enum to avoid validation failures on existing documents.
      enum: ["COD", "UPI", "razorpay", "card"],
      default: "COD",
    },
    status: {
      type: String,
      enum: [
        "pending", // order created, awaiting user action
        "claimed", // user claimed paid (provided UTR/response)
        "paid", // verified paid
        "failed",
        "cancelled",
        "expired",
      ],
      default: "pending",
    },
    payment_date: { type: Date },

    // UPI-specific fields removed for COD-only flow

    // Verification details (who/when finalized)
    verified: {
      by: String, // identifier for admin/verifier
      note: String,
      at: { type: Date },
    },
  },

  // Optional coupon code applied at checkout (used to recompute discount in snapshots)
  coupon_code: { type: String },
  // Persisted absolute discount amount allocated to this order (positive number). Applied once at creation for immutable accounting.
  applied_discount_amount: { type: Number, default: 0 },

  delivery: {
    // from Delivery
    delivery_status: {
      type: String,
      enum: [
        "pending",
        "dispatched",
        "assigned",
        "accepted",
        "picked_up",
        "in_transit",
        "delivered",
        "cancelled",
        "escalated", // Added: When order cannot be assigned after max retry attempts
      ],
      default: "pending",
    },
    // Escalation metadata (when no agents available after multiple retries)
    escalated_at: { type: Date },
    escalation_reason: { type: String },
    delivery_agent_id: { type: Schema.Types.ObjectId, ref: "DeliveryAgent" },
    delivery_agent_response: {
      type: String,
      enum: ["pending", "accepted", "rejected", "timeout"],
      default: "pending",
    },
    assignment_history: [
      {
        agent_id: { type: Schema.Types.ObjectId, ref: "DeliveryAgent" },
        assigned_at: { type: Date, default: Date.now },
        response: {
          type: String,
          enum: ["pending", "accepted", "rejected", "timeout"],
        },
        response_at: { type: Date },
      },
    ],
    delivery_start_time: { type: Date },
    delivery_end_time: { type: Date },
    pickup_time: { type: Date },
    estimated_delivery_time: { type: Date },

    // Agent's location when accepting the order
    accept_location: {
      lat: { type: Number },
      lng: { type: Number },
    },

    // Pickup address (seller/store location) for route tracking
    pickup_address: {
      full_address: { type: String },
      location: {
        lat: { type: Number },
        lng: { type: Number },
      },
    },

    // In-app delivery confirmation OTP
    otp_code: { type: String }, // 4-6 digit code generated when order goes out for delivery
    otp_verified: { type: Boolean, default: false },
    otp_verified_at: { type: Date },

    // Delivery Address Information
    delivery_address: {
      address_id: { type: Schema.Types.ObjectId, ref: "UserAddress" },
      full_address: { type: String, required: true },
      recipient_name: { type: String },
      recipient_phone: { type: String },
      location: {
        lat: { type: Number },
        lng: { type: Number },
      },
    },
    // Per-order delivery charge (in currency units, e.g., INR)
    delivery_charge: { type: Number, default: 0 },
    // Flag indicating if admin compensates agent for this delivery (when delivery appears free to customer)
    admin_pays_agent: { type: Boolean, default: false },
    // Amount admin pays to agent for "free" deliveries (overrides delivery_charge for agent earnings)
    admin_agent_payment: { type: Number, default: 0 },
    // Cancellation metadata (when order is cancelled/rejected)
    cancellation_reason: { type: String },
    cancelled_by: { type: String }, // e.g., 'seller', 'client', 'admin', 'system', 'delivery_agent'
    cancelled_at: { type: Date },
  },

  // Optional: auto-expire pending orders
  expires_at: { type: Date },
  created_at: { type: Date, default: Date.now },
});

// Performance indexes for common queries
// 1. Efficient retrieval of recent orders per client
orderSchema.index({ client_id: 1, created_at: -1 });

// 2. Orders by seller (for seller dashboard, recent first)
orderSchema.index({ "items.seller_id": 1, created_at: -1 });

// 3. Orders by delivery status (for delivery management queries)
orderSchema.index({ "delivery.delivery_status": 1, created_at: -1 });

// 4. Orders by payment status (for payment reconciliation)
orderSchema.index({ payment_status: 1, created_at: -1 });

// 5. Delivery agent assignment queries (find orders assigned to agent)
orderSchema.index({
  "delivery.delivery_agent_id": 1,
  "delivery.delivery_status": 1,
});

// 6. Escalated orders (for admin monitoring)
orderSchema.index({ "delivery.escalated_at": 1 }, { sparse: true });

// User Addresses
const userAddressSchema = new Schema({
  user_id: { type: String, required: true }, // Removed index: true to avoid duplicate with compound index
  label: { type: String }, // "Home", "Office", "Other"
  full_address: { type: String, required: true },
  street: { type: String },
  city: { type: String },
  state: { type: String },
  pincode: { type: String },
  landmark: { type: String },
  recipient_name: { type: String },
  recipient_phone: { type: String },
  is_default: { type: Boolean, default: false },
  location: {
    lat: { type: Number },
    lng: { type: Number },
  },
  // Google Place ID (if captured from Places Autocomplete / Map Picker)
  place_id: { type: String },
  created_at: { type: Date, default: Date.now },
});
// Compound index for efficient user address queries - only defined once
userAddressSchema.index({ user_id: 1, created_at: -1 });

// User Cart (simple full replace model)
const cartSchema = new Schema({
  user_id: { type: String, required: true, unique: true },
  items: [
    {
      product_id: { type: String, required: true },
      name: String,
      price: Number,
      qty: { type: Number, required: true },
      seller_id: String,
    },
  ],
  updated_at: { type: Date, default: Date.now },
});
cartSchema.pre("save", function (next) {
  this.updated_at = new Date();
  next();
});

// Device tokens for push notifications (FCM)
const deviceTokenSchema = new Schema({
  user_id: { type: String, required: true }, // firebase uid or seller/admin id as string - removed index: true to avoid duplicate with compound index
  token: { type: String, required: true },
  platform: { type: String }, // android/ios/web
  last_seen: { type: Date, default: Date.now },
});
deviceTokenSchema.index({ user_id: 1, token: 1 }, { unique: true }); // This covers user_id indexing

// Delivery agents (enhanced with Firebase auth and approval workflow)
const deliveryAgentSchema = new Schema({
  name: {
    type: String,
    required: [true, "Name is required"],
    trim: true,
    minlength: [2, "Name must be at least 2 characters long"],
    maxlength: [100, "Name cannot exceed 100 characters"],
  },
  email: {
    type: String,
    required: [true, "Email is required"],
    unique: true,
    lowercase: true,
    trim: true,
    validate: {
      validator: function (v) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
      },
      message: "Please provide a valid email address",
    },
  },
  phone: {
    type: String,
    required: [true, "Phone number is required"],
    trim: true,
    validate: {
      validator: function (v) {
        return /^[\d\s\-\+\(\)]+$/.test(v) && v.replace(/\D/g, "").length >= 10;
      },
      message: "Please provide a valid phone number (minimum 10 digits)",
    },
  },
  firebase_uid: { type: String, unique: true, sparse: true },
  approved: { type: Boolean, default: false }, // Requires admin approval
  active: { type: Boolean, default: true }, // Online/offline status
  available: { type: Boolean, default: true }, // Available for new orders
  assigned_orders: {
    type: Number,
    default: 0,
    min: [0, "Assigned orders cannot be negative"],
  },
  completed_orders: {
    type: Number,
    default: 0,
    min: [0, "Completed orders cannot be negative"],
  },
  rating: {
    type: Number,
    default: 0,
    min: [0, "Rating cannot be negative"],
    max: [5, "Rating cannot exceed 5"],
  },
  total_ratings: {
    type: Number,
    default: 0,
    min: [0, "Total ratings cannot be negative"],
  },
  vehicle_type: {
    type: String,
    enum: {
      values: ["bike", "scooter", "bicycle", "car"],
      message: "Vehicle type must be bike, scooter, bicycle, or car",
    },
    default: "bike",
  },
  license_number: { type: String },
  current_location: {
    lat: {
      type: Number,
      min: [-90, "Latitude must be between -90 and 90"],
      max: [90, "Latitude must be between -90 and 90"],
    },
    lng: {
      type: Number,
      min: [-180, "Longitude must be between -180 and 180"],
      max: [180, "Longitude must be between -180 and 180"],
    },
    updated_at: { type: Date, default: Date.now },
  },
  working_hours: {
    start: { type: String, default: "09:00" }, // HH:MM format
    end: { type: String, default: "21:00" },
  },
  created_at: { type: Date, default: Date.now },
  // Password reset fields
  resetPasswordToken: { type: String },
  resetPasswordExpires: { type: Date },
});

// Performance indexes for delivery agent queries
// 1. Find available agents for assignment (approved, active, available)
deliveryAgentSchema.index({ approved: 1, active: 1, available: 1 });

// 2. Agent performance tracking (for admin reports)
deliveryAgentSchema.index({ completed_orders: -1, rating: -1 });

// NOTE: 2dsphere index removed - current_location uses {lat, lng, updated_at} format
// which conflicts with GeoJSON requirement. To add geospatial queries later,
// refactor current_location to proper GeoJSON: {type: "Point", coordinates: [lng, lat]}

// Notification / marketing campaign (very lightweight)
const notificationCampaignSchema = new Schema({
  title: { type: String, required: true },
  message: { type: String, required: true },
  segment: {
    type: String,
    enum: ["all", "clients", "sellers"],
    default: "all",
  },
  scheduled_at: { type: Date },
  status: {
    type: String,
    enum: ["draft", "scheduled", "sent", "canceled"],
    default: "draft",
  },
  created_at: { type: Date, default: Date.now },
});
notificationCampaignSchema.index({ status: 1, scheduled_at: 1 });

// Customer feedback / support ticket
const feedbackSchema = new Schema({
  user_id: { type: String, required: true },
  type: {
    type: String,
    enum: ["bug", "feature", "complaint", "other"],
    default: "other",
  },
  message: { type: String, required: true },
  status: {
    type: String,
    enum: ["open", "in_progress", "resolved", "closed"],
    default: "open",
  },
  resolution_note: { type: String },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});
feedbackSchema.pre("save", function (next) {
  this.updated_at = new Date();
  next();
});

// Platform-wide settings managed by admins
const platformSettingsSchema = new Schema({
  currency_symbol: { type: String, default: "₹" },
  locale: { type: String, default: "en_IN" },
  low_stock_threshold: { type: Number, default: 5 },
  order_status_notifications: { type: Boolean, default: true },
  // Delivery charge configuration (flat for now, per group)
  delivery_charge_grocery: { type: Number, default: 30 },
  delivery_charge_food: { type: Number, default: 40 },
  // Minimum subtotal required per group to waive delivery charge
  // If group subtotal >= this threshold, delivery charge for that group becomes 0
  min_total_for_delivery_charge: { type: Number, default: 100 },
  // Admin-paid delivery compensation settings
  // When true, admin compensates delivery agents for "free" deliveries (orders above threshold)
  free_delivery_admin_compensation: { type: Boolean, default: false },
  // Amount admin pays to delivery agent when delivery appears free to customer
  free_delivery_agent_payment: { type: Number, default: 0 },
  // Coupons (admin-managed)
  coupons: [
    new Schema(
      {
        code: { type: String, required: true },
        percent: { type: Number, required: true, min: 0, max: 100 },
        active: { type: Boolean, default: true },
        minSubtotal: { type: Number, default: 0 },
        // Optional category scoping for coupon applicability. Allowed values: 'grocery', 'vegetable', 'food'.
        categories: [
          {
            type: String,
            lowercase: true,
            enum: ["grocery", "vegetable", "food"],
          },
        ],
        validFrom: { type: Date },
        validTo: { type: Date },
        // Usage tracking fields
        usage_count: { type: Number, default: 0 }, // Total times this coupon has been used
        usage_limit: { type: Number, default: null }, // Max total uses (null = unlimited)
        max_uses_per_user: { type: Number, default: 1 }, // Max uses per individual user
        used_by: [
          {
            client_id: { type: String, required: true },
            usage_count: { type: Number, default: 1 },
            last_used: { type: Date, default: Date.now },
          },
        ],
        created_at: { type: Date, default: Date.now },
        updated_at: { type: Date, default: Date.now },
      },
      { _id: false }
    ),
  ],
  // Platform commission and delivery earnings split
  // Commission rate applied on item totals (exclude delivery charge). Example: 0.1 => 10%
  platform_commission_rate: { type: Number, default: 0.1 },
  // Portion of delivery charge that goes to delivery agent. Example: 0.8 => 80%
  delivery_agent_share_rate: { type: Number, default: 0.8 },
  updated_at: { type: Date, default: Date.now },
});

// Earnings log for payouts/accounting
const earningLogSchema = new Schema({
  role: { type: String, enum: ["seller", "delivery"], required: true },
  order_id: { type: Schema.Types.ObjectId, ref: "Order", required: true },
  seller_id: { type: Schema.Types.ObjectId, ref: "Seller" },
  agent_id: { type: Schema.Types.ObjectId, ref: "DeliveryAgent" },
  // monetary fields
  item_total: { type: Number, default: 0 }, // sum of products for this role scope
  delivery_charge: { type: Number, default: 0 },
  platform_commission: { type: Number, default: 0 },
  net_earning: { type: Number, default: 0 }, // for seller: item_total - commission; for agent: delivery_share
  meta: { type: Object },
  paid: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
});
earningLogSchema.index(
  { order_id: 1, role: 1, seller_id: 1, agent_id: 1 },
  { unique: true, sparse: true }
);

// Automated alert records (admin monitoring)
const alertSchema = new Schema({
  type: { type: String, required: true }, // e.g. 'fraud_signal','revenue_drop','high_refund_rate'
  severity: {
    type: String,
    enum: ["info", "low", "medium", "high", "critical"],
    default: "low",
  },
  message: { type: String, required: true },
  meta: { type: Object }, // structured details (ids, values, window, rule)
  acknowledged: { type: Boolean, default: false },
  acknowledged_at: { type: Date },
  created_at: { type: Date, default: Date.now },
});
alertSchema.index({ type: 1, severity: 1, created_at: -1 });
alertSchema.index({ acknowledged: 1, created_at: -1 });

// ========================================
// PRODUCT REVIEWS & RATINGS
// ========================================
const reviewSchema = new Schema({
  product_id: {
    type: Schema.Types.ObjectId,
    ref: "Product",
    required: [true, "Product ID is required"],
  },
  client_id: {
    type: String,
    required: [true, "Client ID is required"],
  },
  rating: {
    type: Number,
    required: [true, "Rating is required"],
    min: [1, "Rating must be at least 1"],
    max: [5, "Rating cannot exceed 5"],
  },
  comment: {
    type: String,
    trim: true,
    maxlength: [1000, "Comment cannot exceed 1000 characters"],
  },
  images: [
    {
      type: String,
      validate: {
        validator: function (v) {
          return /^https?:\/\/.+/.test(v);
        },
        message: "Image must be a valid URL",
      },
    },
  ],
  helpful_count: {
    type: Number,
    default: 0,
    min: 0,
  },
  verified_purchase: {
    type: Boolean,
    default: false,
  },
  seller_response: {
    message: {
      type: String,
      trim: true,
      maxlength: [500, "Response cannot exceed 500 characters"],
    },
    responded_at: { type: Date },
    seller_id: { type: Schema.Types.ObjectId, ref: "Seller" },
  },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

// Indexes for reviews
reviewSchema.index({ product_id: 1, created_at: -1 });
reviewSchema.index({ client_id: 1, created_at: -1 });
reviewSchema.index({ rating: 1 });
// Prevent duplicate reviews from same client for same product
reviewSchema.index({ product_id: 1, client_id: 1 }, { unique: true });

// ========================================
// WISHLIST / FAVORITES
// ========================================
const wishlistSchema = new Schema({
  client_id: {
    type: String,
    required: [true, "Client ID is required"],
  },
  product_id: {
    type: Schema.Types.ObjectId,
    ref: "Product",
    required: [true, "Product ID is required"],
  },
  added_at: { type: Date, default: Date.now },
});

// Indexes for wishlist
wishlistSchema.index({ client_id: 1, added_at: -1 });
wishlistSchema.index({ product_id: 1 });
// Prevent duplicate entries
wishlistSchema.index({ client_id: 1, product_id: 1 }, { unique: true });

// Add performance indexes
// Enforce unique phone numbers platform-wide for clients (allow sparse so empty/undefined not duplicated)
// NOTE: If legacy duplicates exist, index build will fail; run a cleanup script before deploying.
clientSchema.index({ phone: 1 }, { unique: true, sparse: true });
// Ensure email uniqueness (optional for accounts without email)
clientSchema.index({ email: 1 }, { unique: true, sparse: true });
clientSchema.index({ created_at: -1 });

// Single-field indexes for common lookups
sellerSchema.index({ business_name: 1 });
sellerSchema.index({ phone: 1 });
// Ensure email uniqueness for sellers (sparse to allow optional emails)
sellerSchema.index({ email: 1 }, { unique: true, sparse: true });
sellerSchema.index({ created_at: -1 });

orderSchema.index({ seller_id: 1 });
orderSchema.index({ payment_method: 1 });
orderSchema.index({ total_amount: 1 });
// Index for discount analytics (query orders with discounts applied)
orderSchema.index({ applied_discount_amount: 1 });
orderSchema.index({ created_at: -1 });
// Removed duplicate: orderSchema.index({ client_id: 1, created_at: -1 }); - already defined above

productSchema.index({ seller_id: 1 });
productSchema.index({ category: 1 });
productSchema.index({ created_at: -1 });
// Text/regex-friendly indexes to assist search
productSchema.index({ name: 1 });
productSchema.index({ description: 1 });

sellerSchema.index({ cuisine: 1 });
sellerSchema.index({ description: 1 });

// userAddressSchema indexes are already defined above, removing duplicates

module.exports = {
  Admin: mongoose.model("Admin", adminSchema),
  Client: mongoose.model("Client", clientSchema),
  Seller: mongoose.model("Seller", sellerSchema),
  Product: mongoose.model("Product", productSchema),
  Catalog: mongoose.model("Catalog", catalogSchema),
  Order: mongoose.model("Order", orderSchema),
  Cart: mongoose.model("Cart", cartSchema),
  UserAddress: mongoose.model("UserAddress", userAddressSchema),
  DeviceToken: mongoose.model("DeviceToken", deviceTokenSchema),
  DeliveryAgent: mongoose.model("DeliveryAgent", deliveryAgentSchema),
  NotificationCampaign: mongoose.model(
    "NotificationCampaign",
    notificationCampaignSchema
  ),
  Feedback: mongoose.model("Feedback", feedbackSchema),
  PlatformSettings: mongoose.model("PlatformSettings", platformSettingsSchema),
  EarningLog: mongoose.model("EarningLog", earningLogSchema),
  Alert: mongoose.model("Alert", alertSchema),
  Review: mongoose.model("Review", reviewSchema),
  Wishlist: mongoose.model("Wishlist", wishlistSchema),
};
