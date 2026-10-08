"""Add a search site to Hesper P2P in one step.

IMPORTANT: keep this file OUTSIDE the plugin folder (Hesper refuses plugins that contain scripts like this one).

Usage:   python add_site.py "https://example.org/search?q={q}"  [path-to-hesper-p2p-folder]
         python add_site.py --list [path-to-hesper-p2p-folder]
         python add_site.py --image-host cdn.example.org [path-to-hesper-p2p-folder]

--image-host lets Hesper show thumbnails served from another host (Settings in the plugin lists the ones it found).

It puts the link in ui.js and release_search.py, and adds the site's host to plugin.json.
Then zip the folder again and reinstall the plugin in Hesper.
"""
import json
import re
import sys
from urllib.parse import urlsplit


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 1
    if args[0] == "--list":
        folder = args[1] if len(args) > 1 else "hesper-p2p"
        text = open(folder + "/ui.js", encoding="utf-8").read()
        block = text[text.index("// SITES-START"):text.index("// SITES-END")]
        links = re.findall(r"'(https://[^']+)'", block)
        print("\n".join(links) if links else "No sites yet.")
        return 0
    if args[0] == "--image-host":
        if len(args) < 2:
            print(__doc__)
            return 1
        host = args[1].strip().lower()
        folder = args[2] if len(args) > 2 else "hesper-p2p"
        if not re.fullmatch(r"(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+", host) or re.fullmatch(r"[0-9.]+", host):
            print("Use a normal host name such as cdn.example.org (or *.example.org), not an IP address.")
            return 1
        mpath = folder + "/plugin.json"
        manifest = json.load(open(mpath, encoding="utf-8"))
        hosts = manifest["permissions"].setdefault("network", [])
        if host in hosts:
            print(host, "is already allowed.")
        else:
            hosts.append(host)
            json.dump(manifest, open(mpath, "w", encoding="utf-8"), indent=2)
            print("added image host", host, "to plugin.json. Zip the folder again and reinstall the plugin.")
        return 0
    url = args[0].strip()
    folder = args[1] if len(args) > 1 else "hesper-p2p"
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or "{q}" not in url or "'" in url or '"' in url:
        print("The link must start with https:// and contain {q} where the search words go.")
        print("Example: https://example.org/search?q={q}")
        return 1
    host = parts.hostname.lower()
    if re.fullmatch(r"[0-9.:]+", host) or "." not in host:
        print("Use a normal site name, not an IP address.")
        return 1

    # ui.js (single quotes) and release_search.py (double quotes)
    for name, line in (("ui.js", "        '%s',\n" % url), ("release_search.py", '    "%s",\n' % url)):
        path = folder + "/" + name
        text = open(path, encoding="utf-8").read()
        end = "// SITES-END" if name == "ui.js" else "# SITES-END"
        i = text.index(end)
        i = text.rfind("\n", 0, i) + 1               # start of the SITES-END line
        if line.strip() in text:
            print("%s already has this link." % name)
            continue
        text = text[:i] + line + text[i:]
        open(path, "w", encoding="utf-8").write(text)
        print("added to", name)

    mpath = folder + "/plugin.json"
    manifest = json.load(open(mpath, encoding="utf-8"))
    hosts = manifest["permissions"].setdefault("network", [])
    if host not in hosts:
        hosts.append(host)
        json.dump(manifest, open(mpath, "w", encoding="utf-8"), indent=2)
        print("added host", host, "to plugin.json")
    print("Done. Zip the folder again and reinstall the plugin in Hesper.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
