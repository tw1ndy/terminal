import json, os, time, urllib.request, urllib.parse, urllib.error
from datetime import datetime, timezone

TOKEN=os.environ["TELEGRAM_BOT_TOKEN"]
GITHUB_TOKEN=os.environ["GITHUB_TOKEN"]
REPO=os.environ["GITHUB_REPOSITORY"]
STATE_PATH="ton-price-bot/state.json"
API="https://api.telegram.org/bot"+TOKEN+"/"
GH="https://api.github.com/repos/"+REPO+"/contents/"+STATE_PATH

def request(url, data=None, headers=None):
    req=urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=25) as r: return json.loads(r.read())

def tg(method, payload=None):
    return request(API+method, json.dumps(payload or {}).encode(), {"Content-Type":"application/json"})

def load_state():
    try:
        x=request(GH, headers={"Authorization":"Bearer "+GITHUB_TOKEN,"Accept":"application/vnd.github+json"})
        raw=__import__("base64").b64decode(x["content"]).decode()
        return json.loads(raw), x["sha"]
    except Exception:
        return {"chat_id":None,"offset":0,"baseline":None,"last_hour":None}, None

def save_state(state, sha):
    import base64
    body={"message":"Update TON bot state","content":base64.b64encode(json.dumps(state,ensure_ascii=False,indent=2).encode()).decode()}
    if sha: body["sha"]=sha
    request(GH, json.dumps(body).encode(), {"Authorization":"Bearer "+GITHUB_TOKEN,"Accept":"application/vnd.github+json","Content-Type":"application/json"})

def send(chat, text):
    tg("sendMessage", {"chat_id":chat,"text":text,"disable_web_page_preview":True})

def main():
    state, sha=load_state()
    # Learn chat id from /start and allow commands.
    updates=tg("getUpdates", {"offset":state.get("offset",0),"timeout":0,"allowed_updates":["message"]}).get("result",[])
    for u in updates:
        state["offset"]=max(state.get("offset",0),u["update_id"]+1)
        m=u.get("message",{}); chat=m.get("chat",{}).get("id"); txt=m.get("text","").strip()
        if chat and txt.startswith("/start"):
            state["chat_id"]=chat
            send(chat,"TON Price Bot подключён. Буду присылать курс TON/RUB каждый час и предупреждать о движении ±20% от цены последнего уведомления.")
        elif chat and txt.startswith("/price"):
            state["chat_id"]=chat
    chat=state.get("chat_id")
    if not chat:
        save_state(state,sha); return
    url="https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=rub&include_24hr_change=true"
    data=request(url, headers={"User-Agent":"TON-Price-Bot/1.0"})
    item=data["the-open-network"]; price=float(item["rub"]); change=float(item.get("rub_24h_change",0))
    now=datetime.now(timezone.utc); stamp=now.strftime("%Y-%m-%d %H:%M UTC")
    baseline=state.get("baseline")
    if baseline is None:
        state["baseline"]=price
        send(chat,f"Мониторинг TON/RUB запущен.\nТекущая цена: {price:,.2f} ₽\nБазовая цена: {price:,.2f} ₽")
    else:
        delta=(price/float(baseline)-1)*100 if baseline else 0
        if delta>=20 or delta<=-20:
            direction="ВЫРОС" if delta>0 else "УПАЛ"
            send(chat,f"⚠️ TON {direction} на {delta:+.2f}% от последнего уведомления\nЦена: {price:,.2f} ₽\nПредыдущая база: {float(baseline):,.2f} ₽\nВремя: {stamp}")
            state["baseline"]=price
    hour=now.strftime("%Y-%m-%d %H")
    if state.get("last_hour")!=hour:
        send(chat,f"TON / RUB\nЦена: {price:,.2f} ₽\nИзменение за 24 часа: {change:+.2f}%\nОбновлено: {stamp}")
        state["last_hour"]=hour
    save_state(state,sha)

if __name__=="__main__":
    main()
