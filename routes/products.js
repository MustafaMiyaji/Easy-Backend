const express = require("express");
const router = express.Router();
const { Product, PlatformSettings } = require("../models/models");
const { cacheMiddleware } = require("../middleware/cache");
const { paginationMiddleware, paginate } = require("../middleware/pagination");

// GET /api/products?category=Grocery&q=milk&page=1&limit=20
router.get(
  "/",
  paginationMiddleware({ defaultLimit: 20, maxLimit: 100 }),
  cacheMiddleware(300, (req) => {
    const { category, q, page, limit } = req.query;
    return `cache:products:${category || "all"}:${q || "none"}:${page || 1}:${
      limit || 20
    }`;
  }),
  async (req, res) => {
    try {
      const { category, q } = req.query;
      const { skip, limit, page } = req.pagination;

      const filter = { status: "active" };
      if (category) {
        // Case-insensitive exact match
        filter.category = new RegExp(`^${category}$`, "i");
      }
      if (q && String(q).trim()) {
        const safe = String(q)
          .trim()
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const rx = new RegExp(safe, "i");
        filter.$or = [{ name: rx }, { description: rx }];
      }

      // Get total count for pagination
      const total = await Product.countDocuments(filter);

      // Get paginated products
      const products = await Product.find(filter)
        .populate("seller_id", "business_name address cuisine is_open")
        .skip(skip)
        .limit(limit)
        .lean();

      // Ensure seller_id is included in the response with is_open status
      const productsWithSeller = products.map((product) => ({
        ...product,
        seller_id: product.seller_id
          ? product.seller_id._id || product.seller_id
          : null,
        seller_name: product.seller_id ? product.seller_id.business_name : null,
        seller_address: product.seller_id ? product.seller_id.address : null,
        seller_cuisine: product.seller_id ? product.seller_id.cuisine : null,
        seller_is_open: product.seller_id ? product.seller_id.is_open : null,
      }));

      return res.json(paginate(productsWithSeller, total, page, limit));
    } catch (err) {
      console.error("Error fetching products:", err);
      return res.status(500).json({ error: "Failed to fetch products" });
    }
  }
);

// POST /api/products/prices  { ids: ["..."] }
// Returns latest authoritative pricing & name info for provided product ids.
router.post("/prices", async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array required" });
    }
    const dbProducts = await Product.find({ _id: { $in: ids } }).lean();
    // Map for fast lookup
    const map = new Map();
    for (const p of dbProducts) {
      map.set(String(p._id), {
        product_id: String(p._id),
        name: p.name,
        price: p.price,
        status: p.status,
      });
    }
    // Only return entries that exist in DB
    const result = ids
      .filter((id) => map.has(String(id)))
      .map((id) => map.get(String(id)));
    return res.json(result);
  } catch (err) {
    console.error("Error in POST /products/prices:", err);
    return res.status(500).json({ error: "Failed to fetch prices" });
  }
});

// POST /api/products/stock  { items: [{product_id, qty}] }
// Simplistic stock validation – assumes unlimited if product exists & status active.
// Returns: [{product_id, available: true|false, maxQty}]
router.post("/stock", async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array required" });
    }

    const ids = Array.from(
      new Set(items.map((i) => i.product_id).filter(Boolean))
    );
    const dbProducts = await Product.find({ _id: { $in: ids } }).lean();

    const map = new Map();
    for (const p of dbProducts) {
      map.set(String(p._id), p);
    }

    const response = items.map((i) => {
      const pid = String(i.product_id);
      const desired = Number(i.qty) || 0;
      const prod = map.get(pid);
      if (!prod || prod.status !== "active") {
        return { product_id: pid, available: false, maxQty: 0, remaining: 0 };
      }
      const stock = typeof prod.stock === "number" ? prod.stock : 0;
      const alloc = Math.min(desired, Math.max(0, stock));
      return {
        product_id: pid,
        available: alloc === desired && stock > 0,
        maxQty: alloc,
        remaining: Math.max(0, stock - alloc),
        stock,
      };
    });

    return res.json(response);
  } catch (err) {
    console.error("Error in POST /products/stock:", err);
    return res.status(500).json({ error: "Failed to validate stock" });
  }
});

