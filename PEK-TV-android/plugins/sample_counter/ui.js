// Example of a sandboxed PEK TV plugin. It has no access to the page, only to the
// `pek` object. What it may do is declared in plugin.json (here: its own storage).
//
//   pek.render(ui => <tree>)        draw the screen (re-runs after every tap)
//   pek.requestRender()             redraw after your own async work
//   pek.storage.get/set/remove      private key/value store      (permission: storage)
//   pek.readJSON(name)              read plugins/<id>/data/<name> (permission: storage)
//   pek.fetchJSON(url)              HTTPS GET of an allowed host  (permission: network)
//   ui.card / ui.button / ui.listRow / ui.text / ui.heading / ui.column / ui.row
let count = 0;

pek.storage.get('count').then(v => {
    count = parseInt(v || '0', 10) || 0;
    pek.requestRender();
});

pek.render(ui => ui.column(
    ui.heading('Tap counter'),
    ui.card('Count: ' + count, 'Tap to add one', () => {
        count++;
        pek.storage.set('count', String(count));
    }),
    ui.button('Reset', () => {
        count = 0;
        pek.storage.set('count', '0');
    })
));
