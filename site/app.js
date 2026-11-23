/* Static hosting: saved midnight history + public counters read in the browser. */
"use strict";

const $ = (id) => document.getElementById(id);
const numeric = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
});
const dateOnly = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow", day: "numeric", month: "short",
});
const ignoredExercises = new Set(["tutorial", "wilderness"]);
const rosterIssueURL = "https://github.com/seregqa-m/gymscape-clan/issues/new";
const nicknamePattern = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
const state = { data: null, live: null, periods: [], period: "total", exercise: "all", player: "seregqa", search: "", refreshing: false, chartFrom: "", chartTo: "", chartDate: "", chartDays: [] };

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function displayTime(iso, short = false) {
  const value = new Date(iso);
  return Number.isFinite(value.getTime()) ? (short ? dateOnly : dateTime).format(value) : "—";
}

function currentPeriod() {
  return state.periods.find((period) => period.id === state.period) || state.periods[0];
}

function exercises() {
  const used = new Set(["pushUps"]);
  for (const period of [...state.data.periods, ...state.periods, ...state.data.history]) {
    for (const row of period.rows) {
      for (const [id, value] of Object.entries(row.values || {})) {
        if (Number.isFinite(value) && value > 0) used.add(id);
      }
    }
  }
  return state.data.exercises.filter((exercise) => !ignoredExercises.has(exercise.id) && used.has(exercise.id));
}

function selectedExercise() {
  return exercises().find((exercise) => exercise.id === state.exercise);
}

function unit() {
  return state.exercise === "all" ? "reps" : selectedExercise()?.unit || "unknown";
}

function valueFor(row, exerciseId = state.exercise) {
  if (!row || row.status !== "ok") return null;
  const ids = exerciseId === "all"
    ? state.data.exercises.filter((exercise) => exercise.include_in_rep_total && exercise.unit === "reps").map((exercise) => exercise.id)
    : [exerciseId];
  let total = 0;
  for (const id of ids) {
    const value = row.values?.[id];
    if (value === null) return null;
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) return null;
    total += value === undefined ? 0 : value;
  }
  return total;
}

function formatValue(value, valueUnit = unit()) {
  if (value === null || value === undefined) return "—";
  if (valueUnit === "seconds") {
    const minutes = Math.floor(value / 60);
    const seconds = Math.round(value % 60);
    return `${numeric.format(minutes)}:${String(seconds).padStart(2, "0")}`;
  }
  return numeric.format(value);
}

function shownName(username) {
  const livePlayer = state.live?.players.find((item) => item.username === username);
  const player = state.data.players.find((item) => item.username === username);
  return livePlayer?.canonical_username || player?.canonical_username || username;
}

function rosterRequestURL(action, username) {
  const url = new URL(rosterIssueURL);
  url.search = new URLSearchParams({
    title: `[roster] ${action} ${username}`,
    body: JSON.stringify({ gymscape_roster: 1, action, username }),
  }).toString();
  return url.toString();
}

function validateNewParticipant(rawName) {
  const username = rawName.trim();
  if (!nicknamePattern.test(username)) {
    return { error: "Укажи ник длиной от 1 до 64 символов. Разрешены латиница, цифры, пробелы, точка, дефис и подчёркивание; первым должна быть буква или цифра." };
  }
  if (!state.data) return { error: "Дождись загрузки списка участников и попробуй ещё раз." };
  const lower = username.toLowerCase();
  const duplicate = state.data.players.find((player) =>
    player.username.toLowerCase() === lower || player.canonical_username?.toLowerCase() === lower);
  if (duplicate) return { error: `${shownName(duplicate.username)} уже есть в списке участников.` };
  return { username };
}

function setParticipantFeedback(message, isError = false) {
  const feedback = $("participant-feedback");
  feedback.hidden = !message;
  feedback.textContent = message;
  feedback.classList.toggle("is-error", isError);
  $("participant-nickname").setAttribute("aria-invalid", String(isError));
}

