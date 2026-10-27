// The builder's page: reads the form on every change and prints the settings file. Nothing leaves
// the browser and nothing is stored.
import { buildSettings, settingsText } from './rules.js';

const form = document.getElementById('builder');
const out = document.getElementById('settings');
const count = document.getElementById('count');
const warnings = document.getElementById('warnings');
const copied = document.getElementById('copied');

function choices() {
  const f = new FormData(form);
  return {
    mode: f.get('mode') ?? '',
    presets: f.getAll('preset'),
    commands: { allow: f.get('allow-commands'), ask: f.get('ask-commands'), deny: f.get('deny-commands') },
    domains: f.get('domains'), mcp: f.get('mcp'), denyPaths: f.get('deny-paths'), dirs: f.get('dirs'),
    disableBypass: f.has('disable-bypass'), blockOutside: f.has('block-outside'),
  };
}

function render() {
  const { settings, warnings: list } = buildSettings(choices());
  out.textContent = settingsText(settings);
  const p = settings.permissions;
  const n = (k) => (p[k] ?? []).length;
  count.textContent = `${n('allow')} allow, ${n('ask')} ask and ${n('deny')} deny rules.`;
  warnings.replaceChildren(...list.map((w) => Object.assign(document.createElement('li'), { textContent: w })));
  warnings.hidden = !list.length;
  copied.textContent = '';
}

form.addEventListener('input', render);
form.addEventListener('change', render);
form.addEventListener('submit', (e) => e.preventDefault());
form.addEventListener('reset', () => setTimeout(render));

document.getElementById('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(out.textContent);
    copied.textContent = 'Copied.';
  } catch {
    // No clipboard (an old browser, a page not over HTTPS): select the text for Cmd-C instead.
    getSelection().selectAllChildren(out);
    copied.textContent = 'Selected. Press Cmd-C or Ctrl-C to copy.';
  }
});

render();
