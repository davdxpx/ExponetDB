import json
X='A'*43
Y='B'*43
jwks={"keys":[{"kty":"EC","crv":"P-256","x":X,"y":Y,"kid":"s4-key"}]}
b={
 "planEnvironmentChange":{"displayName":"S4 probe"},
 "planProjectChange":{"displayName":"S4 probe"},
 "planMigrations":{"migrationIds":["01M64P1KY18J67RNN8B67BW9RX"]},
 "planNodeConfigUpdate":{"addJobKeys":["s4_key"],"retireJobKeys":[]},
 "registerCimdClient":{"clientId":"https://client.invalid/s4.json"},
 "registerServiceAccountClient":{"jwks":jwks},
 "replaceServiceAccountClientKeys":{"jwks":jwks},
 "submitRoleVerifier":{"role":"s4_canary_app","verifier":"SCRAM-SHA-256$4096:AAAAAAAAAAAAAAAAAAAAAA==$"+"A"*43+"=:"+"B"*43+"="},
}
json.dump(b,open('/srv/work/s4/authz/bodies.json','w'))
fx=json.load(open('/srv/work/s4/authz/fixtures.json'))
fx['ids']={k:v for k,v in fx['ids'].items() if v and v!='null'}
json.dump(fx,open('/srv/work/s4/authz/fixtures.json','w'))
print(sorted(fx['ids']))
