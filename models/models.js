const mongoose = require('mongoose');
const { Schema } = mongoose;

// Corresponds to the 'Admin' table
const adminSchema = new Schema({
  email: { type: String, required: true, unique: true },
  role: { type: String, enum: ['superadmin', 'moderator'], required: true },
  created_at: { type: Date, default: Date.now }
});

// Corresponds to the 'Client' table
const clientSchema = new Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  otp_verified: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now }
});

// Corresponds to the 'Seller' table
const sellerSchema = new Schema({
  business_name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  business_type: { type: String },
  approved: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now }
});

// Corresponds to the 'Product' table
const productSchema = new Schema({
  seller_id: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
  name: { type: String, required: true },
  category: { type: String }, // e.g., Grocery, Restaurant, Vegetables
  price: { type: Number, required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  created_at: { type: Date, default: Date.now }
});

// Corresponds to the 'Catalog' table
const catalogSchema = new Schema({
  seller_id: { type: Schema.Types.ObjectId, ref: 'Seller', required: true, unique: true },
  min_products_required: { type: Number, default: 0 },
  published: { type: Boolean, default: false }
});

// Corresponds to 'Orolog', 'OrderItem', 'Payment', and 'Delivery' tables combined
const orderSchema = new Schema({
  client_id: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
  seller_id: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
  catalog_id: { type: Schema.Types.ObjectId, ref: 'Catalog' }, // from Orolog
  published: { type: Boolean, default: true }, // from Orolog

  order_items: [{ // from OrderItem
    product_id: { type: Schema.Types.ObjectId, ref: 'Product' },
    qty: { type: Number, required: true },
    // Best practice: snapshot price and name for historical accuracy
    price_snapshot: Number,
    name_snapshot: String
  }],

  payment: { // from Payment
    amount: { type: Number, required: true },
    method: { type: String, enum: ['razorpay', 'card', 'UPI'] },
    status: { type: String, required: true }, // 'statue' corrected to 'status'
    payment_date: { type: Date, default: Date.now } // 'payment_dare' corrected to 'payment_date'
  },

  delivery: { // from Delivery
    delivery_status: { type: String, enum: ['pending', 'dispatched', 'delivered'], default: 'pending' },
    delivery_start_time: { type: Date },
    delivery_end_time: { type: Date }
  }
});

module.exports = {
  Admin: mongoose.model('Admin', adminSchema),
  Client: mongoose.model('Client', clientSchema),
  Seller: mongoose.model('Seller', sellerSchema),
  Product: mongoose.model('Product', productSchema),
  Catalog: mongoose.model('Catalog', catalogSchema),
  Order: mongoose.model('Order', orderSchema)
};