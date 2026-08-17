import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { Meter } from '../src/meter.ts';
import { EMPTY_LIMITS, type LimitSpec } from '../src/types.ts';

/** Mid-day UTC so day and month rollovers are unambiguous. */
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function harness(): { meter: Meter; advance: (ms: number) => void; setTo: (t: number) => void } {
  let now = T0;
  const meter = new Meter(() => now);
  return {
    meter,
    advance: (ms) => {
      now += ms;
    },
    setTo: (t) => {
      now = t;
    },
  };
}

function limits(partial: Partial<LimitSpec>): LimitSpec {
  return { ...EMPTY_LIMITS, ...partial };
}

describe('Meter — request limits', () => {
  it('trips rps at the threshold and recovers when the second rolls', () => {
    const { meter, advance } = harness();
    const l = limits({ rps: 1 });

    assert.equal(meter.check(l).ok, true, 'first request should pass');
    meter.record({ requests: 1 });

    const blocked = meter.check(l);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.blockedBy, 'rps');
    assert.match(blocked.reason ?? '', /rps limit reached \(1\/1 last 1s\)/);
    assert.ok((blocked.retryAfterMs ?? 0) > 0 && (blocked.retryAfterMs ?? 0) <= SECOND);

    advance(SECOND);
    assert.equal(meter.check(l).ok, true, 'window rolled, should pass again');
  });

  it('counts rpm across the whole minute, not per second', () => {
    const { meter, advance } = harness();
    const l = limits({ rpm: 5 });

    for (let i = 0; i < 5; i++) {
      assert.equal(meter.check(l).ok, true, `request ${i + 1} of 5 should pass`);
      meter.record({ requests: 1 });
      advance(2 * SECOND); // spread out; rpm must not forget them
    }

    const blocked = meter.check(l);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.blockedBy, 'rpm');

    // 10s have already elapsed; the oldest request leaves the window at t+60s.
    advance(50 * SECOND);
    assert.equal(meter.check(l).ok, true, 'oldest request aged out');
  });

  it('rolling windows expire the oldest bucket first, not all at once', () => {
    const { meter, advance } = harness();
    const l = limits({ rpm: 2 });

    meter.record({ requests: 1 });
    advance(30 * SECOND);
    meter.record({ requests: 1 });

    assert.equal(meter.check(l).ok, false, 'both requests still in window');

    advance(31 * SECOND); // first request now 61s old, second only 31s
    assert.equal(meter.check(l).ok, true, 'room for exactly one more');
    meter.record({ requests: 1 });
    assert.equal(meter.check(l).ok, false, 'and no more than one');
  });
});

describe('Meter — token limits', () => {
  it('rejects a request whose projected tokens would exceed tpm', () => {
    const { meter } = harness();
    const l = limits({ tpm: 1000 });

    meter.record({ requests: 1, tokens: 900 });

    assert.equal(meter.check(l, 50).ok, true, '900 + 50 fits under 1000');
    const blocked = meter.check(l, 200);
    assert.equal(blocked.ok, false, '900 + 200 exceeds 1000');
    assert.equal(blocked.blockedBy, 'tpm');
  });

  it('addTokens lands late usage from a stream into the same window', () => {
    const { meter } = harness();
    const l = limits({ tpm: 100 });

    meter.record({ requests: 1 }); // stream started, usage unknown
    assert.equal(meter.check(l, 0).ok, true);

    meter.addTokens(120); // final SSE chunk finally reported usage
    assert.equal(meter.check(l, 0).ok, false, 'late tokens still count against tpm');
  });

  it('ignores non-positive late usage', () => {
    const { meter } = harness();
    meter.addTokens(0);
    meter.addTokens(-5);
    assert.equal(meter.used('tpm'), 0);
  });
});

describe('Meter — calendar windows', () => {
  it('resets rpd at UTC midnight, not 24h after the last call', () => {
    const { meter, setTo } = harness();
    const l = limits({ rpd: 3 });

    for (let i = 0; i < 3; i++) meter.record({ requests: 1 });
    assert.equal(meter.check(l).ok, false);
    assert.equal(meter.check(l).blockedBy, 'rpd');

    // 23:59 the same UTC day — still blocked even though ~12h passed.
    setTo(Date.UTC(2026, 0, 15, 23, 59, 0));
    assert.equal(meter.check(l).ok, false, 'same UTC day, still blocked');

    setTo(Date.UTC(2026, 0, 16, 0, 0, 1));
    assert.equal(meter.check(l).ok, true, 'new UTC day, quota refilled');
  });

  it('resets tpmo on the first of the month', () => {
    const { meter, setTo } = harness();
    const l = limits({ tpmo: 1000 });

    meter.record({ requests: 1, tokens: 1000 });
    assert.equal(meter.check(l, 1).ok, false);

    setTo(Date.UTC(2026, 0, 31, 23, 59, 59));
    assert.equal(meter.check(l, 1).ok, false, 'still January');

    setTo(Date.UTC(2026, 1, 1, 0, 0, 1));
    assert.equal(meter.check(l, 1).ok, true, 'February, counter rolled');
  });

  it('reports retryAfterMs as time until the calendar boundary', () => {
    const { meter } = harness();
    const l = limits({ rpd: 1 });
    meter.record({ requests: 1 });

    const res = meter.check(l);
    assert.equal(res.ok, false);
    const expected = Date.UTC(2026, 0, 16, 0, 0, 0) - T0; // 12h
    assert.equal(res.retryAfterMs, expected);
  });
});

