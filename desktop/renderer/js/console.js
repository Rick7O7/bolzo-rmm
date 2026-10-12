// Eigenes Fenster für die Konsole einer VM / eines Containers (geöffnet aus dem Hauptfenster).
// Teilt sich die Anmeldung (localStorage) mit dem Hauptfenster, baut aber eine eigene Verbindung auf.
import { api } from './api.js';
import { installWindowControls, esc } from './ui.js';
import { mountConsole, kind } from './proxmox.js';

const p = Object.fromEntries(new URLSearchParams(location.search));
const g = { hostId: p.hostId, vmid: Number(p.vmid), type: p.type, name: p.name, label: p.label, hostName: p.hostName };
document.title = `${g.label || g.name || `${kind(g.type)} ${g.vmid}`} – Konsole`;
installWindowControls();

function message(text) {
  document.body.insertAdjacentHTML('beforeend', `<div class="console-msg"><div>${esc(text)}</div></div>`);
}

if (!api.loggedIn) {
  message('Nicht angemeldet – bitte im Hauptfenster anmelden und die Konsole neu öffnen.');
} else {
  // Container-Konsolen laufen über die Live-Verbindung: erst nach dem Verbinden starten
  api.connect();
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    mountConsole(g, { standalone: true });
  };
  if (g.type === 'lxc') api.on('conn', (on) => on && start());
  else start();
  api.on('logout', () => message('Sitzung abgelaufen – bitte im Hauptfenster neu anmelden.'));
}