function renderParticipants() {
  const list = $("participants-list");
  list.replaceChildren();
  $("participants-count").textContent = numeric.format(state.data.players.length);
  $("participant-add-button").disabled = false;
  for (const player of state.data.players) {
    const item = node("li", "participant-item");
    const main = node("div", "participant-item-main");
    const name = node("span", "participant-item-name", shownName(player.username));
    const remove = node("button", "quiet-button participant-remove", "Убрать");
    remove.type = "button";
    remove.setAttribute("aria-label", `Убрать ${shownName(player.username)} из отслеживания`);
    remove.setAttribute("aria-expanded", "false");
    const confirmation = node("div", "participant-confirmation");
    confirmation.hidden = true;
    const text = node("p", "", `Перестать отслеживать ${shownName(player.username)}? Собранная история сохранится.`);
    const controls = node("div", "participant-confirmation-actions");
    const request = node("a", "request-link", "Подтвердить на GitHub");
    request.href = rosterRequestURL("remove", player.username);
    request.target = "_blank";
    request.rel = "noopener";
    const cancel = node("button", "quiet-button", "Отмена");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      confirmation.hidden = true;
      remove.setAttribute("aria-expanded", "false");
      remove.focus();
    });
    remove.addEventListener("click", () => {
      confirmation.hidden = !confirmation.hidden;
      remove.setAttribute("aria-expanded", String(!confirmation.hidden));
      if (!confirmation.hidden) request.focus();
    });
    request.addEventListener("click", () => {
      $("announcement").textContent = "Откроется готовая заявка. Чтобы изменить список, отправь её на GitHub.";
    });
    controls.append(request, cancel);
    confirmation.append(text, controls);
    main.append(name, remove);
    item.append(main, confirmation);
    list.append(item);
  }
  if (!state.data.players.length) list.append(node("li", "participants-loading", "В списке пока никого нет. Добавь первого участника."));
}

function toggleParticipants(open) {
  const panel = $("participants");
  const isOpen = open ?? panel.hidden;
  panel.hidden = !isOpen;
  $("manage-participants").setAttribute("aria-expanded", String(isOpen));
  if (isOpen) $("participant-nickname").focus();
  else $("manage-participants").focus();
}

function initials(username) {
  return username.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "?";
}

function rankRows() {
  const period = currentPeriod();
  const rows = state.data.players.map((player) => {
    const row = period.rows.find((item) => item.username === player.username);
    return { username: player.username, data: row, value: period.available ? valueFor(row) : null };
  });
  rows.sort((a, b) => {
    if (a.value === null && b.value !== null) return 1;
    if (a.value !== null && b.value === null) return -1;
    if (a.value !== null && a.value !== b.value) return b.value - a.value;
    return shownName(a.username).localeCompare(shownName(b.username), "ru", { numeric: true, sensitivity: "base" });
  });
  let lastValue = null;
  let lastRank = null;
  return rows.map((row, index) => {
    const rank = row.value === null ? null : row.value === lastValue ? lastRank : index + 1;
    if (row.value !== null) { lastRank = rank; lastValue = row.value; }
    return { ...row, rank };
  });
}

function statusText(row) {
  if (!currentPeriod().available) return "Нет данных за этот день";
  if (!row || row.status === "missing") return "Пока нет данных";
  if (row.status === "error") return "Не удалось получить данные";
  if (row.status === "no_baseline") return "Пока нет начального снимка";
  if (row.anomalies?.length) return "Изменение счётчика · данные неполные";
  return "Нет данных за период";
}

function makeFilters() {
  const periodContainer = $("period-options");
  periodContainer.replaceChildren();
  for (const period of state.periods) {
    const button = node("button", "", period.label);
    button.type = "button";
    button.dataset.period = period.id;
    button.setAttribute("aria-pressed", String(period.id === state.period));
    button.addEventListener("click", () => { state.period = period.id; render(true); });
    periodContainer.append(button);
  }
  const select = $("exercise-filter");
  select.replaceChildren();
  const all = node("option", "", "Все повторения");
  all.value = "all";
  select.append(all);
  for (const exercise of exercises()) {
    const option = node("option", "", exercise.label + (exercise.unit === "seconds" ? " · время" : ""));
    option.value = exercise.id;
    select.append(option);
  }
  if (![...select.options].some((option) => option.value === state.exercise)) state.exercise = "all";
  select.value = state.exercise;
}

