import json,sys,urllib.request,urllib.error,re
S4='/srv/work/s4'
smp=json.load(open(S4+'/authz/authz-samples.json'))['rest']
fx=json.load(open(S4+'/authz/fixtures.json'))
tok=open(S4+'/creds/'+(sys.argv[2] if len(sys.argv)>2 else 'owner')+'.token').read().strip()
def fill(v,key,tier='nonprod'):
    if isinstance(v,str) and v.startswith('@id:'):
        p=v[4:]
        if p=='tgt': return fx['targets'][tier]
        return fx['ids'].get(key) or fx['ids'].get(p) or p+'_00000000000000000000000000'
    if isinstance(v,list): return [fill(x,key,tier) for x in v]
    if isinstance(v,dict): return {k:fill(x,k,tier) for k,x in v.items()}
    return v
for op in sys.argv[1].split(','):
    s=smp[op]
    path=re.sub(r'\{(\w+)\}',lambda m:str(fill(s['params'][m.group(1)],m.group(1))),s['path'])
    body=fill(s.get('body'),'') if s.get('body') is not None else None
    req=urllib.request.Request('http://127.0.0.1:58480'+path,method=s['method'],data=json.dumps(body).encode() if body is not None else None,headers={'Authorization':'Bearer '+tok,'content-type':'application/json'})
    try:
        r=urllib.request.urlopen(req); print(op,r.status,r.read()[:200])
    except urllib.error.HTTPError as e:
        b=e.read().decode()
        try: j=json.loads(b); print(op,e.code,j.get('code'),json.dumps(j.get('details') or j.get('errors') or '')[:300], '| body sent keys:', list((body or {}).keys()) if isinstance(body,dict) else body)
        except Exception: print(op,e.code,b[:200])
