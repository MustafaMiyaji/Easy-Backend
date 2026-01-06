import re

# Read the file
with open('tests/phase25_11_delivery_medium.test.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Pattern to find delivery blocks with buyer_address
# This will match delivery blocks that need fixing
pattern = r'(delivery: \{\s*delivery_status: "[^"]+",?\s*)(.*?)\s*\},\s*buyer_address: "Test Address",'

def replacement(match):
    delivery_start = match.group(1)
    middle_content = match.group(2).strip()
    
    # Check if already has delivery_address
    if 'delivery_address' in middle_content:
        return match.group(0)  # Already fixed
    
    # Build the replacement
    result = delivery_start
    result += '\n          delivery_address: {\n'
    result += '            full_address: "Test Address",\n'
    result += '            location: { lat: 13.09, lng: 80.28 }\n'
    result += '          },\n'
    
    # Add back any middle content (like offered_to, etc.)
    if middle_content and middle_content not in ['', '\n']:
        result += '          ' + middle_content + '\n'
    
    result += '        },'
    
    return result

# Apply the pattern
content = re.sub(pattern, replacement, content, flags=re.DOTALL)

# Now add total_amount before created_at where missing
lines = content.split('\n')
fixed_lines = []
for i, line in enumerate(lines):
    fixed_lines.append(line)
    if 'created_at: new Date()' in line or 'created_at: new Date(Date.now()' in line:
        # Check if previous line has total_amount
        if i > 0 and 'total_amount' not in lines[i-1]:
            # Insert total_amount before this line
            indent = len(line) - len(line.lstrip())
            fixed_lines[-1] = ' ' * indent + 'total_amount: 100,\n' + line

content = '\n'.join(fixed_lines)

# Write back
with open('tests/phase25_11_delivery_medium.test.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Fixed all Order schema issues!")