function renderSummary(ranked) {
  const period = currentPeriod();
  const valid = ranked.filter((row) => row.value !== null);
  const total = valid.length ? valid.reduce((sum, row) => sum + row.value, 0) : null;
  const first = valid[0];
  $("summary-value-label").textContent = unit() === "seconds" ? "Времени в зачёте, мин:сек" : "Повторений в зачёте";
  $("summary-value").textContent = formatValue(total);
  $("summary-period").textContent = period.label + (period.in_progress ? " · день продолжается" : period.partial ? " · неполный день" : "");
  $("summary-players").textContent = numeric.format(state.data.players.length);
  $("summary-players-note").textContent = valid.length === state.data.players.length
    ? "Все результаты получены"
    : `Есть данные: ${valid.length} из ${state.data.players.length}`;
  $("summary-leader").textContent = first && first.value > 0 ? shownName(first.username) : "—";
  const tied = first ? valid.filter((row) => row.value === first.value).length : 0;
  $("summary-leader-note").textContent = first && first.value > 0
    ? `${formatValue(first.value)} ${unit() === "seconds" ? "мин:сек" : "повт."}${tied > 1 ? ` · делит место с ${tied - 1}` : ""}`
    : period.available ? "Первое место ещё впереди" : "Нет данных за этот день";
  const description = period.description || "";
  const range = period.from ? ` ${displayTime(period.from)} — ${displayTime(period.to)} МСК.` : "";
  $("period-note").querySelector("span").textContent = description + range;
  $("value-heading").textContent = unit() === "seconds" ? "Мин:сек" : unit() === "reps" ? "Повторения" : "Значение";
  $("ranking-footnote").textContent = state.exercise === "all"
    ? "Сумма повторений разных упражнений. Упражнения на время, бег на месте и служебные упражнения не входят в зачёт."
    : unit() === "seconds"
      ? "Планка считается в секундах. Здесь время показано как минуты:секунды."
      : "Одинаковый результат — одинаковое место. Нажми на игрока, чтобы открыть упражнения.";
}

function renderRanking(ranked) {
  const body = $("ranking-body");
  body.replaceChildren();
  const needle = state.search.trim().toLocaleLowerCase("ru-RU");
  const visible = ranked.filter((row) => `${row.username} ${shownName(row.username)}`.toLocaleLowerCase("ru-RU").includes(needle));
  const max = Math.max(0, ...ranked.map((row) => row.value || 0));
  for (const [index, row] of visible.entries()) {
    const tr = node("tr", `ranking-row${row.username === state.player ? " selected" : ""}${row.value === null ? " no-data" : ""}`);
    const rankCell = node("td");
    rankCell.append(node("span", "rank-number", row.rank === null ? "—" : String(row.rank)));
    const nameCell = node("td");
    const playerCell = node("div", "player-cell");
    const avatar = node("div", `player-avatar avatar-tone-${index % 5}`, initials(shownName(row.username)));
    avatar.setAttribute("aria-hidden", "true");
    const info = node("div", "player-info");
    const name = node("button", "player-name", shownName(row.username));
    name.type = "button";
    name.setAttribute("aria-pressed", String(row.username === state.player));
    name.setAttribute("aria-label", `Показать статистику ${shownName(row.username)}`);
    info.append(name);
    if (row.value === null) info.append(node("div", "player-subtext", statusText(row.data)));
    playerCell.append(avatar, info);
    nameCell.append(playerCell);
    const valueCell = node("td");
    const counter = node("div", row.value === null ? "counter-missing" : `counter${row.value === 0 ? " zero-counter" : ""}`, formatValue(row.value));
    valueCell.append(counter);
    if (row.value !== null) {
      const track = node("div", "score-track");
      track.setAttribute("aria-hidden", "true");
      const fill = node("span");
      fill.style.width = `${max ? row.value / max * 100 : 0}%`;
      track.append(fill);
      valueCell.append(track);
    }
    const select = () => {
      state.player = row.username;
      renderDetail(ranked);
      for (const element of body.querySelectorAll("tr")) {
        const selected = element.dataset.username === row.username;
        element.classList.toggle("selected", selected);
        element.querySelector("button")?.setAttribute("aria-pressed", String(selected));
      }
      updateURL();
      $("announcement").textContent = `Открыта статистика ${shownName(row.username)}`;
    };
    tr.dataset.username = row.username;
    tr.addEventListener("click", select);
    tr.append(rankCell, nameCell, valueCell);
    body.append(tr);
  }
  if (!visible.length) {
    const tr = node("tr");
    const cell = node("td", "table-message", "Игроков с таким именем нет в нашем списке.");
    cell.colSpan = 3;
    tr.append(cell);
    body.append(tr);
  }
}

