const fs = require("fs");

const filePath = "tests/phase25_11_delivery_medium.test.js";
let content = fs.readFileSync(filePath, "utf8");

// Fix buyer_address -> delivery.delivery_address pattern
// This regex finds the pattern and replaces it properly
content = content.replace(
  /(delivery: \{[^}]*delivery_status: "pending",\s*)(\s*)(\/\/[^\n]*)?\n(\s*)(.*?)\n(\s*)},\s*buyer_address: "Test Address",/gs,
  (match, deliveryStart, ws1, comment, ws2, middleContent, ws3) => {
    // Check if delivery_address already exists
    if (middleContent.includes("delivery_address")) {
      return match; // Already fixed
    }
    return `${deliveryStart}${ws2}delivery_address: {
${ws2}  full_address: "Test Address",
${ws2}  location: { lat: 13.09, lng: 80.28 }
${ws2}},
${ws2}${middleContent}
${ws3}},`;
  }
);

// Alternative pattern for delivery blocks without comments
content = content.replace(
  /delivery: \{\s*delivery_status: "pending",\s*\},\s*buyer_address: "Test Address",/g,
  `delivery: {
          delivery_status: "pending",
          delivery_address: {
            full_address: "Test Address",
            location: { lat: 13.09, lng: 80.28 }
          },
        },`
);

// Add total_amount before created_at if not present
content = content.replace(/(\s+)created_at: new Date\(\)/g, (match, ws) => {
  // Check if total_amount is already before this line
  const lines = content.split("\n");
  const lineIndex =
    content.substring(0, content.indexOf(match)).split("\n").length - 1;
  if (lineIndex > 0 && lines[lineIndex - 1].includes("total_amount")) {
    return match; // Already has total_amount
  }
  return `${ws}total_amount: 100,\n${ws}created_at: new Date()`;
});

fs.writeFileSync(filePath, content, "utf8");
console.log("Fixed delivery test schema!");
