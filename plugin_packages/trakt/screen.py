"""Trakt for PEK TV: sign in, choose what is shared, import your Trakt history.

The scrobbling itself (what you watch, while you watch it) is hooks.py; this screen is only for setting up.
"""
import time

import pek_host as h
import pek_ui as ui
import trakt_core as tc

S = {"linked": False, "user": "", "login": None, "msg": "", "busy": "", "set": {}, "advanced": False, "id": "", "secret": ""}


def trakt():
    return tc.Trakt(h)


def start():
    t = trakt()
    S["linked"] = t.linked()
    S["set"] = {k: t.on(k) for k in ("scrobble", "push", "pull", "ratings", "favorites", "removals")}
    S["id"], S["secret"] = t.settings["client_id"], t.settings["client_secret"]
    if S["linked"]:
        ui.background(lambda: trakt().username(), got_user, quiet)


def quiet(message):
    h.log("background job failed:", message)


def got_user(name):
    S["user"] = name or ""


# ------------------------------------------------------------------------------------------------ sign in
def connect():
    S["msg"], S["busy"] = "", "login"
    ui.background(lambda: trakt().start_login(), got_code, login_failed)


def got_code(d):
    url = str(d.get("verification_url") or "")
    if not url.startswith("https://trakt.tv"):
        url = "https://trakt.tv/activate"
    S["login"] = {"code": str(d["user_code"]), "device": str(d["device_code"]), "url": url,
                  "interval": max(3, min(15, int(d.get("interval") or 5))),
                  "until": time.time() + min(900, int(d.get("expires_in") or 600))}
    S["busy"] = ""
    poll()


def poll():
    lg = S["login"]
    ui.background(lambda: wait_and_check(lg), polled, login_failed)


def wait_and_check(lg):
    time.sleep(lg["interval"])
    if S["login"] is not lg:
        return "cancelled"
    return trakt().poll_login(lg["device"])


def polled(res):
    lg = S["login"]
    if lg is None or res == "cancelled":
        return
    if res == "ok":
        S["login"], S["linked"], S["msg"] = None, True, "Connected to Trakt."
        S["busy"] = "sync" if S["set"].get("pull") else ""
        ui.background(first_run, first_done, sync_failed)
    elif res == "pending":
        if time.time() > lg["until"]:
            S["login"], S["msg"] = None, "The code expired. Tap Connect to get a new one."
        else:
            poll()
    elif res == "slow":
        lg["interval"] += 5
        poll()
    else:
        S["login"] = None
        S["msg"] = {"expired": "The code expired. Tap Connect to get a new one.",
                    "denied": "Trakt said no. Nothing was connected."}.get(res, "Could not sign in. Please try again.")


def first_run():
    """Right after signing in: the user name, then (if switched on) the first import. One job, so they never write the same file at once."""
    t = trakt()
    name = t.username()
    if S["set"].get("pull"):
        return name, tuple(t.pull(time.time() + 18)) + ([],)      # (items, finished, error) + nothing removed yet
    return name, None


def first_done(res):
    name, pulled = res
    S["user"] = name or ""
    if pulled is None:
        S["busy"] = ""
    else:
        sync_done(pulled)


def login_failed(message):
    S["login"], S["busy"] = None, ""
    S["msg"] = "Could not reach Trakt: " + str(message)[:120]


def cancel():
    S["login"], S["msg"] = None, ""


def disconnect():
    S["busy"] = "out"
    ui.background(lambda: trakt().revoke(), signed_out, signed_out)


def signed_out(unused=None):
    S["linked"], S["user"], S["busy"], S["msg"] = False, "", "", "Disconnected. Your PEK TV history was not changed."


# ------------------------------------------------------------------------------------------------ history
def sync():
    S["busy"], S["msg"] = "sync", ""
    ui.background(sync_work, sync_done, sync_failed)


def sync_work():
    t = trakt()
    items, finished, error = t.pull(time.time() + 14)
    t.flush_queue(time.time() + 4)
    gone = []
    if finished and not error:
        gone, f2, e2 = t.pull_removed(time.time() + 8, report=t.on("removals"))
    return items, finished, error, gone


def sync_done(res):
    items, finished, error, gone = res
    for i in range(0, len(items), 300):
        ui.set_watched_many(items[i:i + 300], True)
    for i in range(0, len(gone), 300):
        ui.set_watched_many(gone[i:i + 300], False)
    S["busy"] = ""
    if error:
        S["msg"] = "Import stopped: " + error
    elif finished:
        S["msg"] = "Your Trakt history is in PEK TV (%d titles checked)." % len(items) + (" %d removed on Trakt were removed here too." % len(gone) if gone else "")
    else:
        S["msg"] = "Imported %d titles so far. Tap Import again to continue." % len(items)


def sync_failed(message):
    S["busy"] = ""
    S["msg"] = "Import stopped: " + str(message)[:120]


# ------------------------------------------------------------------------------------------------ ratings
def send_ratings():
    """Uploads every rating this profile has in PEK TV (the hooks only send new ones), and brings Trakt's in."""
    S["busy"], S["msg"] = "ratings", ""
    mine = ui.ratings()
    ui.background(lambda: ratings_work(mine), ratings_done, sync_failed)


def ratings_work(mine):
    t = trakt()
    sent, missed = 0, 0
    for i in range(0, len(mine), 100):
        a, b = t.push_ratings(mine[i:i + 100], time.time() + 8)
        sent, missed = sent + a, missed + b
    items, finished, error = t.pull_ratings(time.time() + 12)
    return sent, missed, items, error


def ratings_done(res):
    sent, missed, items, error = res
    for i in range(0, len(items), 300):
        ui.set_ratings_many(items[i:i + 300])
    S["busy"] = ""
    S["msg"] = "Sent %d ratings to Trakt (%d not found there), received %d." % (sent, missed, len(items)) + (" Stopped: " + error if error else "")