function renderProfile(player) {
  const target = $("profile-stats");
  target.replaceChildren();
  const stats = [
    ["Уровень", player?.profile?.total_level],
    ["Боевой", player?.profile?.combat_level],
    ["Золото", player?.profile?.coins],
  ].filter(([, value]) => Number.isFinite(value));
  target.hidden = !stats.length;
  target.setAttribute("aria-label", "Последние данные игрового профиля");
  if (stats.length) target.append(node("p", "profile-caption", "Последние данные профиля"));
  for (const [label, value] of stats) {
    const item = node("div", "profile-stat");
    item.append(node("span", "", label), node("strong", "", numeric.format(value)));
    target.append(item);
  }
}

function renderDetail(ranked) {
  const period = currentPeriod();
  const current = ranked.find((row) => row.username === state.player) || ranked[0];
  if (!current) {
    state.player = "";
    $("detail-title").textContent = "Пока нет участников";
    $("detail-avatar").textContent = "?";
    $("detail-place").hidden = true;
    $("detail-period").textContent = "Добавь участников, чтобы сравнивать результаты.";
    $("exercise-details").replaceChildren();
    $("detail-starting-total").textContent = "";
    renderProfile(null);
    return;
  }
  state.player = current.username;
  const player = state.live?.players.find((row) => row.username === current.username) || state.data.players.find((row) => row.username === current.username);
  $("detail-title").textContent = shownName(current.username);
  $("detail-avatar").textContent = initials(shownName(current.username));
  $("detail-place").hidden = current.rank === null;
  $("detail-place").textContent = current.rank === null ? "" : `#${current.rank}`;
  $("detail-period").textContent = `${period.label}${period.in_progress ? " · день продолжается" : period.partial ? " · неполный день" : ""}`;
  renderProfile(player);
  const details = $("exercise-details");
  details.replaceChildren();
  for (const exercise of exercises()) {
    const value = period.available ? valueFor(current.data, exercise.id) : null;
    const pair = node("div", `exercise-detail${exercise.id === state.exercise ? " active" : ""}`);
    pair.append(node("dt", "", exercise.label), node("dd", "", formatValue(value, exercise.unit) + (value !== null && exercise.unit === "seconds" ? " мин:сек" : "")));
    details.append(pair);
  }
  const baseline = state.data.periods.find((item) => item.id === "baseline")?.rows.find((row) => row.username === current.username);
  const startValue = valueFor(baseline);
  $("detail-starting-total").textContent = startValue === null ? "" : `Стартовый тотал: ${formatValue(startValue)} ${unit() === "seconds" ? "мин:сек" : "повт."} · ${displayTime(baseline.captured_at || baseline.to)} МСК. Хранится отдельно от дневного прогресса.`;
}

function emptyChart(message, detail) {
  const empty = node("div", "chart-empty");
  empty.append(node("strong", "", message), node("p", "", detail));
  $("history-chart").replaceChildren(empty);
}

function svgNode(tag, attributes = {}, text) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

const chartColors = ["#c0f36b", "#70c8f5", "#f7b267", "#c899f2", "#64d9be", "#f8849a", "#e2d572", "#8aa3ff", "#b6d5cb", "#e599dd", "#ce986b", "#73b67b", "#c7c2f0", "#57a8a1", "#e5bca7"];
function playerColor(username) {
  return chartColors[state.data.players.findIndex((player) => player.username === username) % chartColors.length];
}

function calendarLabel(date) {
  return displayTime(`${date}T12:00:00+03:00`, true);
}

