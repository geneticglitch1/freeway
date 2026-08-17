import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ContextStore } from '../src/context/store.ts';
import { ContextTooLargeError, describeRefit, refit, type RefitMessage } from '../src/context/refit.ts';
import { Tokenizer, textOf } from '../src/context/tokenizer.ts';

const OPTS = { contextWindow: 8192, reserveOutputTokens: 1024, maxTurns: 12 };

/** ~n tokens of filler at the chars/4 baseline. */
function filler(tokens: number): string {
  return 'word '.repeat(Math.ceil((tokens * 4) / 5));
}

function convo(turns: number, tokensPerTurn: number): RefitMessage[] {
  const out: RefitMessage[] = [{ role: 'system', content: 'You are a careful assistant.' }];
  for (let i = 0; i < turns; i++) {
    out.push({ role: 'user', content: `Q${i}: ${filler(tokensPerTurn)}` });
    out.push({ role: 'assistant', content: `A${i}: ${filler(tokensPerTurn)}` });
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('Tokenizer — an estimate that learns', () => {
  it('starts at the chars/4 baseline', () => {
    assert.equal(Tokenizer.baseline('a'.repeat(400)), 100);
  });

  it('converges on what the provider actually reports', () => {
    const tk = new Tokenizer();
    const text = 'a'.repeat(4000); // baseline says 1000
    assert.equal(tk.estimate(text, 'm'), 1000);

    // The provider consistently says 1500 — the estimator should move to it.
    for (let i = 0; i < 40; i++) tk.learn('m', text, 1500);
    const learned = tk.estimate(text, 'm');
    assert.ok(learned > 1400 && learned <= 1550, `expected ~1500, got ${learned}`);
    assert.equal(tk.ratio('m')?.samples, 40);
  });

  it('keeps ratios per model', () => {
    const tk = new Tokenizer();
    const text = 'a'.repeat(4000);
    for (let i = 0; i < 30; i++) {
      tk.learn('verbose', text, 1600);
      tk.learn('terse', text, 700);
    }
    assert.ok(tk.estimate(text, 'verbose') > tk.estimate(text, 'terse'));
  });

  it('ignores an absurd report rather than poisoning the ratio', () => {
    const tk = new Tokenizer();
    const text = 'a'.repeat(4000);
    tk.learn('m', text, 1_000_000);
    assert.equal(tk.ratio('m'), undefined, 'a 1000x factor is a bug, not evidence');
  });

  it('charges for images without counting the data URI as prose', () => {
    const withImage = textOf([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(50_000)}` } },
    ]);
    const tk = new Tokenizer();
    const tokens = tk.estimate(withImage);
    assert.ok(tokens > 500 && tokens < 2000, `expected a flat image charge, got ${tokens}`);
  });

  it('round-trips through a snapshot', () => {
    const tk = new Tokenizer();
    const text = 'a'.repeat(4000);
    for (let i = 0; i < 10; i++) tk.learn('m', text, 1500);

    const restored = new Tokenizer();
    restored.restore(tk.snapshot());
    assert.equal(restored.estimate(text, 'm'), tk.estimate(text, 'm'));
  });
});

// ---------------------------------------------------------------------------

describe('refit — the escalation ladder', () => {
  it('1. passes through untouched when it already fits', async () => {
    const messages = convo(2, 50);
    const result = await refit(messages, OPTS);

    assert.equal(result.strategy, 'passthrough');
    assert.deepEqual(result.messages, messages);
    assert.equal(result.dropped, 0);
  });

  it('2. clears stale tool results before dropping any turns', async () => {
    // Old tool output has usually been absorbed into later reasoning already,
    // so it is the cheapest thing in a context to give up.
    const messages: RefitMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: filler(3000) },
      { role: 'assistant', content: 'it says hello' },
      { role: 'user', content: 'thanks' },
    ];
    const result = await refit(messages, { ...OPTS, contextWindow: 2048, reserveOutputTokens: 256 });

    assert.equal(result.strategy, 'drop-tool-noise');
    assert.equal(result.messages.length, messages.length, 'no turn was dropped');
    assert.match(textOf(result.messages[3]?.content), /cleared/);
    assert.ok(result.tokensAfter < result.tokensBefore);
  });

  it('3. windows to the system message, the first turn and the tail', async () => {
    const result = await refit(convo(40, 100), { ...OPTS, contextWindow: 4096, reserveOutputTokens: 512, maxTurns: 4 });

    assert.ok(['window', 'compact', 'hard-truncate'].includes(result.strategy));
    assert.equal(result.messages[0]?.role, 'system', 'the system message always survives');
    assert.ok(result.tokensAfter <= 4096 - 512);
    assert.ok(result.messages.length < 81);
  });

  it('4. compacts the dropped middle when a summariser is available', async () => {
    let asked = 0;
    const result = await refit(convo(40, 100), {
      ...OPTS,
      contextWindow: 4096,
      reserveOutputTokens: 512,
      maxTurns: 4,
      summarize: async (dropped, budget) => {
        asked += 1;
        assert.ok(dropped.length > 0);
        assert.ok(budget > 0);
        return 'Earlier: the user asked 30-odd questions and got answers.';
      },
    });

    assert.equal(asked, 1);
    assert.equal(result.strategy, 'compact');
    assert.equal(result.summaries, 1);
    assert.ok(result.messages.some((m) => textOf(m.content).startsWith('Summary of the earlier conversation:')));
    assert.ok(result.tokensAfter <= 4096 - 512);
  });

  it('4. discards a summary that came back longer than its input', async () => {
    // A model asked to compress returning something bigger is a documented
    // failure mode; the ladder must escalate rather than loop or accept it.
    const result = await refit(convo(40, 100), {
      ...OPTS,
      contextWindow: 4096,
      reserveOutputTokens: 512,
      maxTurns: 4,
      summarize: async () => filler(50_000),
    });

    assert.notEqual(result.strategy, 'compact');
    assert.equal(result.strategy, 'hard-truncate');
    assert.ok(result.tokensAfter <= 4096 - 512);
  });

  it('4. escalates when the summariser fails outright', async () => {
    const result = await refit(convo(40, 100), {
      ...OPTS,
      contextWindow: 4096,
      reserveOutputTokens: 512,
      maxTurns: 4,
      summarize: async () => null,
    });
    assert.equal(result.strategy, 'hard-truncate');
  });

  it('5. always terminates, with no summariser and a brutal window', async () => {
    const result = await refit(convo(60, 200), { ...OPTS, contextWindow: 1024, reserveOutputTokens: 256 });
    assert.equal(result.strategy, 'hard-truncate');
    assert.ok(result.tokensAfter <= 1024 - 256 + 50, `over budget: ${result.tokensAfter}`);
    assert.ok(result.messages.length > 0, 'something always goes out');
  });

  it('never splits a tool call from its result', async () => {
    const messages: RefitMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 15; i++) {
      messages.push({ role: 'user', content: `q${i} ${filler(80)}` });
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'f', arguments: '{}' } }] });
      messages.push({ role: 'tool', tool_call_id: `t${i}`, content: `r${i} ${filler(80)}` });
      messages.push({ role: 'assistant', content: `a${i}` });
    }

    const result = await refit(messages, { ...OPTS, contextWindow: 4096, reserveOutputTokens: 512, maxTurns: 3 });

    // Every surviving tool reply must still have its assistant call before it.
    for (let i = 0; i < result.messages.length; i++) {
      if (result.messages[i]?.role !== 'tool') continue;
      const prior = result.messages.slice(0, i).reverse().find((m) => m.role === 'assistant');
      assert.ok(prior, `orphaned tool result at index ${i}`);
    }
  });

  it('refuses a single message that cannot fit at all, rather than mangling it', async () => {
    // Silently truncating the user's actual question is worse than failing.
    const messages: RefitMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: filler(50_000) },
    ];
    await assert.rejects(
      () => refit(messages, { ...OPTS, contextWindow: 4096, reserveOutputTokens: 512 }),
      (err: unknown) => {
        assert.ok(err instanceof ContextTooLargeError);
        assert.ok(err.required > err.available);
        assert.match(err.message, /needs ~\d+ tokens but only \d+ are available/);
        return true;
      },
    );
  });

  it('records the rungs it climbed', async () => {
    const result = await refit(convo(40, 100), { ...OPTS, contextWindow: 4096, reserveOutputTokens: 512, maxTurns: 4, summarize: async () => 'brief.' });
    assert.deepEqual(result.trail, ['passthrough', 'drop-tool-noise', 'window', 'compact']);
    assert.match(describeRefit(result), /refit=compact tokens=\d+->\d+ kept=\d+/);
  });
});

// ---------------------------------------------------------------------------

describe('the scenario: 128k model runs dry, 8k model takes over', () => {
  it('keeps the conversation alive across the failover', async () => {
    // A long thread that fits comfortably in mistral's 128k window.
    const history = convo(60, 300);

    const onBig = await refit(history, { contextWindow: 128_000, reserveOutputTokens: 1024, maxTurns: 12 });
    assert.equal(onBig.strategy, 'passthrough', 'no reshaping needed at 128k');

    // Provider exhausted; the router fails over to @cf/meta/llama-3.1-8b-instruct.
    const onSmall = await refit(history, {
      contextWindow: 8192,
      reserveOutputTokens: 1024,
      maxTurns: 8,
      summarize: async () => 'Earlier the user worked through 50-odd questions about the project; decisions and open items are preserved.',
    });

    assert.equal(onSmall.strategy, 'compact');
    assert.ok(onSmall.tokensAfter <= 8192 - 1024, `must fit the smaller window, got ${onSmall.tokensAfter}`);
    assert.ok(onSmall.tokensBefore > 8192, 'and it genuinely did not fit before');

    // The parts that matter survived.
    assert.equal(onSmall.messages[0]?.role, 'system');
    assert.ok(onSmall.messages.some((m) => textOf(m.content).includes('Summary of the earlier conversation')));
    const last = onSmall.messages[onSmall.messages.length - 1];
    assert.ok(last, 'the newest turn is still there');
    assert.ok(textOf(last.content).includes('A59') || textOf(last.content).includes('Q59'));

    assert.match(describeRefit(onSmall), /refit=compact/);
  });
});

// ---------------------------------------------------------------------------

describe('ContextStore', () => {
  const store = () => new ContextStore(':memory:');

  it('appends and replays a conversation in order', () => {
    const s = store();
    s.append('sess', [
      { role: 'user', content: 'hello', tokens: 2 },
      { role: 'assistant', content: 'hi', tokens: 1 },
    ]);
    s.append('sess', [{ role: 'user', content: 'again', tokens: 2 }]);

    const messages = s.messages('sess');
    assert.deepEqual(messages.map((m) => m.content), ['hello', 'hi', 'again']);
    assert.deepEqual(messages.map((m) => m.seq), [0, 1, 2]);
    s.close();
  });

  it('preserves non-content fields like tool_calls', () => {
    const s = store();
    const extra = JSON.stringify({ tool_calls: [{ id: 't1' }] });
    s.append('sess', [{ role: 'assistant', content: '', extra, tokens: 1 }]);
    assert.equal(s.messages('sess')[0]?.extra, extra);
    s.close();
  });

  it('caches a summary by the exact range it covers', () => {
    // Re-compacting the same span is the most expensive thing this engine does,
    // so it must happen once per range and never again.
    const s = store();
    s.putSummary('sess', 0, 40, 'the gist', 12, 'mistral-small');

    const hit = s.getSummary('sess', 0, 40);
    assert.equal(hit?.content, 'the gist');
    assert.equal(s.getSummary('sess', 0, 41), null, 'a different range is a different summary');
    s.close();
  });

  it('reports session totals for the dashboard', () => {
    const s = store();
    s.append('sess', [
      { role: 'user', content: 'a', tokens: 10 },
      { role: 'assistant', content: 'b', tokens: 20 },
    ]);
    s.putSummary('sess', 0, 1, 'x', 3, 'm');

    const info = s.info('sess');
    assert.equal(info?.messages, 2);
    assert.equal(info?.tokens, 30);
    assert.equal(info?.summaries, 1);
    assert.equal(s.list().length, 1);
    s.close();
  });

  it('deletes a session and everything under it', () => {
    const s = store();
    s.append('sess', [{ role: 'user', content: 'a', tokens: 1 }]);
    s.putSummary('sess', 0, 0, 'x', 1, 'm');

    s.delete('sess');
    assert.equal(s.info('sess'), null);
    assert.equal(s.messages('sess').length, 0);
    assert.equal(s.summaries('sess').length, 0);
    s.close();
  });

  it('keeps sessions isolated from each other', () => {
    const s = store();
    s.append('a', [{ role: 'user', content: 'for a', tokens: 1 }]);
    s.append('b', [{ role: 'user', content: 'for b', tokens: 1 }]);
    assert.equal(s.messages('a').length, 1);
    assert.equal(s.messages('b')[0]?.content, 'for b');
    s.close();
  });
});