describe('Meter — credits (Cloudflare neurons)', () => {
  it('spends creditsPerRequest against creditsPerDay', () => {
    const { meter } = harness();
    const l = limits({ creditsPerDay: 100, creditsPerRequest: 10 });

    for (let i = 0; i < 10; i++) {
      assert.equal(meter.check(l).ok, true, `request ${i + 1} should fit`);
      meter.record({ requests: 1, credits: 10 });
    }

    const blocked = meter.check(l);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.blockedBy, 'creditsPerDay');
  });

  it('projects the credit cost before spending it, not after', () => {
    const { meter } = harness();
    const l = limits({ creditsPerDay: 15, creditsPerRequest: 10 });

    meter.record({ requests: 1, credits: 10 });
    // 10 used, 10 more would be 20 > 15. Being conservative here is the whole
    // point: failing over is free, a 429 is not.
    assert.equal(meter.check(l).ok, false);
  });
});

describe('Meter — multiple limits', () => {
  it('reports the blocker you have to wait longest for', () => {
    const { meter } = harness();
    const l = limits({ rps: 1, rpd: 1 });
    meter.record({ requests: 1 });

    const res = meter.check(l);
    assert.equal(res.ok, false);
    // rps frees in <1s, rpd not until midnight — the honest answer is rpd.
    assert.equal(res.blockedBy, 'rpd');
  });

  it('treats null limits as unmetered', () => {
    const { meter } = harness();
    const l = limits({}); // every field null
    for (let i = 0; i < 10_000; i++) meter.record({ requests: 1, tokens: 5000 });
    assert.equal(meter.check(l, 1_000_000).ok, true);
  });
});

describe('Meter — bars', () => {
  it('only reports limits the provider actually declares', () => {
    const { meter } = harness();
    const l = limits({ rps: 1, tpmo: 1000 });
    meter.record({ requests: 1, tokens: 250 });

    const bars = meter.bars(l);
    assert.deepEqual(
      bars.map((b) => b.key).sort(),
      ['rps', 'tpmo'],
      'no bars for undeclared limits',
    );

    const tpmo = bars.find((b) => b.key === 'tpmo');
    assert.ok(tpmo);
    assert.equal(tpmo.used, 250);
    assert.equal(tpmo.limit, 1000);
    assert.equal(tpmo.pct, 25);
    assert.equal(tpmo.window, 'this month (UTC)');
    assert.equal(tpmo.resetsAt, Date.UTC(2026, 1, 1, 0, 0, 0));
  });

  it('clamps pct at 100 when a provider reports more usage than we predicted', () => {
    const { meter } = harness();
    const l = limits({ tpm: 100 });
    meter.addTokens(450);
    const bar = meter.bars(l)[0];
    assert.ok(bar);
    assert.equal(bar.pct, 100);
    assert.equal(bar.used, 450, 'raw count stays honest even when the bar saturates');
  });

  it('leaves rolling windows without a reset time', () => {
    const { meter } = harness();
    const bar = meter.bars(limits({ rpm: 10 }))[0];
    assert.ok(bar);
    assert.equal(bar.resetsAt, null);
    assert.equal(bar.window, 'last 60s');
  });
});

describe('Meter — persistence', () => {
  it('round-trips daily counters through a snapshot', () => {
    const a = harness();
    const l = limits({ rpd: 5, tpmo: 10_000 });
    a.meter.record({ requests: 3, tokens: 4000 });

    const restored = new Meter(() => T0);
    restored.restore(a.meter.snapshot());

    assert.equal(restored.used('rpd'), 3);
    assert.equal(restored.used('tpmo'), 4000);
    assert.equal(restored.check(l).ok, true);

    restored.record({ requests: 2 });
    assert.equal(restored.check(l).ok, false, 'restored count contributes to the ceiling');
  });

  it('round-trips rolling counters too', () => {
    const a = harness();
    a.meter.record({ requests: 4 });

    const restored = new Meter(() => T0);
    restored.restore(a.meter.snapshot());
    assert.equal(restored.used('rpm'), 4);
  });

  it('a restored daily counter still expires on the next UTC day', () => {
    const a = harness();
    a.meter.record({ requests: 9 });
    const snap = a.meter.snapshot();

    const nextDay = Date.UTC(2026, 0, 16, 9, 0, 0);
    const restored = new Meter(() => nextDay);
    restored.restore(snap);
    assert.equal(restored.used('rpd'), 0, 'yesterday should not count against today');
  });
});