function inspectDay(index) {
  const day = state.chartDays[index];
  if (!day) return;
  state.chartDate = day.date;
  $("chart-day").value = String(index);
  $("chart-day-label").textContent = calendarLabel(day.date);
  const values = state.data.players.map((player) => ({ player, row: day.rows.find((row) => row.username === player.username) }));
  const measured = values.filter(({ row }) => valueFor(row) !== null);
  const total = measured.length ? measured.reduce((sum, { row }) => sum + valueFor(row), 0) : null;
  const flags = [day.in_progress ? "День продолжается" : day.partial ? "Неполный день" : "", `Данные ${measured.length} из ${values.length}`, `Сумма: ${formatValue(total)}${unit() === "seconds" ? " мин:сек" : ""}`].filter(Boolean);
  $("chart-day-note").textContent = flags.join(" · ");
  $("chart-day").setAttribute("aria-valuetext", `${calendarLabel(day.date)}. ${flags.join(". ")}`);
  const readout = $("chart-readout");
  readout.replaceChildren();
  for (const { player, row } of values.filter(({ player }) => state.chartPlayers.some((item) => item.username === player.username))) {
    const item = node("li", "chart-player-result");
    const name = node("span", "chart-player-name", shownName(player.username));
    name.style.setProperty("--player-color", playerColor(player.username));
    const value = valueFor(row);
    const count = node("strong", "", value === null ? "Нет данных" : `${formatValue(value)}${row?.partial ? "*" : ""}`);
    if (row?.partial && value !== null) count.title = `Неполный интервал: ${displayTime(row.from)} — ${displayTime(row.to)} МСК`;
    item.append(name, count); readout.append(item);
  }
  for (const group of $("history-chart").querySelectorAll("[data-date]")) {
    group.classList.toggle("selected-day", group.dataset.date === day.date);
  }
}

