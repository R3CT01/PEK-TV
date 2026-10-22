"""Weather for the Flutter UI: current conditions and a 5-day forecast for a city you pick.

Data: Open-Meteo (no key). The chosen city and unit are kept in this plugin's data/settings.json.
"""
import datetime

import pek_host as h
import pek_ui as ui

GEO = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST = "https://api.open-meteo.com/v1/forecast"
SETTINGS = "settings.json"

CODES = {
    0: "Clear sky", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Freezing fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Rain showers", 81: "Rain showers",
    82: "Violent showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm", 96: "Thunderstorm, hail",
    99: "Thunderstorm, hail",
}

S = {"place": None, "unit": "F", "query": "", "found": None, "data": None, "busy": "", "error": ""}


def _load():
    try:
        j = h.read_json(SETTINGS)
        if isinstance(j, dict):
            if isinstance(j.get("place"), dict):
                S["place"] = j["place"]
            if j.get("unit") in ("C", "F"):
                S["unit"] = j["unit"]
    except Exception:
        pass


def _save():
    try:
        h.write_json(SETTINGS, {"place": S["place"], "unit": S["unit"]})
    except Exception:
        pass


def _temp(c):
    if c is None:
        return "--"
    v = c * 9 / 5 + 32 if S["unit"] == "F" else c
    return "%d\u00b0%s" % (round(v), S["unit"])


def _refresh():
    p = S["place"]
    if not p:
        return
    S["busy"] = "Loading the weather..."
    S["error"] = ""
    url = ("%s?latitude=%s&longitude=%s&current=temperature_2m,weather_code,wind_speed_10m"
           "&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=5&timezone=auto"
           % (FORECAST, p["lat"], p["lon"]))

    def work():
        return h.fetch_json(url, timeout=8)

    def done(j):
        S["data"] = j
        S["busy"] = ""

    def fail(message):
        S["busy"] = ""
        S["error"] = "Could not reach the weather service."

    ui.background(work, done, fail)


def start():
    _load()
    _refresh()


def _search(text=None):
    q = (text if text is not None else S["query"]).strip()
    S["query"] = q
    if len(q) < 2:
        return
    S["busy"] = "Searching..."
    S["error"] = ""
    url = "%s?name=%s&count=6&language=en" % (GEO, q.replace(" ", "%20"))

    def work():
        return h.fetch_json(url, timeout=8)

    def done(j):
        S["busy"] = ""
        S["found"] = j.get("results") or []
        if not S["found"]:
            S["error"] = "No city found with that name."

    def fail(message):
        S["busy"] = ""
        S["error"] = "Could not search right now."

    ui.background(work, done, fail)


def _choose(r):
    label = r.get("name", "")
    if r.get("admin1"):
        label += ", " + r["admin1"]
    elif r.get("country"):
        label += ", " + r["country"]
    S["place"] = {"lat": r.get("latitude"), "lon": r.get("longitude"), "label": label}
    S["found"] = None
    S["query"] = ""
    S["data"] = None
    _save()
    _refresh()


def _set_unit(u):
    S["unit"] = u
    _save()


def _change_city():
    S["place"] = None
    S["data"] = None


def _day(s):
    try:
        return datetime.date.fromisoformat(s).strftime("%A")
    except Exception:
        return s


def render():
    kids = [ui.heading("Weather")]
    if S["busy"]:
        kids.append(ui.spinner(S["busy"]))
    if S["error"]:
        kids.append(ui.text(S["error"]))
    p = S["place"]
    if not p or S["found"] is not None:
        kids.append(ui.text("Type a city and press Search."))
        kids.append(ui.text_input("City", S["query"], lambda t: S.update(query=t), placeholder="e.g. St. Louis",
                                  on_submit=_search, key="city"))
        kids.append(ui.button("Search", _search, primary=True))
        for r in (S["found"] or []):
            sub = ", ".join(x for x in (r.get("admin1"), r.get("country")) if x)
            kids.append(ui.list_row(r.get("name", ""), sub, lambda r=r: _choose(r)))
        return ui.column(*kids)
    d = S["data"]
    kids.append(ui.text(p.get("label", "")))
    if d and isinstance(d.get("current"), dict):
        cur = d["current"]
        kids.append(ui.heading(_temp(cur.get("temperature_2m"))))
        kids.append(ui.text("%s \u00b7 wind %s km/h" % (CODES.get(cur.get("weather_code"), "Clear"), round(cur.get("wind_speed_10m") or 0))))
        daily = d.get("daily") or {}
        days = daily.get("time") or []
        for i, day in enumerate(days):
            kids.append(ui.card(
                _day(day),
                "%s \u00b7 high %s \u00b7 low %s" % (
                    CODES.get(daily["weather_code"][i], ""), _temp(daily["temperature_2m_max"][i]), _temp(daily["temperature_2m_min"][i]))))
    kids.append(ui.row(
        ui.button("Celsius", lambda: _set_unit("C"), selected=S["unit"] == "C"),
        ui.button("Fahrenheit", lambda: _set_unit("F"), selected=S["unit"] == "F"),
        ui.button("Refresh", _refresh),
        ui.button("Change city", _change_city),
    ))
    return ui.column(*kids)
