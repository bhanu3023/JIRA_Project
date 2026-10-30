// Stops leo@fuzebot.io's IMAP poller and removes its email_configs rows
// (all spaces it's connected in, in one call) -- it's this app's own
// outbound system address, not a real support inbox, and was catching its
// own automated notifications as new tickets.
const res = await fetch('http://localhost:8080/api/email/connect?email=leo@fuzebot.io', { method: 'DELETE' });
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
