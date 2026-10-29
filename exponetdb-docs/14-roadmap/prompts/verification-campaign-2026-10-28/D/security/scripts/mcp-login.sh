source /srv/work/s4/env.sh; cd $S4
s4ts s4/mcp.ts register s4-mcp-client 2>&1 | tail -1
# the MCP-grantable scopes at nonprod+prod (the owner holds them), explicit
SC="targets.read schema.read diagnostics.read data.read:nonprod migrations.read migrations.plan migrations.apply:nonprod connections.operate:nonprod backups.read nodes.read nodes.plan audit.read"
s4ts s4/mcp.ts login $SC 2>&1 | tail -1
s4ts s4/mcp.ts tools 2>&1 | tail -1