# ------------------------------------------------------------------------------------------------ favorites
def send_favorites():
    """Uploads every favorite movie / show this profile has in PEK TV (the hooks only send new ones), and brings Trakt's in."""
    S["busy"], S["msg"] = "favs", ""
    mine = ui.favorites()
    ui.background(lambda: favorites_work(mine), favorites_done, sync_failed)


def favorites_work(mine):
    t = trakt()
    sent, missed = 0, 0
    for i in range(0, len(mine), 100):
        a, b = t.push_favorites(mine[i:i + 100], True, time.time() + 8)
        sent, missed = sent + a, missed + b
    items, removed, finished, error = t.pull_favorites(time.time() + 12, removals=t.on("removals"))
    return sent, missed, items, removed, error


def favorites_done(res):
    sent, missed, items, removed, error = res
    for i in range(0, len(items), 300):
        ui.set_favorites_many(items[i:i + 300], True)
    for i in range(0, len(removed), 300):
        ui.set_favorites_many(removed[i:i + 300], False)
    S["busy"] = ""
    S["msg"] = ("Sent %d favorites to Trakt (%d not found there), received %d." % (sent, missed, len(items)) + (" %d removed on Trakt were removed here too." % len(removed) if removed else "")
                + (" Stopped: " + error if error else ""))


# ------------------------------------------------------------------------------------------------ settings
def flip(key, value):
    S["set"][key] = bool(value)
    trakt().set_setting(key, bool(value))


def set_id(text):
    S["id"] = text.strip()


def set_secret(text):
    S["secret"] = text.strip()


def use_own_app():
    if not S["id"]:
        S["msg"] = "Enter the client id of your Trakt app."
        return
    t = trakt()
    t.set_setting("client_id", S["id"])
    t.set_setting("client_secret", S["secret"])
    t.forget()
    S["linked"], S["user"], S["msg"] = False, "", "Saved. Tap Connect to sign in with your own Trakt app."


def use_pek_app():
    t = trakt()
    t.set_setting("client_id", "")
    t.set_setting("client_secret", "")
    t.forget()
    S["id"], S["secret"] = "", ""
    S["linked"], S["user"], S["msg"] = False, "", "Using PEK TV's Trakt app. Tap Connect to sign in."


def toggle_advanced():
    S["advanced"] = not S["advanced"]


# ------------------------------------------------------------------------------------------------ drawing
def render():
    kids = [ui.heading("Trakt")]
    lg = S["login"]
    if lg:
        kids += [ui.text("On your phone or computer, open " + lg["url"].replace("https://", "") + " and enter this code:"),
                 ui.heading(lg["code"]),
                 ui.spinner("Waiting for you to approve it on Trakt..."),
                 ui.button("Cancel", on=cancel)]
    elif S["linked"]:
        kids += [ui.text("Connected" + (" as " + S["user"] if S["user"] else "") + "."),
                 ui.toggle("Send what I watch to Trakt (scrobble)", S["set"].get("scrobble", True), lambda v: flip("scrobble", v)),
                 ui.toggle("Send my 'mark watched' changes to Trakt", S["set"].get("push", True), lambda v: flip("push", v)),
                 ui.toggle("Import my Trakt history when PEK TV starts", S["set"].get("pull", True), lambda v: flip("pull", v)),
                 ui.toggle("Share my ratings with Trakt (both ways)", S["set"].get("ratings", True), lambda v: flip("ratings", v)),
                 ui.toggle("Share my favorite movies and shows with Trakt (both ways)", S["set"].get("favorites", True), lambda v: flip("favorites", v)),
                 ui.toggle("Remove here what I remove on Trakt (watches, ratings, favorites)", S["set"].get("removals", True), lambda v: flip("removals", v))]
        if S["busy"] == "sync":
            kids.append(ui.spinner("Importing from Trakt..."))
        elif S["busy"] == "ratings":
            kids.append(ui.spinner("Syncing ratings..."))
        elif S["busy"] == "favs":
            kids.append(ui.spinner("Syncing favorites..."))
        elif S["busy"] == "out":
            kids.append(ui.spinner("Disconnecting..."))
        else:
            kids += [ui.button("Import my Trakt history now", on=sync, primary=True),
                     ui.button("Send all my ratings to Trakt now", on=send_ratings),
                     ui.button("Send all my favorites to Trakt now", on=send_favorites),
                     ui.button("Disconnect", on=disconnect)]
    else:
        kids.append(ui.text("Connect your Trakt account to scrobble what you watch in PEK TV and to see your Trakt history here. "
                            "PEK TV shows you a code; you approve it on trakt.tv. Your password is never typed into PEK TV."))
        if S["busy"] == "login":
            kids.append(ui.spinner("Asking Trakt for a code..."))
        else:
            kids.append(ui.button("Connect to Trakt", on=connect, primary=True))
    if S["msg"]:
        kids.append(ui.text(S["msg"]))
    kids.append(ui.button("Use my own Trakt app" if not S["advanced"] else "Hide advanced", on=toggle_advanced))
    if S["advanced"]:
        kids += [ui.text("Optional. Create an app at trakt.tv/oauth/applications (redirect uri urn:ietf:wg:oauth:2.0:oob) and enter its client id. "
                         "A client secret is only needed for an older app that still has one. It stays on this device."),
                 ui.text_input("Client id", S["id"], on_change=set_id),
                 ui.text_input("Client secret (optional)", S["secret"], on_change=set_secret, secret=True),
                 ui.button("Save and use my app", on=use_own_app),
                 ui.button("Go back to PEK TV's app", on=use_pek_app)]
    return ui.column(*kids)
