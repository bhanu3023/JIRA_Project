// Standalone, no-DB-needed check that an OpenAI API key works and has
// remaining credit -- makes one tiny request (a few tokens) and prints the
// result. Deliberately reads the key ONLY from the OPENAI_API_KEY
// environment variable -- never hardcode a key into this file or any
// other committed file.
//
// Usage (key is never written to disk or git history this way):
//   OPENAI_API_KEY=sk-...  node check-openai-key.mjs
//
// On Windows PowerShell:
//   $env:OPENAI_API_KEY='sk-...'; node check-openai-key.mjs
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error('Set OPENAI_API_KEY as an env var first, e.g.:\n  OPENAI_API_KEY=sk-... node check-openai-key.mjs');
  process.exit(1);
}

const res = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${KEY}`,
  },
  body: JSON.stringify({
    model: 'gpt-4o-mini',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
  }),
});

if (!res.ok) {
  const body = await res.text().catch(() => '');
  console.error(`FAILED -- HTTP ${res.status}`);
  console.error(body);
  if (res.status === 401) console.error('\nKey is invalid or revoked.');
  if (res.status === 429) console.error('\nRate limited or out of credit/quota.');
  process.exit(1);
}

const data = await res.json();
console.log('Key works. Model replied:', data.choices?.[0]?.message?.content?.trim());
console.log('Tokens used this call:', data.usage?.total_tokens);
