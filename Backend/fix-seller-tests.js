const fs = require("fs");

// Read the file
let content = fs.readFileSync(
  "c:\\Users\\asus\\Documents\\EasyApp\\Backend\\tests\\seller.test.js",
  "utf8"
);

// Replace all instances of duplicate firebase_uid
content = content.replace(
  /firebase_uid: "test_client",/g,
  "firebase_uid: `test_client_${Date.now()}_${Math.random()}`,"
);

// Replace duplicate emails in Client creation
content = content.replace(
  /email: "customer@test.com",/g,
  "email: `customer_${Date.now()}_${Math.random()}@test.com`,"
);

// Fix Order creation - replace all instances with proper structure
const oldOrderPattern =
  /testOrder = await Order\.create\(\{\s+client_id: client\._id,\s+order_items: \[\s+\{\s+product_id: testProduct\._id,\s+name: testProduct\.name,\s+price: testProduct\.price,\s+quantity: 2,\s+\},\s+\],\s+total: 200,\s+status: "pending",\s+delivery_address: "Test Address",\s+\}\);/g;

const newOrderCode = `testOrder = await Order.create({
        client_id: client._id,
        order_items: [
          {
            product_id: testProduct._id,
            qty: 2,
            price_snapshot: testProduct.price,
            name_snapshot: testProduct.name,
          },
        ],
        total: 200,
        status: "pending",
        delivery: {
          delivery_address: {
            full_address: "123 Test Street, Test City",
            recipient_name: "Test Customer",
            recipient_phone: "9876543213",
          },
          delivery_charge: 0,
        },
        payment: {
          amount: 200,
          method: "COD",
          status: "pending",
        },
      });`;

content = content.replace(oldOrderPattern, newOrderCode);

// Write back
fs.writeFileSync(
  "c:\\Users\\asus\\Documents\\EasyApp\\Backend\\tests\\seller.test.js",
  content
);

console.log("✅ Fixed seller.test.js");
