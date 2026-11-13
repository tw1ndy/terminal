import base64
import json
import os
import urllib.request
from datetime import datetime, timezone

TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
GITHUB_TOKEN = os.environ["GITHUB_TOKEN"]
REPO = os.environ["GITHUB_REPOSITORY"]
STATE_PATH = "ton-price-bot/state.json"
API = "https://api.telegram.org/bot" + TOKEN + "/"
GH = "https://api.github.com/repos/" + REPO + "/contents/" + STATE_PATH


def request(url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=25) as response:
        return json.loads(response.read())


def tg(method, payload=None):
    return request(
        API + method,
        json.dumps(payload or {}).encode(),
        {"Content-Type": "application/json"},
    )


def load_state():
    try:
        result = request(
            GH,
            headers={
                "Authorization": "Bearer " + GITHUB_TOKEN,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
    except Exception as error:
        # Only a missing state file is an expected first-run condition.
        if getattr(error, "code", None) == 404:
            return {"chat_id": None, "offset": 0, "baseline": None, "last_hour": None}, None
        raise

    raw = base64.b64decode(result["content"]).decode()
    return json.loads(raw), result["sha"]


def save_state(state, sha):
    body = {
        "message": "Update TON Price Bot state",
        "content": base64.b64encode(
            json.dumps(state, ensure_ascii=False, indent=2).encode()
        ).decode(),
    }
    if sha:
        body["sha"] = sha
    request(
        GH,
        json.dumps(body).encode(),
        {
            "Authorization": "Bearer " + GITHUB_TOKEN,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        method="PUT",
    )


def send(chat_id, message):
    tg("sendMessage", {
        "chat_id": chat_id,
        "text": message,
        "disable_web_page_preview": True,
    })


def get_price():
    url = (
        "https://api.coingecko.com/api/v3/simple/price"
        "?ids=the-open-network&vs_currencies=rub&include_24hr_change=true"
    )
    data = request(url, headers={"User-Agent": "TON-Price-Bot/1.0"})
    item = data["the-open-network"]
    return float(item["rub"]), float(item.get("rub_24h_change", 0.0))


def price_message(price, change):
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return (
        "TON / RUB\n"
        f"Цена: {price:,.2f} ₽\n"
        f"Изменение за 24 часа: {change:+.2f}%\n"
        f"Обновлено: {stamp}"
    )


def main():
    state, state_sha = load_state()

    updates = tg("getUpdates", {
        "offset": state.get("offset", 0),
        "timeout": 0,
        "allowed_updates": ["message"],
    }).get("result", [])

    requested_price = False
    for update in updates:
        state["offset"] = max(state.get("offset", 0), update["update_id"] + 1)
        message = update.get("message", {})
        chat_id = message.get("chat", {}).get("id")
        command = message.get("text", "").strip().split("@")[0]

        if not chat_id:
            continue

        if command in ("/start", "/help"):
            state["chat_id"] = chat_id
            send(
                chat_id,
                "TON Price Bot подключён.\n"
                "Курс TON/RUB — каждый час. Проверка движения ±20% — "
                "от цены последнего уведомления.\n\n"
                "Команды:\n/price — текущая цена\n/status — состояние мониторинга",
            )
        elif command == "/price":
            state["chat_id"] = chat_id
            requested_price = True
        elif command == "/status":
            state["chat_id"] = chat_id
            baseline = state.get("baseline")
            baseline_text = f"{float(baseline):,.2f} ₽" if baseline else "ещё не установлена"
            send(chat_id, f"Мониторинг активен. Базовая цена для порога ±20%: {baseline_text}.")

    chat_id = state.get("chat_id")
    if not chat_id:
        save_state(state, state_sha)
        return

    price, change = get_price()
    if requested_price:
        send(chat_id, price_message(price, change))

    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y-%m-%d %H:%M UTC")
    baseline = state.get("baseline")

    if baseline is None:
        state["baseline"] = price
        send(
            chat_id,
            "Мониторинг TON/RUB запущен.\n"
            f"Текущая цена: {price:,.2f} ₽\n"
            f"Базовая цена: {price:,.2f} ₽",
        )
    else:
        baseline = float(baseline)
        delta = (price / baseline - 1) * 100 if baseline else 0.0
        if delta >= 20 or delta <= -20:
            direction = "ВЫРОС" if delta > 0 else "УПАЛ"
            send(
                chat_id,
                f"⚠️ TON {direction} на {delta:+.2f}% от последнего уведомления\n"
                f"Цена: {price:,.2f} ₽\n"
                f"Предыдущая база: {baseline:,.2f} ₽\n"
                f"Время: {stamp}",
            )
            state["baseline"] = price

    hour = now.strftime("%Y-%m-%d %H")
    if state.get("last_hour") != hour:
        send(chat_id, price_message(price, change))
        state["last_hour"] = hour

    save_state(state, state_sha)


if __name__ == "__main__":
    main()
