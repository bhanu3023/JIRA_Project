/**
 * Run with:  node --test --experimental-strip-types src/analytics/hotjar.test.ts
 *
 * Uses node:test and a hand-rolled DOM stub rather than a test framework, because this repo has
 * no test runner and Hotjar is not a reason to introduce one. The stub covers exactly the four DOM
 * calls initHotjar makes -- getElementById, createElement, head.appendChild, and the id lookup.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type FakeScript = { id: string; async: boolean; src: string; tagName: string };

/** Re-imported per case with a cache-busting query, so the module-level HOTJAR_SITE_ID is
 *  re-resolved from the window state each test rather than frozen by the first import. */
let caseId = 0;
async function loadFresh() {
  caseId += 1;
  return import(`./hotjar.ts?case=${caseId}`);
}

function installFakeDom(siteId: string) {
  const scripts: FakeScript[] = [];
  const head = { appendChild: (el: FakeScript) => void scripts.push(el) };
  const doc = {
    head,
    getElementById: (id: string) => scripts.find((s) => s.id === id) ?? null,
    createElement: (tagName: string) => ({ id: '', async: false, src: '', tagName }) as FakeScript,
  };
  (globalThis as any).window = { __APP_CONFIG__: { hotjarSiteId: siteId } };
  (globalThis as any).document = doc;
  return { scripts, doc };
}

describe('initHotjar', () => {
  beforeEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
  });

  test('does nothing when no site ID is configured', async () => {
    const { scripts, doc } = installFakeDom('');
    const { initHotjar, isHotjarEnabled } = await loadFresh();
    assert.equal(isHotjarEnabled(), false);
    assert.equal(initHotjar(), false);
    assert.equal(doc.getElementById('hotjar-snippet'), null);
    assert.equal(scripts.length, 0, 'no script may be requested when disabled');
    assert.equal((globalThis as any).window._hjSettings, undefined);
  });

  test('injects once and sets a numeric hjid', async () => {
    const { scripts } = installFakeDom('6766543');
    const { initHotjar } = await loadFresh();
    assert.equal(initHotjar(), true);
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].id, 'hotjar-snippet');
    assert.equal(scripts[0].src, 'https://static.hotjar.com/c/hotjar-6766543.js?sv=6');
    assert.equal((globalThis as any).window._hjSettings.hjid, 6766543);
    assert.equal(typeof (globalThis as any).window._hjSettings.hjid, 'number');
    assert.equal((globalThis as any).window._hjSettings.hjsv, 6);
    // Idempotent: reactStrictMode double-invokes the effect that calls this.
    assert.equal(initHotjar(), false);
    assert.equal(scripts.length, 1, 'a second call must not add a second snippet');
  });

  test('refuses a non-numeric site ID and says why', async () => {
    const { scripts } = installFakeDom('site-1234');
    const warnings: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      const { initHotjar } = await loadFresh();
      assert.equal(initHotjar(), false);
      assert.equal(scripts.length, 0);
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0][0]), /digits only/);
    } finally {
      console.warn = realWarn;
    }
  });

  test('queues identify calls made before the remote script loads', async () => {
    installFakeDom('6766543');
    const { initHotjar, identifyHotjarUser } = await loadFresh();
    initHotjar();
    const sent = identifyHotjarUser({ id: 'usr_42', role: 'developer', organizationId: 'org_7' });
    assert.equal(sent, true);
    const queued = (globalThis as any).window.hj.q;
    assert.equal(queued.length, 1);
    assert.deepEqual([...queued[0]], [
      'identify',
      'usr_42',
      { role: 'developer', organizationId: 'org_7' },
    ]);
  });

  test('identify sends the opaque id, never an email, and no-ops without one', async () => {
    installFakeDom('6766543');
    const { initHotjar, identifyHotjarUser } = await loadFresh();
    initHotjar();
    assert.equal(identifyHotjarUser(null), false);
    assert.equal(identifyHotjarUser({ id: '  ', role: 'admin', organizationId: 'o' } as any), false);
    assert.equal(((globalThis as any).window.hj.q || []).length, 0, 'no identify call may be queued');
    // A user object carrying an email must not leak it into the identify payload.
    identifyHotjarUser({ id: 'usr_9', role: 'admin', organizationId: 'org_1', email: 'a@b.com' } as any);
    const payload = JSON.stringify([...(globalThis as any).window.hj.q.at(-1)]);
    assert.equal(payload.includes('a@b.com'), false, 'email must never reach Hotjar');
    assert.equal(payload.includes('usr_9'), true);
  });

  test('picks up a site ID that arrives after the module was imported', async () => {
    // The load-order case: next/script beforeInteractive is not guaranteed to have run by the time
    // this module's chunk evaluates, so the ID must be read at call time, not latched at import.
    const { scripts } = installFakeDom('');
    const { initHotjar, isHotjarEnabled } = await loadFresh();
    assert.equal(isHotjarEnabled(), false, 'blank before runtime-config.js runs');

    (globalThis as any).window.__APP_CONFIG__ = { hotjarSiteId: '6766543' };

    assert.equal(isHotjarEnabled(), true, 'must see the late config');
    assert.equal(initHotjar(), true);
    assert.equal(scripts[0].src, 'https://static.hotjar.com/c/hotjar-6766543.js?sv=6');
  });

  test('identify no-ops when Hotjar was never initialised', async () => {
    installFakeDom('6766543');
    const { identifyHotjarUser } = await loadFresh();
    assert.equal(identifyHotjarUser({ id: 'usr_1', role: 'dev', organizationId: 'o' }), false);
  });
});
