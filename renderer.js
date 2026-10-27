const FIRST_CHECK_DELAY_MS = 20 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const CATALOG_TAB = 'marketplace:catalog';

module.exports = {
  start(ymd) {
    const pending = new Map();
    ymd.on('marketplace:response', (message) => {
      const request = message && pending.get(message.rid);
      if (!request) return;
      pending.delete(message.rid);
      if (message.ok) request.resolve(message.result);
      else request.reject(new Error(message.error));
    });
    const call = (op, args) => new Promise((resolve, reject) => {
      const rid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      pending.set(rid, { resolve, reject });
      ymd.emit('marketplace:request', { rid, op, args });
      ymd.setTimeout(() => {
        if (pending.delete(rid)) reject(new Error('Нет ответа: сеть или каталог недоступны.'));
      }, 60000);
    });

    const el = (tag, props = {}, children = []) => {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
      }
      for (const child of [].concat(children)) if (child) node.append(child);
      return node;
    };

    ymd.addStyle(`
#ymd-overlay .ymd-market-bar{display:flex;justify-content:flex-end;gap:10px;margin-bottom:10px}
#ymd-overlay .ymd-market-author{color:var(--ymd-dim);font-size:12px;margin-top:2px}
#ymd-overlay .ymd-market-mod{border:1px solid var(--ymd-accent);margin-bottom:12px}`);

    const isUpdatable = (addon) => addon.update && addon.compatible && !addon.needs.some((need) => need.state === 'missing');

    const openCatalog = () => ymd.emit('ymd:open-settings', { tab: CATALOG_TAB });

    async function installAll(addons) {
      const toasts = ymd.use('notifications');
      const bar = toasts && toasts.progress('Обновляю аддоны', 0, { title: 'Каталог аддонов' });
      const failed = [];
      for (const [index, addon] of addons.entries()) {
        bar?.update({ text: `Обновляю «${addon.name}»`, progress: index / addons.length });
        try {
          await call('install', { id: addon.id });
        } catch (error) {
          failed.push(`«${addon.name}»: ${error.message}`);
        }
      }
      if (!failed.length) bar?.update({ text: addons.length === 1 ? `«${addons[0].name}» обновлён до ${addons[0].version}` : 'Аддоны обновлены', progress: 1 });
      else {
        bar?.close();
        ymd.notify(`Не обновлено: ${failed.join('; ')}`, { type: 'error' });
      }
    }

    function announceAddonUpdates(updates) {
      const text = updates.length === 1
        ? `Доступно обновление «${updates[0].name}»: ${updates[0].installedVersion} → ${updates[0].version}`
        : `Доступны обновления: ${updates.map((a) => `«${a.name}» ${a.version}`).join(', ')}`;
      ymd.use('notifications')?.show({
        title: 'Каталог аддонов',
        text,
        sticky: true,
        actions: [
          { label: 'Обновить', primary: true, onClick: () => installAll(updates) },
          { label: 'Открыть каталог', onClick: openCatalog },
        ],
      });
    }

    const modUpdateText = (release) => `Вышла версия мода ${release.version} (у вас ${ymd.modVersion}). Для обновления клиент закроется и запустится снова.`;
    const openReleaseNotes = (release) => call('openRelease', { url: release.url }).catch(() => {});

    function announceModUpdate(release) {
      ymd.use('notifications')?.show({
        title: 'YMDMod',
        text: modUpdateText(release),
        sticky: true,
        actions: [
          { label: 'Обновить', primary: true, onClick: updateMod },
          { label: 'Что нового', onClick: () => openReleaseNotes(release) },
        ],
      });
    }

    function modUpdateCard(release) {
      return el('div', { class: 'ymd-card ymd-market-mod' }, [
        el('div', { class: 'ymd-name', text: `YMDMod ${release.version}` }),
        el('div', { class: 'ymd-desc', text: modUpdateText(release) }),
        el('div', { class: 'ymd-actions' }, [
          el('button', { class: 'ymd-btn', type: 'button', text: 'Что нового', onclick: () => openReleaseNotes(release) }),
          el('button', { class: 'ymd-btn ymd-btn-accent', type: 'button', text: 'Обновить мод', onclick: (event) => {
            event.currentTarget.disabled = true;
            updateMod();
          } }),
        ]),
      ]);
    }

    async function updateMod() {
      try {
        await call('updateMod');
        ymd.notify('Закрываю клиент для обновления мода…');
      } catch (error) {
        ymd.notify(error.message, { type: 'error' });
      }
    }

    async function checkForUpdates() {
      if (ymd.settings.get('checkUpdates') === false) return;
      const announced = { ...(ymd.settings.get('announced') || {}) };
      try {
        const catalog = await call('catalog');
        const updates = catalog.addons.filter((a) => isUpdatable(a) && announced[a.id] !== a.version);
        if (updates.length) {
          announceAddonUpdates(updates);
          for (const addon of updates) announced[addon.id] = addon.version;
        }
      } catch (error) {
        ymd.log('addon update check failed:', error.message);
      }
      try {
        const release = await call('modRelease');
        if (release && release.newer && announced['ymdmod'] !== release.version) {
          announceModUpdate(release);
          announced['ymdmod'] = release.version;
        }
      } catch (error) {
        ymd.log('mod update check failed:', error.message);
      }
      ymd.settings.set('announced', announced);
    }

    ymd.setTimeout(checkForUpdates, FIRST_CHECK_DELAY_MS);
    ymd.setInterval(checkForUpdates, CHECK_EVERY_MS);

    const NEED_STATE = { installed: 'установлен', 'will-install': 'поставится вместе с ним', missing: 'нет в каталоге' };
    const describeNeed = (need) => `«${need.name}» ${need.range} (${NEED_STATE[need.state]})`;

    function confirmDependencies(addon, names, onConfirm) {
      const list = names.map((name) => `«${name}»`).join(', ');
      const text = names.length === 1
        ? `Для «${addon.name}» нужен аддон ${list}. Установить его тоже?`
        : `Для «${addon.name}» нужны аддоны ${list}. Установить их тоже?`;
      const toasts = ymd.use('notifications');
      if (!toasts) {
        if (window.confirm(text)) onConfirm();
        return;
      }
      toasts.show({
        id: `marketplace-dependencies-${addon.id}`,
        title: 'Каталог аддонов',
        text,
        sticky: true,
        actions: [
          { label: names.length === 1 ? 'Установить оба' : 'Установить все', primary: true, onClick: onConfirm },
          { label: 'Отмена' },
        ],
      });
    }

    const card = (addon, reload) => {
      let chip = null;
      let action = null;
      const missing = addon.needs.filter((need) => need.state === 'missing');
      if (!addon.compatible) {
        chip = el('span', { class: 'ymd-chip ymd-warn', text: 'Не подходит', title: addon.reason });
      } else if (missing.length && (!addon.installedVersion || addon.update)) {
        chip = el('span', { class: 'ymd-chip ymd-warn', text: 'Нет зависимости' });
      } else if (!addon.installedVersion) {
        action = { label: 'Установить', busy: 'Устанавливаю…', accent: true };
      } else if (addon.update) {
        chip = el('span', { class: 'ymd-chip ymd-off', text: `Установлен ${addon.installedVersion}` });
        action = { label: `Обновить до ${addon.version}`, busy: 'Обновляю…', accent: true };
      } else {
        chip = el('span', { class: 'ymd-chip ymd-ok', text: 'Установлен' });
      }
      const buttons = [];
      if (action) {
        const button = el('button', { class: `ymd-btn${action.accent ? ' ymd-btn-accent' : ''}`, type: 'button', text: action.label });
        const install = async () => {
          button.disabled = true;
          button.textContent = action.busy;
          try {
            const result = await call('install', { id: addon.id });
            const extra = result.installed.filter((name) => name !== addon.name);
            const done = addon.installedVersion ? `обновлён до ${addon.version}` : 'установлен';
            ymd.notify(`«${addon.name}» ${done}${extra.length ? `, вместе с ним: ${extra.map((name) => `«${name}»`).join(', ')}` : ''}`, { type: 'success' });
          } catch (error) {
            ymd.notify(`«${addon.name}»: ${error.message}`, { type: 'error' });
          }
          reload();
        };
        button.addEventListener('click', async () => {
          if (!addon.needs.some((need) => need.state === 'will-install')) return install();
          button.disabled = true;
          try {
            const names = await call('dependencies', { id: addon.id });
            if (names.length) confirmDependencies(addon, names, install);
            else install();
          } catch (error) {
            ymd.notify(`«${addon.name}»: ${error.message}`, { type: 'error' });
          } finally {
            if (button.textContent !== action.busy) button.disabled = false;
          }
        });
        buttons.push(button);
      }
      const node = el('div', { class: 'ymd-card', 'data-catalog': addon.id }, [
        el('div', { class: 'ymd-row' }, [
          el('div', { class: 'ymd-name' }, [addon.name, el('span', { class: 'ymd-ver', text: addon.version })]),
          addon.type === 'library' && el('span', { class: 'ymd-chip ymd-off', text: 'Библиотека' }),
          chip,
        ]),
      ]);
      if (addon.author) node.append(el('div', { class: 'ymd-market-author', text: addon.author }));
      if (addon.description) node.append(el('div', { class: 'ymd-desc', text: addon.description }));
      if (addon.needs.length) node.append(el('div', { class: missing.length ? 'ymd-warning' : 'ymd-desc', text: `Нужны: ${addon.needs.map(describeNeed).join(', ')}` }));
      if (!addon.compatible) node.append(el('div', { class: 'ymd-error', text: addon.reason }));
      else if (addon.warning) node.append(el('div', { class: 'ymd-warning', text: addon.warning }));
      if (buttons.length) node.append(el('div', { class: 'ymd-actions' }, buttons));
      return node;
    };

    ymd.ui.addPage({
      id: 'catalog',
      title: 'Каталог',
      render(container) {
        let alive = true;
        const updateAll = el('button', { class: 'ymd-btn ymd-btn-accent', type: 'button', hidden: '' });
        const refresh = el('button', { class: 'ymd-btn', type: 'button', text: 'Обновить список' });
        const list = el('div');
        const modSlot = el('div');
        container.append(
          modSlot,
          el('div', { class: 'ymd-market-bar' }, [updateAll, refresh]),
          list,
        );
        const showModUpdate = async () => {
          try {
            const release = await call('modRelease');
            if (alive && release && release.newer) modSlot.replaceChildren(modUpdateCard(release));
          } catch (error) {
            ymd.log('mod release check failed:', error.message);
          }
        };
        let updates = [];
        updateAll.addEventListener('click', async () => {
          updateAll.disabled = true;
          await installAll(updates);
          if (alive) load();
        });

        const load = async () => {
          refresh.disabled = true;
          updateAll.hidden = true;
          list.replaceChildren(el('div', { class: 'ymd-empty', text: 'Загружаю…' }));
          try {
            const catalog = await call('catalog');
            if (!alive) return;
            updates = catalog.addons.filter(isUpdatable);
            updateAll.hidden = updates.length < 2;
            updateAll.disabled = false;
            updateAll.textContent = `Обновить всё (${updates.length})`;
            list.replaceChildren(...(catalog.addons.length
              ? catalog.addons.map((addon) => card(addon, load))
              : [el('div', { class: 'ymd-empty', text: 'Каталог пуст.' })]));
          } catch (error) {
            if (!alive) return;
            list.replaceChildren(el('div', { class: 'ymd-error', text: `Каталог недоступен: ${error.message}` }));
          } finally {
            refresh.disabled = false;
          }
        };
        refresh.addEventListener('click', load);
        showModUpdate();
        load();
        return () => {
          alive = false;
        };
      },
    });
  },
};
