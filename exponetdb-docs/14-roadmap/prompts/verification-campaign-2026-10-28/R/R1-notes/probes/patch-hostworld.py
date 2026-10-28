import sys,re
p=sys.argv[1]
s=open(p).read()
n=0
a="      clientRegistration: 'review',\n    }\n    const logger = createLogger({ role: 'serve', level: 'warn', write: () => undefined })"
if a in s:
    s=s.replace(a,"      clientRegistration: 'review',\n      backupExecution: { backups: 'nonprod', restores: 'scratch' },\n    }\n    const logger = createLogger({ role: 'serve', level: 'warn', write: () => undefined })"); n+=1
b="      controlStoreUrl: this.db.url('exdb_worker'),\n      auditExport: { kind: 'none' },\n    }"
if b in s:
    s=s.replace(b,"      controlStoreUrl: this.db.url('exdb_worker'),\n      auditExport: { kind: 'none' },\n      backupExecution: { backups: 'nonprod', restores: 'scratch' },\n    }"); n+=1
c="`ReadWritePaths=/etc/postgresql ${node.helperDir}`"
if c in s:
    s=s.replace(c,"`ReadWritePaths=/etc/postgresql ${node.helperDir} -/etc/exponetdb-node -/var/lib/exponetdb-node-engine`"); n+=1
open(p,'w').write(s)
print(p,'patches',n)
