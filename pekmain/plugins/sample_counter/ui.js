// Example of a sandboxed Hesper plugin. It has no access to the page, only to the
// `hesper` object. What it may do is declared in plugin.json (here: its own storage).
//
//   hesper.render(ui => <tree>)        draw the screen (re-runs after every tap)
//   hesper.requestRender()             redraw after your own async work
//   hesper.storage.get/set/remove      private key/value store      (permission: storage)
//   hesper.readJSON(name)              read plugins/<id>/data/<name> (permission: storage)
//   hesper.fetchJSON(url)              HTTPS GET of an allowed host  (permission: network)
//   ui.card / ui.button / ui.listRow / ui.text / ui.heading / ui.column / ui.row
let count = 0;

hesper.storage.get('count').then(v => {
    count = parseInt(v || '0', 10) || 0;
    hesper.requestRender();
});

hesper.render(ui => ui.column(
    ui.heading('Tap counter'),
    ui.card('Count: ' + count, 'Tap to add one', () => {
        count++;
        hesper.storage.set('count', String(count));
    }),
    ui.button('Reset', () => {
        count = 0;
        hesper.storage.set('count', '0');
    })
));
