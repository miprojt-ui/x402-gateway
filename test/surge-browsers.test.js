import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { challengeToken, solves } from '../src/challenge.js';
import { createGateway } from '../src/index.js';

/*
 * saasrow 2026-11-25: a surge sold a pass to every visitor in every browser
 * (Tron on KDE included) for as long as the site was busy, and the default
 * trips at one page a second. Since 0.19 a browser that passed the challenge
 * today reads during a surge and does not feed it; one that has not is asked
 * to pass it; the swarm still pays the challenge on every address it uses.
 */

const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/999.0.0.0 Safari/537.36';
const SECRET = 'cp_live_test';
let n = 0;
const nextIp = () => `198.51.${(++n >> 8) & 255}.${n & 255}`;
const req = (path, { ip = nextIp(), headers = {} } = {}) =>
  new Request(`https://example.test${path}`, {
    headers: { 'user-agent': CHROME, accept: 'text/html', 'sec-fetch-mode': 'navigate', 'x-real-ip': ip, ...headers },
  });

const gw = (massScrape, extra = {}) =>
  createGateway({
    siteUrl: 'https://example.test',
    coinpay: { apiKey: SECRET, baseUrl: 'https://coinpay.test' },
    payTo: '0x1111111111111111111111111111111111111111',
    fetch: async () => new Response('{}'),
    botQuota: false,
    checkout: false,
    massScrape,
    ...extra,
  });

async function proved(ip, { cookie = 'pf_js', work = 16 } = {}) {
  const token = await challengeToken(SECRET, ip);
  for (let i = 0; ; i++) if (await solves(token, String(i), work)) return `${cookie}=${token}.${i}`;
}

async function surging(g) {
  await g.handle(req('/i/1'));
  await g.handle(req('/i/2'));
  assert.equal(g.massScrapeState().on, true);
}

describe('a surge lets proven browsers through (0.19)', () => {
  it('a browser that solved the challenge reads; one that has not is asked to, not sold a pass', async () => {
    const g = gw({ paths: ['/i/'], requests: 1, perAddress: false });
    await surging(g);
    const ip = '203.0.113.20';
    const asked = await g.handle(req('/i/3', { ip }));
    assert.equal(asked.status, 402);
    const page = await asked.text();
    assert.match(page, /Checking your browser/);
    assert.doesNotMatch(page, /being scraped in bulk/);
    assert.equal(await g.handle(req('/i/3', { ip, headers: { cookie: await proved(ip) } })), null);
  });

  it('a solved cookie is bound to its address, so a swarm cannot share one', async () => {
    const g = gw({ paths: ['/i/'], requests: 1, perAddress: false });
    await surging(g);
    const cookie = await proved('203.0.113.21');
    assert.equal((await g.handle(req('/i/3', { ip: '203.0.113.22', headers: { cookie } }))).status, 402);
  });

  it('proven browsers do not count toward the surge', async () => {
    const g = gw({ paths: ['/i/'], requests: 3, perAddress: false });
    const ip = '203.0.113.23';
    const cookie = await proved(ip);
    for (let i = 0; i < 50; i++) assert.equal(await g.handle(req(`/i/${i}`, { ip, headers: { cookie } })), null);
    assert.equal(g.massScrapeState().on, false);
  });

  it('an address reading heavily pays whatever it has proved', async () => {
    const g = gw({ paths: ['/i/'], requests: 1000, perAddress: { requests: 2, windowSeconds: 3600 } });
    const ip = '203.0.113.24';
    const cookie = await proved(ip);
    assert.equal(await g.handle(req('/i/1', { ip, headers: { cookie } })), null);
    assert.equal(await g.handle(req('/i/2', { ip, headers: { cookie } })), null);
    const res = await g.handle(req('/i/3', { ip, headers: { cookie } }));
    assert.equal(res.status, 402);
    assert.doesNotMatch(await res.text(), /Checking your browser/);
  });

  it("uses the site's own challenge (cookie name, work) when it has one", async () => {
    const g = gw({ paths: ['/i/'], requests: 1, perAddress: false }, { challenge: { paths: ['/never/'], cookie: 'site_js', work: 4 } });
    await surging(g);
    const ip = '203.0.113.25';
    assert.match(await (await g.handle(req('/i/3', { ip }))).text(), /site_js=/);
    assert.equal(await g.handle(req('/i/3', { ip, headers: { cookie: await proved(ip, { cookie: 'site_js', work: 4 }) } })), null);
  });

  it('a JSON client during a surge still gets the x402 offer', async () => {
    const g = gw({ paths: ['/i/'], requests: 1, perAddress: false });
    await surging(g);
    const res = await g.handle(req('/i/3', { headers: { accept: 'application/json' } }));
    assert.equal(res.status, 402);
    assert.ok((await res.json()).accepts.length);
  });
});