function renderChart() {
  const days = GymMetrics.chartDays(state.data, state.live);
  $("chart-unit").textContent = `${selectedExercise()?.label || "Все повторения"} · ${unit() === "seconds" ? "время за день, мин:сек" : "повторения за день"}`;
  const end = GymMetrics.moscowDate(new Date());
  const beginning = days[0]?.date || end;
  if (!state.chartFrom) state.chartFrom = days[Math.max(0, days.length - 30)]?.date || beginning;
  if (!state.chartTo) state.chartTo = end;
  for (const [id, value] of [["chart-from", state.chartFrom], ["chart-to", state.chartTo]]) {
    $(id).value = value; $(id).max = end;
  }
  const invalid = state.chartFrom > state.chartTo;
  $("chart-range-error").hidden = !invalid;
  state.chartDays = invalid ? [] : days.filter((day) => day.date >= state.chartFrom && day.date <= state.chartTo);
  const history = state.chartDays;
  // Keep one stable slot per participant across the selected dates. A player
  // appears only when there is a measured positive result in this range.
  state.chartPlayers = state.data.players.filter((player) => history.some((day) =>
    valueFor(day.rows.find((row) => row.username === player.username)) > 0));
  if (!state.chartPlayers.some((player) => player.username === state.chartFocus)) state.chartFocus = null;
  const legend = $("chart-legend");
  legend.replaceChildren();
  for (const player of state.chartPlayers) {
    const button = node("button", "chart-legend-item", shownName(player.username));
    button.type = "button";
    button.style.setProperty("--player-color", playerColor(player.username));
    button.setAttribute("aria-pressed", String(state.chartFocus === player.username));
    button.setAttribute("aria-label", `Выделить ${shownName(player.username)} на графике`);
    button.addEventListener("click", () => { state.chartFocus = state.chartFocus === player.username ? null : player.username; renderChart(); });
    legend.append(button);
  }
  if (history.length && !state.chartPlayers.length) legend.append(node("p", "chart-caption", "За выбранные даты нет ненулевых результатов по этому упражнению."));
  $("chart-inspector").hidden = !history.length;
  if (!history.length) {
    emptyChart(invalid ? "Проверь диапазон дат" : "Пока нет дневной истории", invalid ? "Дата начала должна быть не позже даты окончания." : "После обновления появится сегодняшний прирост. Прошлые дни начнут накапливаться с первого ночного снимка.");
    return;
  }
  const target = $("history-chart");
  target.replaceChildren();
  const playerCount = Math.max(1, state.chartPlayers.length);
  const groupMinimum = Math.max(74, playerCount * 15 + 24);
  const width = Math.max(300, target.clientWidth, history.length * groupMinimum + 80);
  const left = 60, right = 20, top = 18, bottom = 254;
  const step = (width - left - right) / history.length;
  const barGap = 4;
  const barWidth = Math.min(30, (step - 24 - barGap * (playerCount - 1)) / playerCount);
  const groupWidth = playerCount * barWidth + (playerCount - 1) * barGap;
  const maximum = history.reduce((max, day) => day.rows.reduce((value, row) => Math.max(value, valueFor(row) ?? 0), max), 1);
  const magnitude = 10 ** Math.floor(Math.log10(maximum / 4));
  const yMax = Math.max(4, Math.ceil(maximum / magnitude / 4) * magnitude * 4);
  const scale = (bottom - top) / yMax;
  const svg = svgNode("svg", { viewBox: `0 0 ${width} 294`, width, height: 294, class: "grouped-chart", role: "img", "aria-label": "Дневной прирост участников: внутри каждого дня отдельные цветные столбцы стоят рядом на общей нулевой линии. Точные значения доступны под графиком." });
  for (let tick = 0; tick <= 4; tick++) {
    const value = yMax * tick / 4, y = bottom - value * scale;
    svg.append(svgNode("line", { x1: left, x2: width - right, y1: y, y2: y, stroke: "#303a2d", "stroke-dasharray": tick ? "3 5" : "none" }));
    svg.append(svgNode("text", { x: left - 10, y: y + 4, fill: "#9aa994", "font-size": 12, "text-anchor": "end" }, formatValue(value)));
  }
  history.forEach((day, index) => {
    const groupX = left + step * index + (step - groupWidth) / 2;
    const centerX = left + step * (index + .5);
    const group = svgNode("g", { "data-date": day.date });
    const known = day.rows.filter((row) => valueFor(row) !== null);
    const background = svgNode("rect", { x: left + step * index, y: top - 8, width: step, height: bottom - top + 8, fill: "#c0f36b", opacity: 0, class: "chart-day-highlight" });
    group.append(background);
    const hit = svgNode("rect", { x: left + step * index, y: top - 8, width: step, height: bottom - top + 33, fill: "transparent", class: "chart-day-hit" });
    group.append(hit);
    let dayMaximum = 0;
    state.chartPlayers.forEach((player, playerIndex) => {
      const row = day.rows.find((row) => row.username === player.username);
      const value = valueFor(row);
      const x = groupX + playerIndex * (barWidth + barGap);
      const color = playerColor(player.username);
      const opacity = !state.chartFocus || state.chartFocus === player.username ? 1 : .25;
      const title = `${calendarLabel(day.date)} · ${shownName(player.username)}: ${value === null ? "нет данных" : `${formatValue(value)} ${unit() === "seconds" ? "мин:сек" : "повт."}`}${row?.partial ? " · неполный день" : ""}`;
      const slot = svgNode("rect", { x, y: top, width: barWidth, height: bottom - top, fill: "transparent", class: "chart-day-hit" });
      slot.append(svgNode("title", {}, title));
      group.append(slot);
      if (value === null || value === 0) {
        const marker = svgNode("text", { x: x + barWidth / 2, y: bottom - 6, fill: color, opacity, "font-size": 11, "text-anchor": "middle" }, value === null ? "—" : "0");
        marker.append(svgNode("title", {}, title));
        group.append(marker);
        return;
      }
      const height = value * scale;
      const bar = svgNode("rect", { x, y: bottom - height, width: barWidth, height, fill: color, rx: 1.5, opacity, "data-player": player.username, "data-value": value });
      bar.append(svgNode("title", {}, title));
      group.append(bar);
      dayMaximum = Math.max(dayMaximum, value);
    });
    if (!state.chartPlayers.length) {
      group.append(svgNode("text", { x: centerX, y: bottom - 8, fill: "#9aa994", "font-size": 12, "text-anchor": "middle" }, known.length ? "0" : "—"));
    }
    if (known.length && (known.length < state.data.players.length || day.partial || day.in_progress)) {
      group.append(svgNode("text", { x: centerX, y: Math.max(12, bottom - dayMaximum * scale - 6), fill: "#9aa994", "font-size": 12, "text-anchor": "middle" }, "*"));
    }
    const labelEvery = Math.max(1, Math.ceil(history.length / (width / 72)));
    if (index % labelEvery === 0 || index === history.length - 1) {
      group.append(svgNode("text", { x: centerX, y: 279, fill: "#9aa994", "font-size": 12, "text-anchor": "middle" }, calendarLabel(day.date)));
    }
    group.addEventListener("pointerenter", () => inspectDay(index));
    group.addEventListener("click", () => inspectDay(index));
    svg.append(group);
  });
  target.append(svg);
  $("chart-day").max = String(history.length - 1);
  const selectedIndex = history.findIndex((day) => day.date === state.chartDate);
  inspectDay(selectedIndex < 0 ? history.length - 1 : selectedIndex);
}

