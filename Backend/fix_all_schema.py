import re

with open("tests/delivery_phase9_batch_p.test.js", "r", encoding="utf-8") as f:
    content = f.read()

# Fix 1: Change "out_for_delivery" to "in_transit"
content = content.replace('delivery_status: "out_for_delivery"', 'delivery_status: "in_transit"')

# Fix 2: Change "ONLINE" to "UPI"
content = content.replace('method: "ONLINE"', 'method: "UPI"')
content = content.replace('payment_method: "ONLINE"', 'payment_method: "UPI"')

# Fix 3: Move top-level delivery_address into delivery.delivery_address
# Pattern: find delivery_address at same level as delivery:, move it inside delivery
lines = content.split('\n')
fixed_lines = []
i = 0

while i < len(lines):
    line = lines[i]
    
    # Check if this is a top-level delivery_address (not already inside delivery)
    if re.match(r'^\s{6,8}delivery_address: \{', line):
        # Find the matching closing brace
        indent = len(line) - len(line.lstrip())
        delivery_addr_lines = [line]
        i += 1
        brace_count = 1
        
        while i < len(lines) and brace_count > 0:
            curr_line = lines[i]
            delivery_addr_lines.append(curr_line)
            brace_count += curr_line.count('{') - curr_line.count('}')
            i += 1
        
        # Find the next delivery: { line
        delivery_block_start = i
        while i < len(lines):
            if re.match(r'^\s{6,8}delivery: \{', lines[i]):
                # Found delivery block, insert delivery_address into it
                delivery_indent = len(lines[i]) - len(lines[i].lstrip())
                fixed_lines.append(lines[i])  # delivery: {
                
                # Add delivery_address with proper indentation
                for addr_line in delivery_addr_lines:
                    fixed_lines.append(' ' * (delivery_indent + 2) + addr_line.lstrip())
                
                # Continue with rest of delivery block
                i += 1
                break
            else:
                fixed_lines.append(lines[i])
                i += 1
    else:
        fixed_lines.append(line)
        i += 1

content = '\n'.join(fixed_lines)

with open("tests/delivery_phase9_batch_p.test.js", "w", encoding="utf-8") as f:
    f.write(content)

print("Fixed all schema issues!")
