(() => {
  const tg = window.Telegram?.WebApp;
  const notice = document.getElementById("notice");
  const $ = id => document.getElementById(id);
  if (tg) { tg.ready(); tg.expand(); }
  const initData = tg?.initData || "";

  function setNotice(message, type = "") {
    notice.textContent = message;
    notice.className = "notice" + (type ? " " + type : "");
  }
  function number(value) { return new Intl.NumberFormat("ru-RU").format(Number(value || 0)); }
  function date(value) {
    return value ? new Date(Number(value) * 1000).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" }) : "—";
  }
  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { "Authorization": "tma " + initData, ...(options.headers || {}) }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error === "unauthorized" ? "Нет доступа. Открой панель из Telegram-бота с правами администратора." : (body.error === "insufficient_xp" ? "У участника недостаточно доступных XP." : body.error === "not_pending" ? "Заявка уже обработана или не найдена." : body.error || "Ошибка запроса"));
    return body;
  }
  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = String(text);
    return el;
  }
  function empty(target, text) { target.replaceChildren(node("p", "empty", text)); }
  function renderQueue(target, rows, kind, canAct = true) {
    target.replaceChildren();
    if (!rows.length) { empty(target, "Нет ожидающих заявок."); return; }
    for (const row of rows) {
      const item = node("div", "item");
      const main = node("div", "item-main");
      const title = kind === "purchase" ? row.title : "Штраф · " + number(row.suggested_amount) + " XP";
      main.append(node("div", "item-title", "#" + row.id + " · " + title));
      const person = row.username ? "@" + row.username : (row.first_name || "Участник");
      const detail = kind === "purchase"
        ? person + " · " + number(row.price_xp) + " XP · " + date(row.created_at)
        : person + " · ID " + row.telegram_id + " · " + row.reason + " · " + date(row.created_at);
      main.append(node("div", "item-meta", detail));
      if (canAct) {
        const actions = node("div", "actions");
        for (const [action, label] of [["approve", "Подтвердить"], ["reject", "Отклонить"]]) {
          const button = node("button", action === "reject" ? "reject" : "", label);
          button.type = "button";
          button.addEventListener("click", () => decide(kind, row.id, action, button));
          actions.append(button);
        }
        item.append(main, actions);
      } else item.append(main);
      target.append(item);
    }
  }
  async function decide(kind, id, action, button) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "…";
    try {
      await api("/api/admin/" + (kind === "purchase" ? "purchases/" : "penalties/") + id + "/" + action, { method: "POST" });
      setNotice((kind === "purchase" ? "Покупка" : "Штраф") + " #" + id + ": решение сохранено.", "success");
      await load();
    } catch (error) {
      setNotice(error.message, "error");
      button.disabled = false;
      button.textContent = label;
    }
  }
  function renderMembers(rows) {
    const target = $("members");
    target.replaceChildren();
    $("memberCount").textContent = number(rows.length);
    if (!rows.length) { empty(target, "Участники не найдены."); return; }
    rows.forEach(row => {
      const item = node("div", "item member-item");
      const main = node("div", "item-main");
      const name = [row.first_name, row.last_name].filter(Boolean).join(" ") || (row.username ? "@" + row.username : "Участник");
      main.append(node("div", "item-title", name + (row.username ? " · @" + row.username : "")));
      main.append(node("div", "item-meta", "ID " + row.telegram_id + " · " + (row.is_active ? "Активен" : "Неактивен") + " · Регистрация: " + date(row.joined_at) + " · Последняя активность: " + date(row.last_seen_at)));
      main.append(node("div", "item-meta", "Lifetime: " + number(row.lifetime_xp) + " XP · Доступно: " + number(row.available_xp) + " XP · Сезон: " + number(row.season_xp) + " XP"));
      main.append(node("div", "item-meta", "Сообщений: " + number(row.message_count) + " · Серия: " + number(row.current_streak) + " дн. · Рекорд: " + number(row.longest_streak) + " дн."));
      item.append(main);
      if (window.__membersManage) {
        const controls = node("div", "prefix-controls");
        const input = node("input", "prefix-input");
        input.type = "text";
        input.maxLength = 48;
        input.placeholder = "Название префикса";
        input.value = row.prefix_title || "";
        const save = node("button", "", "Выдать");
        save.type = "button";
        save.addEventListener("click", () => updatePrefix(row.telegram_id, input.value, save));
        const remove = node("button", "remove-prefix", "Снять");
        remove.type = "button";
        remove.addEventListener("click", () => updatePrefix(row.telegram_id, "", remove));
        controls.append(input, save, remove);
        item.append(controls);
      }
      target.append(item);
    });
  }
  async function updatePrefix(telegramId, title, button) {
    const cleanTitle = String(title || "").trim();
    if (cleanTitle.length > 48) { setNotice("Префикс должен быть не длиннее 48 символов.", "error"); return; }
    if (!confirm(cleanTitle ? "Выдать префикс «" + cleanTitle + "» участнику " + telegramId + "?" : "Снять вручную назначенные префиксы у участника " + telegramId + "?")) return;
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "…";
    try {
      await api("/api/admin/members/" + encodeURIComponent(telegramId) + "/prefix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: cleanTitle })
      });
      setNotice(cleanTitle ? "Префикс выдан." : "Ручной префикс снят.", "success");
      await loadMembers();
    } catch (error) {
      setNotice(error.message, "error");
      button.disabled = false;
      button.textContent = oldText;
    }
  }
  async function loadMembers(query = $("memberQuery").value.trim()) {
    try {
      const data = await api("/api/admin/members?q=" + encodeURIComponent(query));
      renderMembers(data.members || []);
    } catch (error) {
      empty($("members"), error.message);
    }
  }
  function render(data) {
    $("users").textContent = number(data.stats.users);
    $("messages").textContent = number(data.stats.messagesToday);
    $("xp").textContent = number(data.stats.lifetimeXp);
    $("pendingPurchases").textContent = number(data.stats.pendingPurchases);
    $("pendingPenalties").textContent = number(data.stats.pendingPenalties);
    $("purchaseCount").textContent = number(data.purchases.length);
    $("penaltyCount").textContent = number(data.penalties.length);
    $("settingsPanel").hidden = !data.permissions.settingsManage;
    $("membersPanel").hidden = !data.permissions.membersView;
    window.__membersManage = Boolean(data.permissions.membersManage);
    if (data.permissions.membersView) loadMembers();
    $("seasonTitle").textContent = data.season?.title || "Активный сезон не создан";
    $("seasonDates").textContent = data.season ? date(data.season.starts_at) + " — " + date(data.season.ends_at) : "—";
    $("settingMessageXp").value = data.settings.messageXp;
    $("settingDailyCap").value = data.settings.dailyXpCap;
    $("settingSeasonDays").value = data.settings.seasonDays;
    $("settingLevelThresholds").value = JSON.stringify(data.settings.levelThresholds || {}, null, 2);
    $("settingSeasonRewards").value = JSON.stringify(data.settings.seasonRewardSchedule || {}, null, 2);
    renderQueue($("purchases"), data.purchases, "purchase", data.permissions.shopReview);
    renderQueue($("penalties"), data.penalties, "penalty", data.permissions.penaltyReview);

    const top = $("top");
    top.replaceChildren();
    if (!data.top.length) empty(top, "Рейтинг пока пуст.");
    data.top.forEach((row, index) => {
      const line = node("div", "leader");
      line.append(node("span", "rank", String(index + 1).padStart(2, "0")));
      line.append(node("span", "leader-name", row.first_name || (row.username ? "@" + row.username : "Участник")));
      line.append(node("strong", "leader-xp", number(row.lifetime_xp) + " XP"));
      top.append(line);
    });

    const logs = $("logs");
    logs.replaceChildren();
    if (!data.logs.length) empty(logs, "Действий пока нет.");
    data.logs.forEach(row => {
      const line = node("div", "log");
      line.append(node("strong", "", row.action));
      line.append(node("span", "", "Администратор " + row.actor_id + " · объект " + (row.target_id || "—") + " · " + date(row.created_at)));
      logs.append(line);
    });

    const fraud = $("fraud");
    $("fraudCount").textContent = number(data.fraudEvents.length);
    fraud.replaceChildren();
    if (!data.fraudEvents.length) empty(fraud, "Новых сигналов нет.");
    data.fraudEvents.forEach(row => {
      const item = node("div", "item");
      const main = node("div", "item-main");
      main.append(node("div", "item-title", (row.event_type === "flood" ? "Возможный флуд" : "Повторяющийся текст") + " · ID " + row.telegram_id));
      let detail = "";
      try {
        const parsed = JSON.parse(row.details_json);
        detail = "Сообщений за 10 сек.: " + number(parsed.messages_in_10_seconds) + " · Повторов за 60 сек.: " + number(parsed.repeated_identical_messages_in_60_seconds);
      } catch { detail = "Детали недоступны"; }
      main.append(node("div", "item-meta", detail + " · " + date(row.created_at)));
      if (data.permissions.antifraudReview) {
        const button = node("button", "", "Проверено");
        button.type = "button";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try { await api("/api/admin/antifraud/" + row.id + "/review", { method: "POST" }); await load(); }
          catch (error) { setNotice(error.message, "error"); button.disabled = false; }
        });
        const actions = node("div", "actions");
        actions.append(button);
        item.append(main, actions);
      } else item.append(main);
      fraud.append(item);
    });
  }
  async function load() {
    if (!initData) {
      setNotice("Панель доступна только при открытии через Telegram Web App. Запусти её из меню бота.", "error");
      return;
    }
    $("refresh").disabled = true;
    try {
      const data = await api("/api/admin/dashboard");
      render(data);
      setNotice("Доступ подтверждён. Данные панели обновлены.", "success");
    } catch (error) {
      setNotice(error.message, "error");
    } finally {
      $("refresh").disabled = false;
    }
  }
  $("saveSettings").addEventListener("click", async () => {
    const button = $("saveSettings");
    button.disabled = true;
    try {
      await api("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageXp: Number($("settingMessageXp").value),
          dailyXpCap: Number($("settingDailyCap").value),
          seasonDays: Number($("settingSeasonDays").value),
          levelThresholds: JSON.parse($("settingLevelThresholds").value || "{}"),
          seasonRewardSchedule: JSON.parse($("settingSeasonRewards").value || "{}")
        })
      });
      setNotice("Параметры экономики сохранены.", "success");
      await load();
    } catch (error) {
      setNotice(error.message === "invalid_settings" ? "Проверь экономику, пороги уровней и награды сезона (места 1–10, XP от 0 до 1000000): уровень 1 = 0 XP, уровни подряд, каждый следующий порог выше предыдущего; максимум 100 уровней." : (error instanceof SyntaxError ? "Пороги уровней должны быть корректным JSON-объектом." : error.message), "error");
    } finally { button.disabled = false; }
  });
  $("searchMembers").addEventListener("click", () => loadMembers());
  $("memberQuery").addEventListener("keydown", event => { if (event.key === "Enter") loadMembers(); });
  $("refresh").addEventListener("click", load);
  load();
})();
