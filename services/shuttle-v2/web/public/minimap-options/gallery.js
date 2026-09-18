const options = [
  ['Hide destination time', 'Keep pickup and waiting labels. The destination pin stays; its arrival range is already on the route card.'],
  ['Hide waiting label', 'Keep pickup and destination times. Remove the floating label above the bus.'],
  ['Shorten the route name', 'Use “R” instead of “Red” in the waiting label. Keep both time labels.'],
  ['Waiting numbers only', 'Show just elapsed / usual wait above the bus. The Red legend and bus color still identify the route.'],
  ['Remove repeated route initials', 'Drop “(R)” from the pickup and destination labels when viewing this single Red route.'],
  ['Hide pickup time', 'Keep the waiting label and destination time. The route card supplies the pickup countdown.'],
  ['Pickup time only', 'Keep the pickup label; hide the destination and waiting labels. All pins stay.'],
  ['Waiting label below the bus', 'Move the same waiting label directly below the bus icon. Keep the other labels as they are.'],
  ['Waiting time in the legend', 'Move elapsed / usual wait to the existing Red legend at the bottom left. Keep pickup and destination times.'],
  ['Pins without time labels', 'Hide all three timing labels. Keep the current streets, route, pins and controls. Read times on the route card.'],
];
const key = 'shuttle-minimap-label-favorites-v2';
let saved;
try { saved = new Set(JSON.parse(localStorage.getItem(key) || '[]').filter(id => Number.isInteger(id) && id >= 1 && id <= 10)); }
catch { saved = new Set(); }
let savedOnly = false;
const gallery = document.querySelector('#gallery');
const dialog = document.querySelector('#detail');
let opener;
for (const [index, [title, description]] of options.entries()) {
  const id = index + 1, number = String(id).padStart(2, '0');
  const card = document.createElement('article');
  card.className = 'concept'; card.id = `option-${id}`;
  card.innerHTML = `<h2><span class="number">${number}</span>${title}</h2><p>${description}</p><img src="./previews/option-${number}.png" alt="${title}: ${description}" loading="lazy" width="338" height="320"><div class="actions"><button data-compare="${id}" aria-label="Compare option ${id} with current">Compare with current</button><button class="save" data-save="${id}" aria-pressed="false" aria-label="Save option ${id}">Save</button></div>`;
  gallery.append(card);
}
function refresh() {
  for (let id = 1; id <= 10; id++) {
    const button = document.querySelector(`[data-save="${id}"]`);
    button.setAttribute('aria-pressed', String(saved.has(id)));
    button.textContent = saved.has(id) ? 'Saved ✓' : 'Save';
    document.querySelector(`#option-${id}`).hidden = savedOnly && !saved.has(id);
  }
  document.querySelector('#saved-count').textContent = saved.size;
  document.querySelector('#empty').hidden = !savedOnly || saved.size > 0;
  document.querySelector('#all').setAttribute('aria-pressed', String(!savedOnly));
  document.querySelector('#favorites').setAttribute('aria-pressed', String(savedOnly));
}
gallery.addEventListener('click', e => {
  const save = e.target.closest('[data-save]');
  if (save) {
    const id = Number(save.dataset.save);
    if (saved.has(id)) saved.delete(id); else saved.add(id);
    try { localStorage.setItem(key, JSON.stringify([...saved])); } catch { /* Private storage can be unavailable. */ }
    refresh();
    document.querySelector('#announcement').textContent = `${saved.size} options saved`;
  }
  const compare = e.target.closest('[data-compare]');
  if (compare) {
    const id = Number(compare.dataset.compare), title = options[id - 1][0];
    document.querySelector('#detail-title').textContent = `${String(id).padStart(2, '0')} · ${title}`;
    document.querySelector('#variant-caption').textContent = title;
    const image = document.querySelector('#variant-image');
    image.src = `./previews/option-${String(id).padStart(2, '0')}.png`; image.alt = title;
    opener = compare; dialog.showModal(); dialog.querySelector('.close').focus();
  }
});
dialog.querySelector('.close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => opener?.focus());
dialog.addEventListener('click', e => {
  if (e.target !== dialog) return;
  const b = dialog.getBoundingClientRect();
  if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) dialog.close();
});
document.querySelector('#all').addEventListener('click', () => { savedOnly = false; refresh(); });
document.querySelector('#favorites').addEventListener('click', () => { savedOnly = true; refresh(); });
refresh();
