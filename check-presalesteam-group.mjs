// Read-only check: is presalesteam@cloudfuze.com actually a Microsoft 365
// Group (which has its own group mailbox, readable via /groups/{id}/...)
// rather than a classic Distribution List (no mailbox at all, genuinely
// unreadable no matter what)? If it resolves as a group here, there's a
// real code-side fix available instead of waiting on an Exchange admin
// conversion.
const clientId     = process.env.MICROSOFT_CLIENT_ID;
const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
const tenantId     = process.env.MICROSOFT_TENANT_ID;
const address      = process.argv[2] || 'presalesteam@cloudfuze.com';

async function main() {
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  const { access_token } = await res.json();
  if (!access_token) { console.error('No token'); process.exit(1); }

  console.log(`--- Checking if "${address}" resolves as a Microsoft 365 Group ---`);
  const groupRes = await fetch(
    `https://graph.microsoft.com/v1.0/groups?$filter=mail eq '${address}'&$select=id,displayName,mail,groupTypes,mailEnabled,securityEnabled`,
    { headers: { Authorization: `Bearer ${access_token}` } }
  );
  const groupData = await groupRes.json();
  console.log(`Status: ${groupRes.status}`);
  console.log(JSON.stringify(groupData, null, 2));

  const group = groupData.value?.[0];
  if (group) {
    console.log(`\nFound as a group: id=${group.id}, groupTypes=${JSON.stringify(group.groupTypes)}, mailEnabled=${group.mailEnabled}, securityEnabled=${group.securityEnabled}`);
    const isM365Group = Array.isArray(group.groupTypes) && group.groupTypes.includes('Unified');
    console.log(`Is a real Microsoft 365 ("Unified") group with its own mailbox: ${isM365Group}`);
    if (isM365Group) {
      console.log('\n--- Trying to read its group conversations/mailbox ---');
      const convRes = await fetch(
        `https://graph.microsoft.com/v1.0/groups/${group.id}/conversations?$top=5`,
        { headers: { Authorization: `Bearer ${access_token}` } }
      );
      const convData = await convRes.json();
      console.log(`Status: ${convRes.status}`);
      console.log(JSON.stringify(convData, null, 2).slice(0, 1500));
    } else {
      console.log('\nThis is a plain mail-enabled security group / classic Distribution List -- it genuinely has no mailbox. No Graph endpoint can read mail "sent to" it; messages only ever land in each individual member\'s own inbox. The Shared Mailbox conversion really is the only fix.');
    }
  } else {
    console.log('\nDoes not resolve as a group at all via this filter.');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
