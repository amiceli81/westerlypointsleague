import re
html = open('/home/claude/pool-app/pool.html').read()
full = "<!doctype html><html><head><meta charset='utf-8'></head><body>\n" + html + "\n</body></html>"
open('/tmp/test_dup_full.html', 'w').write(full)
print("wrote", len(full))
