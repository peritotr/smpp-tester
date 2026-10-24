// Load test performance analysis. The same code runs in the browser (report page) and in Node (archive summary).
// Input: report { test, series[], events[], totals, vendor? }. Draws conclusions from per-second rows.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SmppAnalysis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Translation hook: uses I18N in the browser, plain English templates in Node
  const fill = (s, p) => p ? String(s).replace(/\{(\w+)\}/g, (m, k) => p[k] !== undefined ? p[k] : m) : String(s);
  const t = (s, p) => (typeof I18N !== 'undefined' ? I18N.t(s, p) : fill(s, p));
  const locale = () => (typeof I18N !== 'undefined' ? I18N.locale : 'en-US');
  const median = a => { const v = a.filter(x => x != null && !isNaN(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const mean = a => { const v = a.filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const maxOf = a => { const v = a.filter(x => x != null && !isNaN(x)); return v.length ? Math.max(...v) : null; };
  const sum = a => a.reduce((s, x) => s + (x || 0), 0);
  const r0 = n => n == null ? '—' : Math.round(n).toLocaleString(locale());
  const r1 = n => n == null ? '—' : (n < 10 ? n.toFixed(1) : Math.round(n).toString());
  const mmss = t => { t = Math.max(0, Math.round(t)); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

  // Index of the first row where `cond` holds for at least `need` consecutive seconds
  function firstSustained(rows, cond, need) {
    let run = 0;
    for (let i = 0; i < rows.length; i++) { if (cond(rows[i], i)) { if (++run >= need) return i - need + 1; } else run = 0; }
    return -1;
  }

  function linreg(xs, ys) {
    const n = xs.length; if (n < 5) return null;
    const mx = mean(xs), my = mean(ys); let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    return den ? num / den : null;
  }

  function analyze(rep) {
    const test = rep.test || {}, T = rep.totals || {}, crit = test.criteria || {};
    const all = (rep.series || []).filter(r => r && r.t != null);
    const active = all.filter(r => r.sentTps > 0 || r.target > 0);
    const out = { findings: [], criteria: [], steps: null, curve: [], baseline: null, onset: null, e2eOnset: null, saturation: null, capacity: null, steady: null, causes: [] };
    if (!active.length) { out.findings.push({ level: 'bad', text: t('Nothing was sent during the test; there is no data to analyse.') }); return out; }

    const hasE2e = active.some(r => r.e2eP95 != null);
    const tpsTarget = Number(test.tps) || maxOf(active.map(r => r.target)) || 0;

    // ---------- Baseline latency: the first, lightly loaded seconds of the test ----------
    const lowLoad = active.filter(r => r.p95 != null && r.sentTps > 0);
    const firstN = lowLoad.slice(0, Math.max(5, Math.ceil(lowLoad.length * 0.15)));
    // In a step test the first step is the baseline
    const baseRows = test.steps ? lowLoad.filter(r => r.step === 1).slice(2) : firstN.slice(1);
    const baseSrc = baseRows.length >= 3 ? baseRows : firstN;
    const base = { p50: median(baseSrc.map(r => r.p50)), p95: median(baseSrc.map(r => r.p95)), p99: median(baseSrc.map(r => r.p99)), tps: median(baseSrc.map(r => r.okTps)),
      e2eP95: hasE2e ? median(baseSrc.map(r => r.e2eP95)) : null };
    out.baseline = base;

    // Threshold: 2× baseline and at least +20 ms (or the user's criterion if lower)
    const thr = b => b == null ? null : Math.max(b * 2, b + 20);
    const p95Lim = crit.p95Max ? Math.min(thr(base.p95) ?? Infinity, Number(crit.p95Max)) : thr(base.p95);
    const startIdx = Math.min(3, Math.max(0, active.length - 3));
    const scan = active.slice(startIdx);

    // ---------- Latency onset ----------
    if (p95Lim != null) {
      const i = firstSustained(scan, r => r.p95 != null && r.p95 > p95Lim, 3);
      if (i >= 0) {
        const r = scan[i], win = scan.slice(Math.max(0, i - 3), i);
        out.onset = { t: r.t, tps: median(win.map(x => x.okTps)) ?? r.okTps, target: r.target, p95: r.p95, base: base.p95, limit: p95Lim, step: r.step };
      }
    }
    if (hasE2e && base.e2eP95 != null) {
      const lim = crit.e2eP95Max ? Math.min(thr(base.e2eP95), Number(crit.e2eP95Max)) : thr(base.e2eP95);
      const i = firstSustained(scan, r => r.e2eP95 != null && r.e2eP95 > lim, 3);
      if (i >= 0) { const r = scan[i]; out.e2eOnset = { t: r.t, tps: r.okTps, p95: r.e2eP95, base: base.e2eP95, limit: lim, step: r.step }; }
    }

    // ---------- Saturation: accepted TPS stays below 90% of the target ----------
    const sendRows = active.filter(r => r.target > 0);
    // Only seconds where the target is flat (not ramp-up or a step change): accepted TPS lags the target by ~half a second
    const stable = (r, i, arr) => i > 0 && Math.abs(r.target - arr[i - 1].target) <= Math.max(1, r.target * 0.02);
    const sr1 = sendRows.slice(1);
    const si = firstSustained(sr1, (r, i) => stable(r, i, sr1) && r.okTps < 0.9 * r.target && r.target >= 10, 3);
    if (si >= 0) {
      const r = sendRows[si + 1], win = sendRows.slice(si + 1, si + 6);
      const thrS = sum(win.map(x => x.thrTps)), wf = mean(win.map(x => x.windowFull)), lost = win.some(x => x.bound != null && x.bound < (test.sessions || 0));
      let cause;
      if (thrS > 0) cause = 'throttle';
      else if (lost) cause = 'sessions';
      else if (wf > 0.3) cause = 'backpressure';
      else if (sum(win.map(x => x.errTps)) > 0) cause = 'errors';
      else cause = 'client';
      out.saturation = { t: r.t, ok: median(win.map(x => x.okTps)), target: r.target, cause, step: r.step };
    }

    // ---------- Capacity: best 10-second average of accepted TPS ----------
    let best = null;
    for (let i = 0; i + 10 <= active.length; i++) {
      const w = active.slice(i, i + 10), ok = mean(w.map(r => r.okTps));
      if (!best || ok > best.ok) best = { ok, t: w[0].t, p95: median(w.map(r => r.p95)), p99: median(w.map(r => r.p99)) };
    }
    if (!best) best = { ok: maxOf(active.map(r => r.okTps)), t: active[0].t, p95: median(active.map(r => r.p95)), p99: median(active.map(r => r.p99)) };
    out.capacity = best;

    // ---------- Steady state: from reaching the target until sending stops ----------
    const full = sendRows.filter(r => r.target >= tpsTarget * 0.99 && !(test.steps && r.step && r.step < (test.steps.length || 0)));
    const steadyRows = (full.length >= 5 ? full.slice(2) : sendRows.slice(Math.min(3, sendRows.length - 1)));
    if (steadyRows.length >= 3) {
      const oks = steadyRows.map(r => r.okTps), m = mean(oks), sd = Math.sqrt(mean(oks.map(x => (x - m) ** 2)));
      const slope = linreg(steadyRows.map(r => r.t / 60), steadyRows.map(r => r.p95 ?? 0));
      out.steady = { from: steadyRows[0].t, to: steadyRows.at(-1).t, ok: m, cv: m ? sd / m * 100 : 0, p50: median(steadyRows.map(r => r.p50)), p95: median(steadyRows.map(r => r.p95)), p99: median(steadyRows.map(r => r.p99)),
        e2eP95: hasE2e ? median(steadyRows.map(r => r.e2eP95)) : null, driftPerMin: slope, minutes: (steadyRows.at(-1).t - steadyRows[0].t) / 60,
        p95First: median(steadyRows.slice(0, Math.max(3, steadyRows.length >> 3)).map(r => r.p95)), p95Last: median(steadyRows.slice(-Math.max(3, steadyRows.length >> 3)).map(r => r.p95)) };
    }

    // ---------- Step table (step test) ----------
    if (test.steps && test.steps.length) {
      out.steps = test.steps.map((tgt, k) => {
        const rows = sendRows.filter(r => r.step === k + 1);
        // The first seconds of a step are settling time: drop 2 (long steps) or 1 (short); the median resists single outliers
        const settled = rows.length > 4 ? rows.slice(2) : rows.length > 1 ? rows.slice(1) : rows;
        const ok = median(settled.map(r => r.okTps)), p95 = median(settled.map(r => r.p95)), p99 = maxOf(settled.map(r => r.p99));
        const e2e = hasE2e ? median(settled.map(r => r.e2eP95)) : null;
        const thrN = sum(rows.map(r => r.thrTps)), errN = sum(rows.map(r => r.errTps)), wf = mean(rows.map(r => r.windowFull));
        let status = 'ok';
        if (!rows.length) status = 'none';
        else if (ok != null && ok < 0.95 * tgt) status = 'saturated';
        else if (p95 != null && p95Lim != null && p95 > p95Lim) status = 'latency';
        else if (thrN > 0 || errN > 0) status = 'warning';
        return { step: k + 1, target: tgt, ok, p50: median(settled.map(r => r.p50)), p95, p99, e2e, thr: thrN, err: errN, windowFull: wf, status };
      });
      const knee = out.steps.find(s => s.status === 'latency' || s.status === 'saturated');
      const lastGood = [...out.steps].reverse().find(s => s.status === 'ok' && (!knee || s.step < knee.step));
      out.knee = knee || null; out.lastGood = lastGood || null;
    }

    // ---------- Latency vs. TPS curve ----------
    const mx = maxOf(active.map(r => r.okTps)) || 0;
    if (mx > 0) {
      const nb = 12, w = mx / nb;
      for (let b = 0; b < nb; b++) {
        const rows = active.filter(r => r.okTps > b * w && r.okTps <= (b + 1) * w + 1e-9 && r.p95 != null);
        if (rows.length) out.curve.push({ tps: median(rows.map(r => r.okTps)), p50: median(rows.map(r => r.p50)), p95: median(rows.map(r => r.p95)), p99: median(rows.map(r => r.p99)), e2e: hasE2e ? median(rows.map(r => r.e2eP95)) : null, n: rows.length });
      }
    }

    // ---------- Acceptance criteria ----------
    const sent = T.sent || 0, errRate = sent ? (T.err || 0) / sent * 100 : 0;
    const vE2e = rep.vendor && rep.vendor.e2e, loss = vE2e && T.ok ? Math.max(0, T.ok - vE2e.n) / T.ok * 100 : null;
    const L = T.lat || {};
    const add = (name, ok, val, lim) => out.criteria.push({ name, ok, val, lim });
    if (crit.p95Max) add(t('Response p95'), (L.p95 ?? 0) <= crit.p95Max, `${r1(L.p95)} ms`, `≤ ${crit.p95Max} ms`);
    if (crit.p99Max) add(t('Response p99'), (L.p99 ?? 0) <= crit.p99Max, `${r1(L.p99)} ms`, `≤ ${crit.p99Max} ms`);
    if (crit.e2eP95Max && vE2e && vE2e.total) add(t('End-to-end p95'), (vE2e.total.p95 ?? 0) <= crit.e2eP95Max, `${r1(vE2e.total.p95)} ms`, `≤ ${crit.e2eP95Max} ms`);
    if (crit.errMaxPct != null && crit.errMaxPct !== '') add(t('Error rate'), errRate <= crit.errMaxPct, `${errRate.toFixed(3)}%`, `≤ ${crit.errMaxPct}%`);
    if (crit.lossMaxPct != null && crit.lossMaxPct !== '' && loss != null) add(t('Loss'), loss <= crit.lossMaxPct, `${loss.toFixed(3)}%`, `≤ ${crit.lossMaxPct}%`);
    if (crit.minTps) { const v = out.steady ? out.steady.ok : best.ok; add(t('Sustained TPS'), v >= crit.minTps * 0.98, `${r0(v)} TPS`, `≥ ${r0(crit.minTps)} TPS`); }
    out.verdict = out.criteria.length ? (out.criteria.every(c => c.ok) ? 'pass' : 'fail') : null;

    // ---------- Findings (plain-language sentences) ----------
    const F = (level, text) => out.findings.push({ level, text });
    const ev = rep.events || [];
    const CAUSE = {
      throttle: 'throttle: the platform hit the customer TPS limit',
      sessions: 'session loss: some binds dropped',
      backpressure: 'backpressure: platform responses slowed down and the window filled up',
      errors: 'errors: the platform is rejecting submit_sm',
      client: 'the test server could not send at the target rate (CPU or network)',
    };
    if (out.saturation) out.saturation.causeText = t(CAUSE[out.saturation.cause] || out.saturation.cause);
    if (out.steps && out.knee) {
      F('warn', out.knee.status === 'saturated'
        ? t('Platform is clean up to {good} TPS; it saturated at the {knee} TPS step (accepted {ok} TPS).', { good: r0(out.lastGood ? out.lastGood.target : 0), knee: r0(out.knee.target), ok: r0(out.knee.ok) })
        : t('Platform is clean up to {good} TPS; latency rose at the {knee} TPS step (p95 {p95} ms, baseline {base} ms).', { good: r0(out.lastGood ? out.lastGood.target : 0), knee: r0(out.knee.target), p95: r1(out.knee.p95), base: r1(base.p95) }));
    } else if (out.steps) F('ok', t('All steps (up to {max} TPS) passed without a latency increase or saturation.', { max: r0(out.steps.at(-1).target) }));
    if (out.onset) {
      const where = out.onset.target && out.onset.target > out.onset.tps * 1.05
        ? t('when the target rose to {target} TPS (accepted ~{tps} TPS)', { target: r0(out.onset.target), tps: r0(out.onset.tps) })
        : t('at about {tps} TPS', { tps: r0(out.onset.tps) });
      F('warn', t('Latency started rising at {time}, {where}: p95 went from a {base} ms baseline to {p95} ms', { time: mmss(out.onset.t), where, base: r1(out.onset.base), p95: r1(out.onset.p95) })
        + (out.onset.step ? ' ' + t('(step {n})', { n: out.onset.step }) : '') + '.');
    } else F('ok', t('Response latency stayed at its baseline throughout the test (p95 ≈ {p95} ms).', { p95: r1(base.p95) }));
    if (out.e2eOnset) F('warn', t('End-to-end latency rose at {time}, at ~{tps} TPS (p95 {base} → {p95} ms): the platform accepts messages but forwards them to the vendor late.', { time: mmss(out.e2eOnset.t), tps: r0(out.e2eOnset.tps), base: r1(out.e2eOnset.base), p95: r1(out.e2eOnset.p95) }));
    if (out.saturation) F('bad', t('At {time} accepted TPS fell below the target ({ok} / {target} TPS). Likely cause: {cause}.', { time: mmss(out.saturation.t), ok: r0(out.saturation.ok), target: r0(out.saturation.target), cause: out.saturation.causeText }));
    else if (!out.steps) F('ok', t('The target rate was reached and held (best 10 s average {tps} TPS).', { tps: r0(best.ok) }));
    if (out.steady && out.steady.minutes >= 2 && out.steady.driftPerMin != null) {
      const d = out.steady.driftPerMin, rel = out.steady.p95First ? (out.steady.p95Last - out.steady.p95First) / out.steady.p95First : 0;
      if (d > 0 && rel > 0.5) F('warn', t('Latency grows over time under steady load: p95 rose ~{d} ms per minute ({from} → {to} ms). This may point to a growing queue or a resource leak.', { d: r1(d), from: r1(out.steady.p95First), to: r1(out.steady.p95Last) }));
      else F('ok', t('Latency stayed flat for {min} minutes under steady load.', { min: r1(out.steady.minutes) }));
    }
    if (out.steady && out.steady.cv > 10 && !out.saturation) F('warn', t('Accepted TPS fluctuates (variation {cv}%); the platform or network responds unevenly.', { cv: r1(out.steady.cv) }));
    if (T.throttled) F('warn', t('{n} throttle responses received (first at {time}).', { n: r0(T.throttled), time: mmss((ev.find(e => e.type === 'throttle') || {}).t || 0) }));
    if (T.timeouts) F('bad', t('{n} submit_sm never got a response (timeout).', { n: r0(T.timeouts) }));
    const bf = ev.find(e => e.type === 'bindfail');
    if (bf) F('warn', (bf.p ? t('{failed}/{total} sessions could not bind; the test continued with {ok}.', bf.p) : bf.text) + ' ' + t("Check the platform's bind limit or stale binds left from earlier runs."));
    const drops = ev.filter(e => e.type === 'session');
    if (drops.length) F('bad', t('{n} session(s) dropped during the test (first at {time}).', { n: drops.length, time: mmss(drops[0].t) }));
    const errs = Object.entries(T.errs || {}).filter(([k]) => k !== 'TIMEOUT');
    if (errs.length) F('bad', t('Error responses: {list}.', { list: errs.map(([k, v]) => `${k} × ${r0(v)}`).join(', ') }));
    if (vE2e) {
      if (loss > 0) F('bad', t('{n} messages ({pct}%) never reached the vendor.', { n: r0(T.ok - vE2e.n), pct: loss.toFixed(3) }));
      else F('ok', t('All {n} accepted messages reached the vendor.', { n: r0(T.ok) }));
      if (vE2e.dup) F('bad', t('{n} messages were delivered to the vendor more than once.', { n: r0(vE2e.dup) }));
    }
    if (T.dlrUnmatched) F('warn', t('{n} DLRs could not be matched to a sent message (the message_id format may differ).', { n: r0(T.dlrUnmatched) }));
    if (T.pendingDlr) F('warn', t('{n} messages had no DLR yet when the test ended.', { n: r0(T.pendingDlr) }));
    out.fmt = { r0, r1, mmss };
    return out;
  }

  // Short summary for the archive list
  function summary(rep) {
    const a = analyze(rep), T = rep.totals || {};
    return {
      verdict: a.verdict, capacity: a.capacity ? Math.round(a.capacity.ok) : null,
      onsetTps: a.onset ? Math.round(a.onset.tps) : null, kneeTps: a.knee ? a.knee.target : null,
      p95: T.lat && T.lat.p95, sent: T.sent, err: T.err,
      issues: a.findings.filter(f => f.level !== 'ok').length,
    };
  }

  return { analyze, summary };
});
