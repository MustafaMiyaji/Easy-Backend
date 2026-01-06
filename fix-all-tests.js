const fs = require("fs");
const path = require("path");

console.log("🔧 Fixing all test files...\n");

// Helper to generate unique test data
const generateUniqueTestData = () => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  return {
    firebase_uid: `test_${timestamp}_${random}`,
    email: `test_${timestamp}_${random}@test.com`,
    phone: `98765${timestamp.toString().slice(-5)}`,
  };
};

// Fix seller.test.js - unique phone numbers
const sellerTestPath = path.join(__dirname, "tests", "seller.test.js");
let sellerContent = fs.readFileSync(sellerTestPath, "utf8");

// Replace all instances of phone: "9876543213" with unique phones
let phoneCounter = 0;
sellerContent = sellerContent.replace(/phone: "9876543213",/g, () => {
  phoneCounter++;
  return `phone: "987654321${phoneCounter}",`;
});

fs.writeFileSync(sellerTestPath, sellerContent);
console.log(
  `✅ Fixed seller.test.js - ${phoneCounter} phone numbers made unique`
);

// Fix delivery.test.js - unique identifiers
const deliveryTestPath = path.join(__dirname, "tests", "delivery.test.js");
if (fs.existsSync(deliveryTestPath)) {
  let deliveryContent = fs.readFileSync(deliveryTestPath, "utf8");

  // Replace duplicate firebase_uids
  deliveryContent = deliveryContent.replace(
    /firebase_uid: "test_client"/g,
    () => {
      const data = generateUniqueTestData();
      return `firebase_uid: "${data.firebase_uid}"`;
    }
  );

  // Replace duplicate emails
  let emailCounter = 0;
  deliveryContent = deliveryContent.replace(
    /email: "test@example\.com"/g,
    () => {
      emailCounter++;
      return `email: "test${emailCounter}_${Date.now()}@example.com"`;
    }
  );

  // Replace duplicate phones
  phoneCounter = 0;
  deliveryContent = deliveryContent.replace(/phone: "9999999999"/g, () => {
    phoneCounter++;
    return `phone: "999999999${phoneCounter}"`;
  });

  fs.writeFileSync(deliveryTestPath, deliveryContent);
  console.log(`✅ Fixed delivery.test.js - unique identifiers`);
}

// Fix cart.test.js
const cartTestPath = path.join(__dirname, "tests", "cart.test.js");
if (fs.existsSync(cartTestPath)) {
  let cartContent = fs.readFileSync(cartTestPath, "utf8");

  // Replace duplicate firebase_uids
  cartContent = cartContent.replace(/firebase_uid: "test_cart_client"/g, () => {
    const data = generateUniqueTestData();
    return `firebase_uid: "${data.firebase_uid}"`;
  });

  // Replace duplicate phones
  phoneCounter = 0;
  cartContent = cartContent.replace(/phone: "9876543210"/g, () => {
    phoneCounter++;
    return `phone: "987654321${phoneCounter}"`;
  });

  fs.writeFileSync(cartTestPath, cartContent);
  console.log(`✅ Fixed cart.test.js - unique identifiers`);
}

// Fix end-to-end-order.test.js
const e2eTestPath = path.join(
  __dirname,
  "tests",
  "integration",
  "end-to-end-order.test.js"
);
if (fs.existsSync(e2eTestPath)) {
  let e2eContent = fs.readFileSync(e2eTestPath, "utf8");

  // Replace duplicate firebase_uids
  e2eContent = e2eContent.replace(/firebase_uid: "test_e2e_client"/g, () => {
    const data = generateUniqueTestData();
    return `firebase_uid: "${data.firebase_uid}"`;
  });

  // Replace duplicate firebase_uids for agents
  e2eContent = e2eContent.replace(/firebase_uid: "test_e2e_agent"/g, () => {
    const data = generateUniqueTestData();
    return `firebase_uid: "agent_${data.firebase_uid}"`;
  });

  // Replace duplicate phones
  phoneCounter = 0;
  e2eContent = e2eContent.replace(/phone: "9999999999"/g, () => {
    phoneCounter++;
    return `phone: "999999999${phoneCounter}"`;
  });

  e2eContent = e2eContent.replace(/phone: "9876543210"/g, () => {
    phoneCounter++;
    return `phone: "987654321${phoneCounter}"`;
  });

  fs.writeFileSync(e2eTestPath, e2eContent);
  console.log(`✅ Fixed end-to-end-order.test.js - unique identifiers`);
}

console.log("\n🎉 All test files fixed!");
