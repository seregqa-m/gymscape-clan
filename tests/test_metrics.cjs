"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { moscowDate, periodsFor, chartDays, unallocatedIntervals } = require("../site/metrics.js");

const NOW = "2026-11-21T09:00:00Z";
const MIDNIGHT = "2026-11-20T21:05:00Z";
function player(name = "alice", values = { pushUps: 100 }, extra = {}) {
  return { username: name, status: "ok", values, profile: { id: name }, ...extra };
}
function setup() {
  return {
    baseline_at: "2026-11-20T10:00:00Z", latest_at: MIDNIGHT,
    players: [{ username: "alice", id: "alice" }],
    day_references: [{ username: "alice", status: "ok", values: { pushUps: 100 },
      profile_id: "alice", captured_at: MIDNIGHT, kind: "daily", boundary_date: "2026-11-21" }],
    periods: [{ id: "total", to: MIDNIGHT, rows: [player()] }],
    history: [{ date: "2026-11-20", from: "2026-11-20T10:00:00Z", to: MIDNIGHT,
      partial: true, gap_days: 1, rows: [{ username: "alice", status: "ok", values: { pushUps: 10 }, partial: true }] }],
  };
}
const live = (values = { pushUps: 130 }, at = NOW, extra = {}) => ({
  captured_at: at, players: [player("alice", values, { captured_at: at, ...extra })],
});
const period = (data, readings, id, now = NOW) => periodsFor(data, readings, now).find((item) => item.id === id);

test("Moscow midnight is 21:00 UTC, including month and year changes", () => {
  assert.equal(moscowDate("2026-11-20T20:59:59Z"), "2026-11-20");
  assert.equal(moscowDate("2026-11-20T21:00:00Z"), "2026-11-21");
  assert.equal(moscowDate("2026-12-31T21:00:00Z"), "2027-01-01");
  assert.equal(moscowDate(null), null);
});

test("exactly three periods, current total and today's delta use separate numbers", () => {
  const periods = periodsFor(setup(), live(), NOW);
  assert.deepEqual(periods.map((item) => [item.id, item.label]), [["total", "Тотал"], ["today", "Сегодня"], ["yesterday", "Вчера"]]);
  assert.equal(periods[0].rows[0].values.pushUps, 130);
  assert.equal(periods[1].rows[0].values.pushUps, 30);
  assert.equal(periods[1].partial, false);
  assert.equal(periods[1].in_progress, true);
});

test("a noon baseline is a partial start, not lifetime daily exercise", () => {
  const data = setup();
  Object.assign(data.day_references[0], { kind: "baseline", boundary_date: null, captured_at: "2026-11-21T07:00:00Z" });
  const today = period(data, live(), "today");
  assert.equal(today.rows[0].values.pushUps, 30);
  assert.equal(today.partial, true);
  assert.equal(today.from, "2026-11-21T07:00:00Z");
});

test("a new enrollment uses each player's own starting time", () => {
  const data = setup();
  data.players.push({ username: "bob", id: "bob" });
  data.day_references.push({ username: "bob", status: "ok", values: { pushUps: 500 }, profile_id: "bob",
    captured_at: "2026-11-21T08:00:00Z", kind: "enrollment", boundary_date: null });
  const readings = live();
  readings.players.push(player("bob", { pushUps: 505 }, { captured_at: NOW }));
  const today = period(data, readings, "today");
  assert.deepEqual(today.rows.map((row) => row.values.pushUps), [30, 5]);
  assert.deepEqual(today.rows.map((row) => row.partial), [false, true]);
});

test("no live response preserves saved total and does not invent today's zero", () => {
  const periods = periodsFor(setup(), null, NOW);
  assert.equal(periods[0].rows[0].values.pushUps, 100);
  assert.equal(periods[1].available, false);
  assert.equal(periods[1].rows[0].status, "missing");
  assert.deepEqual(periods[1].rows[0].values, {});
});

test("live data from the previous Moscow day expires after midnight", () => {
  const periods = periodsFor(setup(), live(), "2026-11-21T21:00:00Z");
  assert.equal(periods[0].rows[0].values.pushUps, 100);
  assert.equal(periods[1].available, false);
});

test("individual readings crossing midnight are unknown even if batch ended today", () => {
  const readings = live();
  readings.players[0].captured_at = "2026-11-20T20:59:59Z";
  assert.equal(period(setup(), readings, "today").rows[0].status, "missing");
});

test("old midnight boundary cannot be used to label a multi-day delta as today", () => {
  const data = setup();
  Object.assign(data.day_references[0], { captured_at: "2026-11-19T21:00:00Z", boundary_date: "2026-11-20" });
  const today = period(data, live(), "today");
  assert.equal(today.available, false);
  assert.equal(today.rows[0].status, "no_baseline");
});

test("a late reference after the current reading is not usable", () => {
  const data = setup();
  data.day_references[0].captured_at = "2026-11-21T10:00:00Z";
  assert.equal(period(data, live(), "today").rows[0].status, "no_baseline");
});

test("missing reference, missing participant and reused nickname are not zero", () => {
  const data = setup();
  data.day_references[0].status = "missing";
  assert.equal(period(data, live(), "today").rows[0].status, "no_baseline");
  assert.equal(period(setup(), live({}, NOW, { status: "missing" }), "today").rows[0].status, "missing");
  assert.equal(period(setup(), live({ pushUps: 1000 }, NOW, { profile: { id: "someone_else" } }), "today").rows[0].reason, "identity_changed");
});

