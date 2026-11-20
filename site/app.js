/* Static dashboard. All values come from the published snapshot, never live game APIs. */
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
const state = { data: null, period: "baseline", exercise: "pushUps", player: "seregqa", search: "" };

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
  return state.data.periods.find((period) => period.id === state.period) || state.data.periods[0];
}

function exercises() {
  const used = new Set(["pushUps"]);
  for (const period of state.data.periods) {
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
    ? exercises().filter((exercise) => exercise.include_in_rep_total && exercise.unit === "reps").map((exercise) => exercise.id)
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
  const player = state.data.players.find((item) => item.username === username);
  return player?.canonical_username || username;
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
  if (!currentPeriod().available) return "Ждём следующий снимок";
  if (!row || row.status === "missing") return "Пока нет данных";
  if (row.status === "error") return "Не удалось получить данные";
  if (row.status === "no_baseline") return "Пока нет начального снимка";
  if (row.anomalies?.length) return "Изменение счётчика · данные неполные";
  return "Нет данных за период";
}

function makeFilters() {
  const periodContainer = $("period-options");
  periodContainer.replaceChildren();
  for (const period of state.data.periods) {
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
  $("summary-period").textContent = period.label + (period.partial ? " · неполный период" : "");
  $("summary-players").textContent = numeric.format(state.data.players.length);
  $("summary-players-note").textContent = valid.length === state.data.players.length
    ? "Все результаты получены"
    : `Есть данные: ${valid.length} из ${state.data.players.length}`;
  $("summary-leader").textContent = first && first.value > 0 ? shownName(first.username) : "—";
  const tied = first ? valid.filter((row) => row.value === first.value).length : 0;
  $("summary-leader-note").textContent = first && first.value > 0
    ? `${formatValue(first.value)} ${unit() === "seconds" ? "мин:сек" : "повт."}${tied > 1 ? ` · делит место с ${tied - 1}` : ""}`
    : period.available ? "Первое место ещё впереди" : "Сначала нужен следующий снимок";
  const description = period.description || "";
  const baselineNote = period.id === "baseline" && !description.toLocaleLowerCase("ru-RU").includes("не входит в дневной прогресс") ? " Стартовый тотал не входит в дневной прогресс." : "";
  const range = period.from ? ` ${displayTime(period.from)} — ${displayTime(period.to)} МСК.` : "";
  $("period-note").querySelector("span").textContent = description + baselineNote + range;
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
  target.setAttribute("aria-label", "Игровой профиль на последнем снимке");
  if (stats.length) target.append(node("p", "profile-caption", "Профиль на последнем снимке"));
  for (const [label, value] of stats) {
    const item = node("div", "profile-stat");
    item.append(node("span", "", label), node("strong", "", numeric.format(value)));
    target.append(item);
  }
}

function renderDetail(ranked) {
  const period = currentPeriod();
  const current = ranked.find((row) => row.username === state.player) || ranked[0];
  if (!current) return;
  state.player = current.username;
  const player = state.data.players.find((row) => row.username === current.username);
  $("detail-title").textContent = shownName(current.username);
  $("detail-avatar").textContent = initials(shownName(current.username));
  $("detail-place").hidden = current.rank === null;
  $("detail-place").textContent = current.rank === null ? "" : `#${current.rank}`;
  $("detail-period").textContent = `${period.label}${period.partial ? " · неполный период" : ""}`;
  renderProfile(player);
  const details = $("exercise-details");
  details.replaceChildren();
  for (const exercise of exercises()) {
    const value = period.available ? valueFor(current.data, exercise.id) : null;
    const pair = node("div", `exercise-detail${exercise.id === state.exercise ? " active" : ""}`);
    pair.append(node("dt", "", exercise.label), node("dd", "", formatValue(value, exercise.unit) + (value !== null && exercise.unit === "seconds" ? " мин:сек" : "")));
    details.append(pair);
  }
  renderChart(current.username);
}

function emptyChart(message, detail) {
  const empty = node("div", "chart-empty");
  empty.append(node("strong", "", message), node("p", "", detail));
  $("history-chart").replaceChildren(empty);
}

function renderChart(username) {
  $("chart-unit").textContent = unit() === "seconds" ? "Секунды" : "Повторения";
  const history = state.data.history.slice(-14).map((interval) => ({
    ...interval, value: valueFor(interval.rows.find((row) => row.username === username)),
  }));
  if (!history.length) {
    emptyChart("История начинается здесь", "После следующего снимка появится первый прирост. Стартовый тотал останется отдельно.");
    return;
  }
  if (!history.some((interval) => interval.value !== null)) {
    emptyChart("Пока нет истории игрока", "Нужны два успешных снимка, чтобы посчитать прирост по этому упражнению.");
    return;
  }
  const target = $("history-chart");
  target.replaceChildren();
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 320 164");
  svg.setAttribute("class", "chart-svg");
  svg.setAttribute("role", "img");
  const summary = history.map((interval) => `${displayTime(interval.to, true)}: ${interval.value === null ? "нет данных" : numeric.format(interval.value)}${interval.partial ? ", неполный день" : ""}`).join("; ");
  svg.setAttribute("aria-label", `Прирост ${shownName(username)} по снимкам. ${summary}`);
  const max = Math.max(1, ...history.map((interval) => interval.value || 0));
  const gap = 6;
  const step = 308 / history.length;
  history.forEach((interval, index) => {
    const bar = document.createElementNS(svgNS, "rect");
    const height = interval.value === null ? 2 : Math.max(2, interval.value / max * 116);
    const width = Math.min(32, step - gap);
    const x = 6 + step * index + (step - width) / 2;
    bar.setAttribute("x", String(x)); bar.setAttribute("y", String(136 - height));
    bar.setAttribute("width", String(width)); bar.setAttribute("height", String(height));
    bar.setAttribute("rx", "3");
    bar.setAttribute("fill", interval.value === null ? "#4c5745" : index === history.length - 1 ? "#c0f36b" : "#6f9450");
    const title = document.createElementNS(svgNS, "title");
    title.textContent = `${displayTime(interval.from)} — ${displayTime(interval.to)} МСК: ${formatValue(interval.value)}${interval.partial ? " · неполный интервал" : ""}`;
    bar.append(title); svg.append(bar);
    if (history.length <= 7 && interval.value !== null) {
      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", String(x + width / 2)); label.setAttribute("y", String(128 - height));
      label.setAttribute("fill", "#a3afa0"); label.setAttribute("font-size", "11"); label.setAttribute("text-anchor", "middle");
      label.textContent = numeric.format(interval.value);
      svg.append(label);
    }
  });
  const axis = document.createElementNS(svgNS, "path");
  axis.setAttribute("d", "M4 138H316"); axis.setAttribute("stroke", "#303a2d"); svg.append(axis);
  for (const [index, anchor, x] of [[0, "start", 6], [history.length - 1, "end", 314]]) {
    if (index === 0 && history.length === 1 && anchor === "end") continue;
    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", String(x)); label.setAttribute("y", "159"); label.setAttribute("fill", "#748370");
    label.setAttribute("font-size", "11"); label.setAttribute("text-anchor", anchor);
    label.textContent = displayTime(history[index].to, true); svg.append(label);
  }
  target.append(svg, node("p", "chart-caption", "Прирост между снимками · последние 14 интервалов. Стартовый тотал не включён."));
  const accessible = node("ul", "sr-only");
  history.forEach((interval) => accessible.append(node("li", "", `${displayTime(interval.from)} — ${displayTime(interval.to)}: ${formatValue(interval.value)}${interval.partial ? ", неполный интервал" : ""}`)));
  target.append(accessible);
}

function updateURL() {
  const url = new URL(window.location.href);
  url.searchParams.set("period", state.period);
  url.searchParams.set("exercise", state.exercise);
  url.searchParams.set("player", state.player);
  window.history.replaceState(null, "", url);
}

function render(announce = false) {
  const ranked = rankRows();
  for (const button of $("period-options").children) button.setAttribute("aria-pressed", String(button.dataset.period === state.period));
  renderSummary(ranked);
  renderRanking(ranked);
  renderDetail(ranked);
  updateURL();
  if (announce) $("announcement").textContent = `${currentPeriod().label}. ${selectedExercise()?.label || "Все повторения"}. Рейтинг обновлён.`;
}

async function load() {
  $("dashboard").setAttribute("aria-busy", "true");
  $("load-error").hidden = true;
  try {
    const response = await fetch("./data/dashboard.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.schema_version !== 1 || !Array.isArray(data.players) || !Array.isArray(data.exercises) || !data.periods?.length || !Array.isArray(data.history)) throw new Error("Unexpected data format");
    state.data = data;
    const params = new URLSearchParams(window.location.search);
    const wantedPeriod = params.get("period");
    state.period = data.periods.some((period) => period.id === wantedPeriod)
      ? wantedPeriod : data.periods.find((period) => period.id === "day" && period.available)?.id || "baseline";
    state.exercise = params.get("exercise") || state.exercise;
    const wantedPlayer = params.get("player") || state.player;
    state.player = data.players.find((player) => player.username === wantedPlayer)?.username || data.players[0]?.username || "";
    $("updated-at").textContent = `Последний снимок: ${displayTime(data.latest_at)} МСК`;
    makeFilters();
    renderParticipants();
    render();
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
