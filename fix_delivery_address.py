import re

# Read the file
with open("tests/delivery_phase9_batch_p.test.js", "r", encoding="utf-8") as f:
    content = f.read()

# Pattern: Move top-level delivery_address into delivery.delivery_address
# Handles two cases:
# 1. delivery_address with location spanning multiple lines
# 2. delivery_address with just full_address (single/double line)

# Find and replace pattern
def move_delivery_address(match):
    before = match.group(1)  # Everything before delivery_address
    delivery_addr = match.group(2)  # The delivery_address object
    delivery_block = match.group(3)  # The delivery: { ... } block
    
    # Extract the delivery object content
    delivery_content_match = re.search(r'delivery: \{([^\}]+)\}', delivery_block)
    if delivery_content_match:
        delivery_content = delivery_content_match.group(1).strip()
        # Add delivery_address at the beginning of delivery block
        new_delivery = f"delivery: {{\n          delivery_address: {delivery_addr},\n          {delivery_content}\n        }}"
        return f"{before}\n        {new_delivery},\n"
    return match.group(0)  # Return original if pattern doesn't match

# Pattern to match: payment/order_status, then delivery_address, then delivery block
pattern = r'(payment: \{[^\}]+\},\s+order_status: "[^"]+",)(?:\s+//[^\n]+\n)?(?:\s+//[^\n]+\n)?\s+delivery_address: (\{[^\}]+?\}),\s+(delivery: \{[^\}]+\},)'

# Apply replacement
content = re.sub(pattern, move_delivery_address, content, flags=re.DOTALL)

# Write back
with open("tests/delivery_phase9_batch_p.test.js", "w", encoding="utf-8") as f:
    f.write(content)

print("Fixed delivery_address fields")