test("reset or disappearance remains unknown; a new exercise starts from zero", () => {
  const data = setup();
  data.day_references[0].values = { pushUps: 100, squats: 40, highPlank: 300 };
  const today = period(data, live({ pushUps: 10, highPlank: 360, lunges: 7 }), "today");
  assert.deepEqual(today.rows[0].values, { pushUps: null, squats: null, highPlank: 60, lunges: 7 });
  const total = period(data, live({ pushUps: 10, highPlank: 360, lunges: 7 }), "total");
  assert.equal(total.rows[0].values.squats, null);
});

test("previously unknown counter cannot become a lifetime daily spike on reappearance", () => {
  const data = setup();
  data.day_references[0].values.pushUps = null;
  assert.equal(period(data, live(), "today").rows[0].values.pushUps, null);
});

test("yesterday is exact Moscow date and cannot fall back to last available day", () => {
  const data = setup();
  assert.equal(period(data, live(), "yesterday").rows[0].values.pushUps, 10);
  const later = period(data, null, "yesterday", "2026-11-23T09:00:00Z");
  assert.equal(later.date, "2026-11-22");
  assert.equal(later.available, false);
  assert.deepEqual(later.rows[0].values, {});
});

test("multi-day result is never assigned wholly to yesterday", () => {
  const data = setup();
  data.history[0].from = "2026-11-18T21:00:00Z";
  data.history[0].gap_days = 2;
  assert.equal(period(data, null, "yesterday").rows[0].reason, "multi_day_gap");
  assert.equal(chartDays(data, null, NOW)[0].rows[0].status, "no_baseline");
});

test("same-day personal enrollment remains measurable despite a global capture gap", () => {
  const data = setup();
  data.history[0].from = "2026-11-18T21:00:00Z";
  Object.assign(data.history[0].rows[0], { from: "2026-11-20T10:00:00Z", to: MIDNIGHT, partial: true });
  assert.equal(period(data, null, "yesterday").rows[0].values.pushUps, 10);
});

test("chart has explicit missing calendar days and includes today's partial point", () => {
  const data = setup();
  const dates = chartDays(data, null, "2026-11-24T09:00:00Z");
  assert.deepEqual(dates.map((day) => day.date), ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"]);
  assert.equal(dates[1].rows[0].status, "no_baseline");
  const days = chartDays(data, live(), NOW);
  assert.deepEqual(days.map((day) => day.date), ["2026-11-20", "2026-11-21"]);
  assert.equal(days[1].in_progress, true);
  assert.equal(days[1].rows[0].values.pushUps, 30);
});

test("removed players never reappear in chart or periods; functions do not mutate inputs", () => {
  const data = setup();
  data.history[0].rows.push(player("removed", { pushUps: 999 }));
  const original = JSON.stringify(data);
  const readings = live();
  const originalLive = JSON.stringify(readings);
  assert.deepEqual(chartDays(data, readings, NOW)[0].rows.map((row) => row.username), ["alice"]);
  periodsFor(data, readings, NOW);
  assert.equal(JSON.stringify(data), original);
  assert.equal(JSON.stringify(readings), originalLive);
});

test("empty roster is supported", () => {
  const data = setup();
  data.players = [];
  const periods = periodsFor(data, { captured_at: NOW, players: [] }, NOW);
  assert.equal(periods[1].available, false);
  assert.deepEqual(periods[2].rows, []);
});

test("a late daily capture counts only subsequent progress and marks today partial", () => {
  const data = setup();
  Object.assign(data.day_references[0], { late_capture: true, captured_at: "2026-11-21T08:00:00Z" });
  const today = period(data, live(), "today");
  assert.equal(today.rows[0].values.pushUps, 30);
  assert.equal(today.from, "2026-11-21T08:00:00Z");
  assert.equal(today.partial, true);
  assert.match(today.description, /начало дня не учтено/);
});

test("recover a multi-day total separately while daily values remain unknown", () => {
  const data = setup();
  data.history = [{ date: "2026-11-24", from: "2026-11-23T01:11:00Z", to: "2026-11-25T09:00:00Z",
    partial: true, late_capture: true, gap_days: 2, rows: [player("alice", { pushUps: 350 })] }];
  const intervals = unallocatedIntervals(data);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].rows[0].values.pushUps, 350);
  assert.equal(intervals[0].from, "2026-11-23T01:11:00Z");
  assert.equal(intervals[0].to, "2026-11-25T09:00:00Z");
  assert.equal(period(data, null, "yesterday", "2026-11-25T10:00:00Z").available, false);
  const missing = chartDays(data, null, "2026-11-25T10:00:00Z").filter((day) => day.date >= "2026-11-23");
  assert.deepEqual(missing.map((day) => day.rows[0].status), ["no_baseline", "no_baseline"]);
  assert.deepEqual(missing.map((day) => day.rows[0].values), [{}, {}]);
});

test("recovered intervals respect personal boundaries and preserve unknown counters", () => {
  const data = setup();
  data.players.push({ username: "bob" }, { username: "inactive" });
  Object.assign(data.history[0], { from: "2026-11-18T21:00:00Z", gap_days: 2 });
  data.history[0].rows = [player("alice", { pushUps: 40, squats: null }),
    player("bob", { pushUps: 3 }, { from: "2026-11-20T10:00:00Z", to: MIDNIGHT }),
    player("inactive", { pushUps: 50 }, { inactive: true }), player("removed", { pushUps: 99 })];
  const original = JSON.stringify(data);
  const recovered = unallocatedIntervals(data);
  assert.deepEqual(recovered[0].rows.map((row) => row.username), ["alice"]);
  assert.equal(recovered[0].rows[0].values.squats, null);
  assert.equal(JSON.stringify(data), original);
  assert.deepEqual(unallocatedIntervals(setup()), []);
});
