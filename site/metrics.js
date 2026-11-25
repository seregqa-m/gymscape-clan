/* Calendar periods use Moscow dates. Pure functions: no network or browser state. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GymMetrics = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const DAY = 86400000;
  const MOSCOW_OFFSET = 3 * 60 * 60 * 1000;
  const moment = (value) => value == null ? NaN : new Date(value).getTime();
  const key = (value) => String(value || "").toLowerCase();
  const byName = (rows) => new Map((rows || []).map((row) => [key(row.username), row]));

  function moscowDate(value = new Date()) {
    const time = moment(value);
    return Number.isFinite(time) ? new Date(time + MOSCOW_OFFSET).toISOString().slice(0, 10) : null;
  }

  function shiftDate(date, days) {
    return new Date(Date.parse(date + "T00:00:00Z") + days * DAY).toISOString().slice(0, 10);
  }

  function identity(row) {
    return row?.profile_id || row?.profile?.id || row?.id || null;
  }

  function unknown(username, status = "no_baseline", reason = "missing_boundary", extra = {}) {
    return { username, status, reason, values: {}, anomalies: [], ...extra };
  }

  function freshLive(live, today) {
    return live && Array.isArray(live.players) && moscowDate(live.captured_at) === today ? live : null;
  }

  function normalizedValues(current, reference) {
    const values = { ...(current || {}) };
    for (const [exercise, value] of Object.entries(reference || {})) {
      if (!(exercise in values) && (value === null || value > 0)) values[exercise] = null;
    }
    for (const [exercise, value] of Object.entries(values)) {
      if (!Number.isSafeInteger(value) || value < 0) values[exercise] = null;
    }
    return values;
  }

  function liveTotals(data, live, today) {
    const readings = byName(live.players);
    const references = byName(data.day_references);
    return data.players.map((player) => {
      const current = readings.get(key(player.username));
      const captured = current?.captured_at || live.captured_at;
      if (!current || current.status !== "ok" || moscowDate(captured) !== today) {
        return unknown(player.username, "missing", "missing_live", { captured_at: captured, to: captured });
      }
      const currentId = identity(current);
      if (player.id && currentId && player.id !== currentId) {
        return unknown(player.username, "missing", "identity_changed", { anomalies: ["identity_changed"] });
      }
      const reference = references.get(key(player.username));
      const sameAccount = !identity(reference) || !currentId || identity(reference) === currentId;
      const values = normalizedValues(current.values, sameAccount ? reference?.values : {});
      return { username: player.username, status: "ok", values,
        anomalies: Object.keys(values).filter((name) => values[name] === null),
        from: null, to: captured, captured_at: captured, profile_id: currentId };
    });
  }

  function todayPeriod(data, live, today) {
    const readings = byName(live?.players);
    const references = byName(data.day_references);
    const rows = data.players.map((player) => {
      const reference = references.get(key(player.username));
      const current = readings.get(key(player.username));
      const end = current?.captured_at || live?.captured_at || null;
      const start = reference?.captured_at || null;
      const common = { from: start, to: end, partial: reference?.kind !== "daily" || Boolean(reference?.late_capture), in_progress: true };
      if (!current || current.status !== "ok" || moscowDate(end) !== today) {
        return unknown(player.username, "missing", "missing_live", common);
      }
      const expectedIds = [player.id, identity(reference)].filter(Boolean);
      if (identity(current) && expectedIds.some((expectedId) => expectedId !== identity(current))) {
        return unknown(player.username, "no_baseline", "identity_changed", { ...common, anomalies: ["identity_changed"] });
      }
      const validReference = reference?.status === "ok" && moscowDate(start) === today &&
        (reference.kind !== "daily" || reference.boundary_date === today) &&
        ["daily", "baseline", "enrollment"].includes(reference.kind) && moment(start) <= moment(end);
      if (!validReference) return unknown(player.username, "no_baseline", "missing_boundary", common);
      const previous = reference.values || {};
      const currentValues = normalizedValues(current.values, previous);
      const values = {};
      const anomalies = [];
      for (const exercise of new Set([...Object.keys(previous), ...Object.keys(currentValues)])) {
        const before = previous[exercise] === undefined ? 0 : previous[exercise];
        const after = currentValues[exercise] === undefined ? 0 : currentValues[exercise];
        const delta = after - before;
        values[exercise] = before === null || after === null || !Number.isSafeInteger(delta) || delta < 0 ? null : delta;
        if (values[exercise] === null) anomalies.push(exercise);
      }
      return { username: player.username, status: "ok", values, anomalies, ...common };
    });
    const measured = rows.filter((row) => row.status === "ok");
    const partial = measured.some((row) => row.partial);
    const late = measured.some((row) => references.get(key(row.username))?.late_capture);
    return { id: "today", label: "Сегодня", date: today, available: measured.length > 0,
      from: measured.length ? measured.map((row) => row.from).sort((a, b) => moment(a) - moment(b))[0] : null,
      to: live?.captured_at || null, partial, in_progress: true,
      description: !live ? "Для сегодняшнего результата нужен свежий замер. Обнови статистику." : !measured.length
        ? "Пока нет подходящего начального снимка за сегодня. Результат не подменяется нулём."
        : late ? "Сегодняшний снимок сделан с опозданием. Здесь только прирост после времени снимка, указанного ниже; начало дня не учтено."
        : partial ? "Прирост за сегодня с начала наблюдения. У недавно добавленных участников день неполный."
          : "Прирост с ночного снимка до последнего обновления. Фактическое время начала указано ниже; день ещё идёт.",
      rows };
  }

  function calendarDay(data, segment) {
    const rowsByName = byName(segment?.rows);
    const rows = data.players.map((player) => {
      const row = rowsByName.get(key(player.username));
      const from = row?.from || segment?.from || null;
      const to = row?.to || segment?.to || null;
      if (!row) return unknown(player.username, "no_baseline", "missing_day", { from, to, partial: true });
      if (row.status !== "ok") return { ...row, username: player.username, from, to };
      // A multi-day delta cannot be allocated to its last calendar day.
      if (moscowDate(from) !== segment.date || moscowDate(to) !== shiftDate(segment.date, 1) || moment(from) >= moment(to)) {
        return unknown(player.username, "no_baseline", "multi_day_gap", { from, to, partial: true });
      }
      return { ...row, username: player.username, from, to,
        partial: row.partial ?? Boolean(segment.partial) };
    });
    return { ...segment, rows, partial: rows.some((row) => row.partial), in_progress: false };
  }

  function periodsFor(data, live = null, now = new Date()) {
    const today = moscowDate(now);
    const yesterday = shiftDate(today, -1);
    const current = freshLive(live, today);
    const stored = data.periods.find((period) => period.id === "total") || { rows: [], to: data.latest_at };
    const total = { ...stored, id: "total", label: "Тотал", available: true, from: null, partial: false,
      to: current?.captured_at || stored.to, in_progress: false,
      description: current ? "Все накопленные повторения на момент обновления." : "Все накопленные повторения на последнем сохранённом снимке.",
      rows: current ? liveTotals(data, current, today) : stored.rows };
    const segment = data.history.find((item) => item.date === yesterday);
    const closed = segment ? calendarDay(data, segment) : { rows: data.players.map((player) => unknown(player.username, "no_baseline", "missing_day")) };
    const available = closed.rows.some((row) => row.status === "ok");
    return [total, todayPeriod(data, current, today), {
      ...closed, id: "yesterday", label: "Вчера", date: yesterday, available,
      from: segment?.from || null, to: segment?.to || null, partial: Boolean(closed.partial), in_progress: false,
      description: !available ? "За вчера пока нет двух подходящих снимков. Более старый день здесь не показывается."
        : closed.partial ? "Неполный интервал за вчера: наблюдение началось в течение дня или снимок был сделан с опозданием."
          : "Прирост между ночными снимками за вчера. Фактические границы указаны ниже по московскому времени.",
    }];
  }

  function chartDays(data, live = null, now = new Date()) {
    const today = moscowDate(now);
    const history = new Map(data.history.filter((item) => item.date < today).map((item) => [item.date, item]));
    const first = [...history.keys(), moscowDate(data.baseline_at)].filter((date) => date && date < today).sort()[0];
    const days = [];
    if (first) {
      for (let date = first; date < today; date = shiftDate(date, 1)) {
        const segment = history.get(date);
        days.push(segment ? calendarDay(data, segment) : { date, from: null, to: null,
          partial: true, in_progress: false,
          rows: data.players.map((player) => unknown(player.username, "no_baseline", "missing_day")) });
      }
    }
    const current = freshLive(live, today);
    if (current) days.push(todayPeriod(data, current, today));
    return days;
  }

  function unallocatedIntervals(data) {
    const active = new Set(data.players.map((player) => key(player.username)));
    return data.history.map((segment) => {
      const rows = segment.rows.filter((row) => {
        const from = row.from || segment.from;
        const to = row.to || segment.to;
        const first = moscowDate(from), last = moscowDate(to);
        return active.has(key(row.username)) && row.status === "ok" && !row.inactive &&
          first && last && moment(from) < moment(to) &&
          Date.parse(last) - Date.parse(first) > DAY;
      }).map((row) => ({ ...row, from: row.from || segment.from, to: row.to || segment.to }));
      if (!rows.length) return null;
      return { from: rows.map((row) => row.from).sort((a, b) => moment(a) - moment(b))[0],
        to: rows.map((row) => row.to).sort((a, b) => moment(b) - moment(a))[0], rows };
    }).filter(Boolean);
  }

  return { moscowDate, periodsFor, chartDays, unallocatedIntervals };
});