function updateURL() {
  const url = new URL(window.location.href);
  url.searchParams.set("period", state.period);
  url.searchParams.set("exercise", state.exercise);
  url.searchParams.set("player", state.player);
  window.history.replaceState(null, "", url);
}

function render(announce = false) {
  state.periods = GymMetrics.periodsFor(state.data, state.live);
  const ranked = rankRows();
  for (const button of $("period-options").children) button.setAttribute("aria-pressed", String(button.dataset.period === state.period));
  renderSummary(ranked);
  renderRanking(ranked);
  renderDetail(ranked);
  renderChart();
  updateURL();
  if (announce) $("announcement").textContent = `${currentPeriod().label}. ${selectedExercise()?.label || "Все повторения"}. Рейтинг обновлён.`;
}

async function publicRows(table, query) {
  const config = state.data.source;
  if (!config?.base_url || !config?.publishable_key) throw new Error("No public source configuration");
  const url = `${config.base_url}/rest/v1/${table}?${new URLSearchParams(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { headers: { apikey: config.publishable_key, Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error(`Public API: HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Invalid public API response");
    return rows;
  } finally { clearTimeout(timer); }
}

async function fetchLivePlayer(player) {
  const query = { select: "id,username,total_level,combat_level,coins,skills_xp", limit: "2" };
  if (player.id) query.id = `eq.${player.id}`;
  else query.username = `ilike.${player.username.replace(/[\\%_*]/g, "\\$&")}`;
  const profiles = await publicRows("hiscores_full_v2", query);
  if (profiles.length > 1) throw new Error("Ambiguous public profile");
  const profile = profiles[0] || null;
  if (profile && (typeof profile.id !== "string" || typeof profile.username !== "string" || (player.id && profile.id !== player.id))) throw new Error("Unexpected public identity");
  const canonical = profile?.username || player.username;
  const rows = player.id && !profile ? [] : await publicRows("exercise_hiscores", {
    select: "username,exercise_id,reps", username: `eq.${canonical}`, order: "exercise_id.asc", limit: "500",
  });
  if (rows.length >= 500) throw new Error("Possibly truncated public counters");
  const values = Object.create(null);
  for (const row of rows) {
    if (row.username !== canonical || typeof row.exercise_id !== "string" || !row.exercise_id || Object.hasOwn(values, row.exercise_id) || !Number.isSafeInteger(row.reps) || row.reps < 0) throw new Error("Invalid public counter");
    values[row.exercise_id] = row.reps;
  }
  return { username: player.username, canonical_username: canonical, status: rows.length ? "ok" : "missing", profile, values, captured_at: new Date().toISOString() };
}

async function refreshLive() {
  if (state.refreshing || !state.data) return;
  state.refreshing = true;
  $("refresh-live").disabled = true;
  $("refresh-live").textContent = "Обновляем…";
  $("updated-at").textContent = "Получаем свежие счётчики…";
  try {
    const players = [], roster = state.data.players;
    let next = 0;
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(3, roster.length) }, async () => {
      while (next < roster.length) {
        const index = next++;
        players[index] = await fetchLivePlayer(roster[index]);
      }
    }));
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure) throw failure.reason;
    if (roster.length && !players.some((player) => player.status === "ok")) throw new Error("No public counters returned");
    state.live = { captured_at: new Date().toISOString(), players };
    const known = new Set(state.data.exercises.map((exercise) => exercise.id));
    for (const player of players) for (const id of Object.keys(player.values)) {
      if (!known.has(id)) {
        state.data.exercises.push({ id, label: id, unit: "unknown", include_in_rep_total: false });
        known.add(id);
      }
    }
    $("updated-at").textContent = `Обновлено: ${displayTime(state.live.captured_at)} МСК`;
    state.periods = GymMetrics.periodsFor(state.data, state.live);
    makeFilters();
    render();
  } catch (error) {
    $("updated-at").textContent = `Не удалось обновить. Данные: ${displayTime(state.live?.captured_at || state.data.latest_at)} МСК`;
    $("announcement").textContent = "Свежие счётчики недоступны. Показаны сохранённые данные.";
    console.warn("Could not refresh public counters:", error.message);
  } finally {
    state.refreshing = false;
    $("refresh-live").disabled = false;
    $("refresh-live").textContent = "Обновить";
  }
}

