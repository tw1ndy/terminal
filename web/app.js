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
  function renderQueue(target, rows, kind) {
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
      const actions = node("div", "actions");
      for (const [action, label] of [["approve", "Подтвердить"], ["reject", "Отклонить"]]) {
        const button = node("button", action === "reject" ? "reject" : "", label);
        button.type = "button";
        button.addEventListener("click", () => decide(kind, row.id, action, button));
        actions.append(button);
      }
      item.append(main, actions);
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
  function render(data) {
    $("users").textContent = number(data.stats.users);
    $("messages").textContent = number(data.stats.messagesToday);
    $("xp").textContent = number(data.stats.lifetimeXp);
    $("pendingPurchases").textContent = number(data.stats.pendingPurchases);
    $("pendingPenalties").textContent = number(data.stats.pendingPenalties);
    $("purchaseCount").textContent = number(data.purchases.length);
    $("penaltyCount").textContent = number(data.penalties.length);
    $("seasonTitle").textContent = data.season?.title || "Активный сезон не создан";
    $("seasonDates").textContent = data.season ? date(data.season.starts_at) + " — " + date(data.season.ends_at) : "—";
    renderQueue($("purchases"), data.purchases, "purchase");
    renderQueue($("penalties"), data.penalties, "penalty");

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
  $("refresh").addEventListener("click", load);
  load();
})();
