#!/data/data/com.termux/files/usr/bin/bash
# Hesper repo cleanup for the "android" branch.
#   bash cleanup_android.sh        preview only (changes nothing)
#   bash cleanup_android.sh --go   do it, then make one commit
# Run it anywhere inside the repo, on the android branch.
set -e
cd "$(git rev-parse --show-toplevel)"
WANT=android
cur=$(git rev-parse --abbrev-ref HEAD)
[ "$cur" = "$WANT" ] || { echo "You are on '$cur', not '$WANT'. Run: git checkout $WANT"; exit 1; }

# Old copies and stale files that nothing uses
REMOVE="pekandroid pekmain hesperandroid hespermain app.js app_settings.js app_torrents.js app_watch.js index.html style.css "

echo "Will remove:"
for p in $REMOVE; do [ -e "$p" ] && echo "  $p"; done
echo "Will stop tracking (if tracked): backend/bin, backend/media_core, backend/core_test, plugin data, __pycache__, *.pyc"
echo "Will make sure www/index.html loads skin_installer.js and app_skins.js exactly once"
[ "$1" = "--go" ] || { echo; echo "Preview only. Run again with --go to apply."; exit 0; }

other=$(git status --porcelain --untracked-files=no | grep -v ' www/index.html$' || true)
[ -z "$other" ] || { echo "You have other uncommitted changes. Commit or stash them first:"; echo "$other"; exit 1; }

for p in $REMOVE; do git rm -r -f -q --ignore-unmatch -- "$p"; rm -rf -- "$p"; done
git rm -r --cached -q --ignore-unmatch backend/bin backend/media_core backend/core_test
git ls-files | grep -E '__pycache__|\.pyc$|^plugins/[^/]+/data/' | xargs -r git rm --cached -q
grep -q '^plugins/\*/data/' .gitignore || printf '\n# Plugin runtime data\nplugins/*/data/\n' >> .gitignore

f=www/index.html
grep -q skin_installer.js "$f" || sed -i 's|^\(<script src="plugin_installer.js?v=[0-9a-z]*"></script>\)$|\1\n<script src="skin_installer.js?v=1"></script>|' "$f"
grep -q app_skins.js "$f" || sed -i 's|^\(<script src="app_plugins.js?v=[0-9a-z]*"></script>\)$|\1\n<script src="app_skins.js?v=1"></script>|' "$f"
awk '!((/skin_installer.js/ || /app_skins.js/) && seen[$0]++)' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
git add "$f" .gitignore

git commit -q -m "Clean up repo: remove old nested copies and stale root files; load skin scripts once"
echo "Done. Review with: git show --stat HEAD"
