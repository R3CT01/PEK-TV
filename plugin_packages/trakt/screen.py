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
    S["set"] = {k: t.on(k) for k in ("scrobble", "push", "pull")}
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
        return name, t.pull(time.time() + 18)
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
    result = t.pull(time.time() + 18)
    t.flush_queue(time.time() + 5)
    return result


def sync_done(res):
    items, finished, error = res
    for i in range(0, len(items), 300):
        ui.set_watched_many(items[i:i + 300], True)
    S["busy"] = ""
    if error:
        S["msg"] = "Import stopped: " + error
    elif finished:
        S["msg"] = "Your Trakt history is in PEK TV (%d titles checked)." % len(items)
    else:
        S["msg"] = "Imported %d titles so far. Tap Import again to continue." % len(items)


def sync_failed(message):
    S["busy"] = ""
    S["msg"] = "Import stopped: " + str(message)[:120]


# ------------------------------------------------------------------------------------------------ settings
def flip(key, value):
    S["set"][key] = bool(value)
    trakt().set_setting(key, bool(value))


def set_id(text):
    S["id"] = text.strip()


def set_secret(text):
    S["secret"] = text.strip()


def use_own_app():
    if not (S["id"] and S["secret"]):
        S["msg"] = "Enter both the client id and the client secret of your Trakt app."
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
                 ui.toggle("Import my Trakt history when PEK TV starts", S["set"].get("pull", True), lambda v: flip("pull", v))]
        if S["busy"] == "sync":
            kids.append(ui.spinner("Importing from Trakt..."))
        elif S["busy"] == "out":
            kids.append(ui.spinner("Disconnecting..."))
        else:
            kids += [ui.button("Import my Trakt history now", on=sync, primary=True), ui.button("Disconnect", on=disconnect)]
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
        kids += [ui.text("Optional. Create an app at trakt.tv/oauth/applications (redirect uri urn:ietf:wg:oauth:2.0:oob) and enter its id and secret. "
                         "They stay on this device."),
                 ui.text_input("Client id", S["id"], on_change=set_id),
                 ui.text_input("Client secret", S["secret"], on_change=set_secret, secret=True),
                 ui.button("Save and use my app", on=use_own_app),
                 ui.button("Go back to PEK TV's app", on=use_pek_app)]
    return ui.column(*kids)
