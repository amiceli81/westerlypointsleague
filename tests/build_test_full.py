import os
import re
pool_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'pool.html')
html = open(pool_path).read()
full = "<!doctype html><html><head><meta charset='utf-8'></head><body>\n" + html + "\n</body></html>"
open('/tmp/test_dup_full.html', 'w').write(full)
print("wrote", len(full))
