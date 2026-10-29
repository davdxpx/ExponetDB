#!/usr/bin/env python3
"""S4: print a SCRAM-SHA-256 verifier of planted value <id> (stdout is only ever piped into psql/stdin, never shown)."""
import base64, hashlib, hmac, json, os, sys
pw = json.load(open(os.environ.get("S4", "/srv/work/s4") + "/planted.json"))[sys.argv[1]].encode()
salt, it = os.urandom(16), 4096
sp = hashlib.pbkdf2_hmac("sha256", pw, salt, it)
ck = hmac.new(sp, b"Client Key", "sha256").digest()
b = lambda x: base64.b64encode(x).decode()
print(f"SCRAM-SHA-256${it}:{b(salt)}${b(hashlib.sha256(ck).digest())}:{b(hmac.new(sp, b'Server Key', 'sha256').digest())}")
