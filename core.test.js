const test = require("node:test");
const assert = require("node:assert/strict");
const { CheckQueue, STATUS, parseList, validateUsername, classify, isFresh } = require("../public/core.js");

function env() {
  let t = 1000;
  return { now: () => t, sleep: async ms => { t += ms; }, advance: ms => { t += ms; } };
}
function make(provider, extra = {}) {
  const e = env(), calls = [];
  const wrapped = async (name, o) => { calls.push({ name, at: e.now() }); return provider(name, o, calls.length); };
  const q = new CheckQueue({ provider: wrapped, now: e.now, sleep: e.sleep, random: () => 0.5, minIntervalMs: 1000, ...extra });
  return { q, e, calls };
}
const ok = taken => async () => ({ status: 200, taken });

test("200: taken / available", async () => {
  const a = make(async n => ({ status: 200, taken: n === "taken_one" }));
  a.q.add(["taken_one", "free_one"]); await a.q.start();
  assert.equal(a.q.results.get("taken_one").status, STATUS.TAKEN);
  assert.equal(a.q.results.get("free_one").status, STATUS.AVAILABLE);
});

test("200 بدون taken لا يعتبر مستخدمًا ولا متاحًا", () => {
  assert.equal(classify({ status: 200 }).status, STATUS.UNKNOWN);
});

test("400: UNKNOWN بدون إعادة محاولة ويكمل الباقي", async () => {
  const a = make(async (n) => n === "bad_one" ? { status: 400 } : { status: 200, taken: false });
  a.q.add(["bad_one", "good_one"]); await a.q.start();
  assert.equal(a.q.results.get("bad_one").status, STATUS.UNKNOWN);
  assert.equal(a.calls.filter(c => c.name === "bad_one").length, 1);
  assert.equal(a.q.results.get("good_one").status, STATUS.AVAILABLE);
});

for (const code of [401, 403]) {
  test(`${code}: يتوقف كليًا بدون حلقة إعادة محاولة`, async () => {
    const a = make(async () => ({ status: code }));
    a.q.add(["aa", "bb", "cc"]); await a.q.start();
    assert.equal(a.calls.length, 1);
    assert.equal(a.q.state, "halted");
    assert.equal(a.q.queue.length, 2);
    assert.equal(a.q.results.get("aa").status, STATUS.UNKNOWN);
    assert.equal(a.q.resume(), false);
  });
}

test("429: ينتظر retry_after قبل الطلب التالي", async () => {
  const a = make(async (n, o, i) => i === 1 ? { status: 429, retryAfter: 5 } : { status: 200, taken: false });
  a.q.add(["aa"]); await a.q.start();
  assert.equal(a.calls.length, 2);
  assert.ok(a.calls[1].at - a.calls[0].at >= 5000);
  assert.equal(a.q.results.get("aa").status, STATUS.AVAILABLE);
});

test("429 طويل (مثل 1849 ثانية): يوقف ويعرض وقت الاستئناف ولا يرسل شيئًا", async () => {
  const events = [];
  const a = make(async () => ({ status: 429, retryAfter: 1849 }), { onEvent: e => events.push(e) });
  a.q.add(["aa", "bb"]); await a.q.start();
  assert.equal(a.q.state, "limited");
  assert.equal(a.calls.length, 1);
  assert.ok(events.some(e => e.type === "limited" && e.resumeAt - a.calls[0].at >= 1849000));
  assert.equal(a.q.resume(), false);          // قبل انتهاء الحظر
  assert.equal(a.calls.length, 1);
  assert.equal(a.q.queue.length, 2);          // ما ضاع شيء
});

test("بعد انقضاء الحظر الطويل يمكن الاستئناف", async () => {
  let blocked = true;
  const a = make(async () => blocked ? { status: 429, retryAfter: 600 } : { status: 200, taken: true });
  a.q.add(["aa"]); await a.q.start();
  assert.equal(a.q.state, "limited");
  blocked = false; a.e.advance(601000);
  assert.equal(a.q.resume(), true);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(a.q.results.get("aa").status, STATUS.TAKEN);
});

test("429 متكرر قصير: يتوقف بعد max429 بدل الحلقة اللانهائية", async () => {
  const a = make(async () => ({ status: 429, retryAfter: 1 }), { max429: 3 });
  a.q.add(["aa"]); await a.q.start();
  assert.equal(a.calls.length, 3);
  assert.equal(a.q.state, "limited");
});