async function load() {
  if (state.refreshing) return;
  $("dashboard").setAttribute("aria-busy", "true");
  $("load-error").hidden = true;
  try {
    const response = await fetch("./data/dashboard.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.schema_version !== 1 || !Array.isArray(data.players) || !Array.isArray(data.exercises) || !data.periods?.length || !Array.isArray(data.history)) throw new Error("Unexpected data format");
    const rosterVersion = (snapshot) => JSON.stringify(snapshot?.players.map((player) => [player.username, player.id]));
    if (state.data && (state.data.generated_at !== data.generated_at || rosterVersion(state.data) !== rosterVersion(data))) state.live = null;
    state.data = data;
    state.periods = GymMetrics.periodsFor(data, state.live);
    const params = new URLSearchParams(window.location.search);
    const wantedPeriod = params.get("period");
    state.period = state.periods.some((period) => period.id === wantedPeriod) ? wantedPeriod : "total";
    state.exercise = params.get("exercise") || state.exercise;
    const wantedPlayer = params.get("player") || state.player;
    state.player = data.players.find((player) => player.username === wantedPlayer)?.username || data.players[0]?.username || "";
    $("updated-at").textContent = `Последний снимок: ${displayTime(data.latest_at)} МСК`;
    makeFilters();
    renderParticipants();
    render();
    await refreshLive();
  } catch (error) {
    $("load-error").hidden = false;
    $("load-error-detail").textContent = "Проверь соединение и попробуй ещё раз. Если сайт только что опубликован, данные могут появиться через несколько минут.";
    $("updated-at").textContent = "Данные пока недоступны";
    $("announcement").textContent = "Не удалось загрузить статистику.";
    if (!state.data) {
      $("participants-list").replaceChildren(node("li", "participants-loading", "Не удалось загрузить список. Попробуй обновить статистику."));
    }
    console.error("Could not load GymScape dashboard:", error);
  } finally {
    $("dashboard").setAttribute("aria-busy", "false");
  }
}

$("exercise-filter").addEventListener("change", (event) => {
  state.exercise = event.target.value;
  if (state.data) render(true);
});
$("player-search").addEventListener("input", (event) => {
  state.search = event.target.value;
  if (state.data) renderRanking(rankRows());
});
$("retry-load").addEventListener("click", load);
$("refresh-live").addEventListener("click", load);
for (const id of ["chart-from", "chart-to"]) $(id).addEventListener("change", (event) => {
  if (id === "chart-from") state.chartFrom = event.target.value;
  else state.chartTo = event.target.value;
  if (state.data) renderChart();
});
$("chart-day").addEventListener("input", (event) => inspectDay(Number(event.target.value)));
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.data) renderChart(); }, 150); });
let calendarDay = GymMetrics.moscowDate(new Date());
setInterval(() => {
  const today = GymMetrics.moscowDate(new Date());
  if (today !== calendarDay && !document.hidden && !state.refreshing) {
    calendarDay = today; state.live = null; state.chartTo = today;
    load();
  }
}, 60000);
$("manage-participants").addEventListener("click", () => toggleParticipants());
$("close-participants").addEventListener("click", () => toggleParticipants(false));
$("participant-nickname").addEventListener("input", () => {
  setParticipantFeedback("");
  $("participant-add-request").hidden = true;
  $("participant-add-request").removeAttribute("href");
});
$("participant-add-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const result = validateNewParticipant($("participant-nickname").value);
  const request = $("participant-add-request");
  if (result.error) {
    request.hidden = true;
    request.removeAttribute("href");
    setParticipantFeedback(result.error, true);
    $("participant-nickname").focus();
    return;
  }
  $("participant-nickname").value = result.username;
  request.href = rosterRequestURL("add", result.username);
  request.hidden = false;
  setParticipantFeedback("Заявка подготовлена. Отправь её на GitHub, чтобы добавить участника. Если новая вкладка не открылась, нажми на ссылку ниже.");
  request.click();
});
load();