// POST /api/products/quote { items: [{ product_id, qty }] }
// Returns authoritative line breakdown with accepted quantities & current prices before order placement.
// Response shape:
// {
//   items: [{ product_id, name, unit_price, requestedQty, acceptedQty, line_total, status }],
//   subtotal, adjustments: [], grand_total, currency: 'INR', warnings: []
// }
const mongoose = require("mongoose");
router.post("/quote", async (req, res) => {
  try {
    const { items, coupon } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array required" });
    }

    // Collect only valid Mongo ObjectIds to query DB; keep original mapping
    const rawIds = items.map((i) => i.product_id).filter(Boolean);
    const ids = Array.from(
      new Set(rawIds.filter((id) => mongoose.isValidObjectId(id)))
    );
    let dbProducts = [];
    try {
      if (ids.length) {
        dbProducts = await Product.find({ _id: { $in: ids } }).lean();
      }
    } catch (e) {
      console.warn("DB error in /quote:", e.message);
    }

    const map = new Map();
    for (const p of dbProducts) {
      map.set(String(p._id), p);
    }

    const quoteItems = [];
    const warnings = [];
    for (const inItem of items) {
      const pid = String(inItem.product_id);
      const requested = Math.max(0, Number(inItem.qty) || 0);
      let prod = map.get(pid);
      // If not found by id (maybe coming from sample data without real _id) try name fallback
      if (!prod && !mongoose.isValidObjectId(pid)) {
        prod = dbProducts.find((p) => p.name === pid) || null; // unlikely but safeguard
      }
      if (!prod || prod.status !== "active") {
        quoteItems.push({
          product_id: pid,
          name: prod?.name || "Unknown",
          unit_price: prod?.price ?? 0,
          requestedQty: requested,
          acceptedQty: 0,
          line_total: 0,
          status: "unavailable",
        });
        if (requested > 0)
          warnings.push(`Product ${pid} unavailable and removed.`);
        continue;
      }
      const stock = typeof prod.stock === "number" ? prod.stock : 0;
      // For restaurant/food items, treat as unlimited stock
      const cat = (prod.category || "").toString().toLowerCase();
      const unlimited = cat.includes("restaurant") || cat.includes("food");
      let accepted = unlimited ? requested : Math.min(requested, stock);
      let status = "ok";
      if (!unlimited && stock <= 0) {
        accepted = 0;
        status = "unavailable";
        warnings.push(`${prod.name} out of stock.`);
      } else if (accepted < requested) {
        status = "partial";
        warnings.push(
          `${prod.name} quantity reduced to ${accepted} (requested ${requested}).`
        );
      }
      const unitPrice = prod.price;
      quoteItems.push({
        product_id: pid,
        name: prod.name,
        unit_price: unitPrice,
        requestedQty: requested,
        acceptedQty: accepted,
        line_total: unitPrice * accepted,
        status,
      });
    }

    const subtotal = quoteItems.reduce((sum, li) => sum + li.line_total, 0);
    const adjustments = [];
    let discount = 0;
    let deliveryCharge = 0;

    // Load platform settings for coupons and delivery charges
    let settings = null;
    try {
      settings = await PlatformSettings.findOne(
        {},
        { coupons: 1, delivery_charge_grocery: 1, delivery_charge_food: 1 }
      ).lean();
    } catch (_) {}

    // Coupon calculation (with optional category scoping)
    try {
      const coupons = settings?.coupons || [];
      if (coupon && typeof coupon === "string") {
        const code = coupon.toUpperCase().trim();
        const now = new Date();
        // Detect present categories in this quote
        let present = { grocery: false, vegetable: false, food: false };
        for (const li of quoteItems) {
          if (!li.acceptedQty || li.acceptedQty <= 0) continue;
          const prod = map.get(String(li.product_id));
          const cat = (prod?.category || "").toString().toLowerCase();
          if (cat.includes("grocery")) present.grocery = true;
          if (cat.includes("vegetable")) present.vegetable = true;
          if (cat.includes("restaurant") || cat.includes("food"))
            present.food = true;
        }
        const found = coupons.find((c) => {
          const codeOk = String(c.code).toUpperCase().trim() === code;
          const activeOk = c.active !== false;
          const timeOk =
            (!c.validFrom || new Date(c.validFrom) <= now) &&
            (!c.validTo || new Date(c.validTo) >= now);
          const minOk = subtotal >= (Number(c.minSubtotal) || 0);
          // Category scoping: if categories provided, require intersection with present categories
          let catOk = true;
          if (Array.isArray(c.categories) && c.categories.length > 0) {
            catOk = c.categories.some(
              (x) =>
                (x === "grocery" && present.grocery) ||
                (x === "vegetable" && present.vegetable) ||
                (x === "food" && present.food)
            );
          }
          return codeOk && activeOk && timeOk && minOk && catOk;
        });
        if (found && found.percent > 0) {
          discount =
            Math.round(
              ((subtotal * (Number(found.percent) || 0)) / 100) * 100
            ) / 100;
          if (discount > 0) {
            adjustments.push({
              type: "coupon",
              code: found.code,
              amount: -discount,
              percent: found.percent,
              categories: found.categories || undefined,
            });
          }
        }
      }
    } catch (_) {}

    // Delivery charge by present groups (grocery vs food) inferred from product categories
    try {
      const dcG = Number(settings?.delivery_charge_grocery ?? 30);
      const dcF = Number(settings?.delivery_charge_food ?? 40);
      const threshold = Number(settings?.min_total_for_delivery_charge ?? 100);
      const freeDeliveryThreshold = Number(
        settings?.free_delivery_threshold ?? 0
      );
      let hasGrocery = false;
      let hasFood = false;
      let grocerySubtotal = 0;
      let foodSubtotal = 0;
      for (const li of quoteItems) {
        if (!li.acceptedQty || li.acceptedQty <= 0) continue;
        const prod = map.get(String(li.product_id));
        const cat = (prod?.category || "").toString().toLowerCase();
        if (cat.includes("grocery") || cat.includes("vegetable")) {
          hasGrocery = true;
          grocerySubtotal += li.line_total;
        }
        if (cat.includes("restaurant") || cat.includes("food")) {
          hasFood = true;
          foodSubtotal += li.line_total;
        }
      }
      // Raw category fee (as if always charged whenever category present)
      const rawDeliveryCharge = (hasGrocery ? dcG : 0) + (hasFood ? dcF : 0);

      // Compute threshold-aware base delivery charge (per-category min_total rule)
      const thresholdValid = Number.isFinite(threshold) && threshold > 0;
      let baseDeliveryCharge = 0;
      if (hasGrocery && (!thresholdValid || grocerySubtotal <= threshold))
        baseDeliveryCharge += dcG;
      if (hasFood && (!thresholdValid || foodSubtotal <= threshold))
        baseDeliveryCharge += dcF;

      // Order-level free threshold
      const orderSubtotal = grocerySubtotal + foodSubtotal;
      const orderFree =
        freeDeliveryThreshold > 0 && orderSubtotal >= freeDeliveryThreshold;
      // Category threshold could also waive some/all (when base < raw)
      const categoryFree = baseDeliveryCharge < rawDeliveryCharge;

      // Final applied charge
      const freeApplied =
        orderFree || (categoryFree && baseDeliveryCharge === 0);
      deliveryCharge = freeApplied ? 0 : baseDeliveryCharge;

      // Expose details for UI (strikethrough when any free rule applies)
      const waived = freeApplied
        ? rawDeliveryCharge
        : Math.max(0, rawDeliveryCharge - deliveryCharge);
      if (waived > 0) {
        adjustments.push({
          type: "delivery_waiver",
          amount: -waived,
          reason: orderFree ? "free_delivery_threshold" : "category_threshold",
        });
      }
      // Attach extras to response
      req.quoteMeta = {
        delivery_charge_original: rawDeliveryCharge,
        delivery_fee_waived: waived,
        free_delivery_applied: waived > 0 && deliveryCharge === 0,
        free_delivery_threshold: freeDeliveryThreshold,
      };
    } catch (_) {}

    const grand_total = Math.max(0, subtotal - discount + deliveryCharge);

    const extras = req.quoteMeta || {};
    return res.json({
      items: quoteItems,
      subtotal,
      adjustments,
      delivery_charge: deliveryCharge,
      delivery_charge_original: extras.delivery_charge_original,
      delivery_fee_waived: extras.delivery_fee_waived,
      free_delivery_applied: extras.free_delivery_applied,
      free_delivery_threshold: extras.free_delivery_threshold,
      grand_total,
      currency: "INR",
      warnings,
    });
  } catch (err) {
    console.error("Error in POST /products/quote:", err);
    return res.status(500).json({ error: "Failed to build quote" });
  }
});

module.exports = router;