test("5xx: backoff مع jitter ثم TEMPORARY_ERROR", async () => {
  const events = [];
  const a = make(async () => ({ status: 503 }), { maxAttempts: 3, onEvent: e => events.push(e) });
  a.q.add(["aa"]); await a.q.start();
  assert.equal(a.calls.length, 3);
  assert.equal(a.q.results.get("aa").status, STATUS.TEMPORARY_ERROR);
  for (const e of events.filter(e => e.type === "retry")) assert.ok(e.delay <= 1000 * 2 ** e.attempts);
});

test("خطأ شبكة: TEMPORARY_ERROR وليس TAKEN", async () => {
  const a = make(async () => { throw new Error("network"); }, { maxAttempts: 2 });
  a.q.add(["aa"]); await a.q.start();
  assert.equal(a.q.results.get("aa").status, STATUS.TEMPORARY_ERROR);
});

test("منع التكرار: نفس الاسم (حتى بحروف مختلفة أو أثناء الفحص) يفحص مرة واحدة", async () => {
  const a = make(async () => { await new Promise(r => setTimeout(r, 5)); return { status: 200, taken: false }; });
  a.q.add(["Name_x", "@name_x", "name_x"]);
  assert.equal(a.q.queue.length, 1);
  const run = a.q.start();
  await new Promise(r => setTimeout(r, 1));
  a.q.add(["name_x"]);
  await run;
  assert.equal(a.calls.length, 1);
});

test("الأسماء غير الصالحة لا تصل للمزوّد", async () => {
  const a = make(ok(false));
  a.q.add(["a", "bad..name", "UPPER ok", "valid_name"]); await a.q.start();
  assert.deepEqual(a.calls.map(c => c.name), ["valid_name"]);
  assert.equal(a.q.results.get("a").status, STATUS.INVALID_USERNAME);
  assert.equal(a.q.results.get("bad..name").status, STATUS.INVALID_USERNAME);
});

test("الحد الأدنى بين الطلبات وحد التزامن", async () => {
  let active = 0, peak = 0;
  const a = make(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 2)); active--; return { status: 200, taken: false }; }, { concurrency: 3, minIntervalMs: 1500 });
  a.q.add(["aa", "bb", "cc", "dd", "ee", "ff"]); await a.q.start();
  assert.ok(peak <= 3);
  for (let i = 1; i < a.calls.length; i++) assert.ok(a.calls[i].at - a.calls[i - 1].at >= 1500);
});

test("الإلغاء يوقف الطلبات التالية", async () => {
  const a = make(async () => { a.q.cancel(); return { status: 200, taken: false }; });
  a.q.add(["aa", "bb", "cc"]); await a.q.start();
  assert.equal(a.calls.length, 1);
  assert.equal(a.q.state, "cancelled");
  assert.equal(a.q.queue.length, 0);
});

test("Cache: لا يعيد الفحص قبل انتهاء الصلاحية ويعيده بعدها", async () => {
  const cache = new Map();
  const a = make(ok(false), { cache, ttl: 10000 });
  a.q.add(["aa"]); await a.q.start();
  const b = new CheckQueue({ provider: async () => { b.n = (b.n || 0) + 1; return { status: 200, taken: false }; }, now: a.e.now, sleep: a.e.sleep, cache, ttl: 10000, minIntervalMs: 0 });
  b.add(["aa"]); await b.start();
  assert.equal(b.n, undefined);
  a.e.advance(20000);
  b.add(["aa"]); await b.start();
  assert.equal(b.n, 1);
});

test("parseList: تنظيف، إزالة المكرر، حد أقصى", () => {
  const r = parseList("@Foo\nfoo\n\nbar\nbaz\nqux", 3);
  assert.deepEqual(r.names, ["foo", "bar", "baz"]);
  assert.equal(r.duplicates, 1); assert.equal(r.overflow, 1);
});

test("validateUsername و isFresh", () => {
  assert.equal(validateUsername("ok_name.1"), null);
  assert.ok(validateUsername("x"));
  assert.ok(validateUsername("a".repeat(33)));
  assert.ok(validateUsername("a..b"));
  assert.ok(validateUsername("ab c"));
  assert.equal(isFresh({ at: 1000 }, 2000, 5000), true);
  assert.equal(isFresh({ at: 1000 }, 9000, 5000), false);
});
