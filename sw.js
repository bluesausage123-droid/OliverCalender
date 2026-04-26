const CACHE = 'mars-v3';
const ASSETS = ['./', './index.html', './manifest.json', './sw.js', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    e.respondWith(
        caches.match(e.request)
            .then(r => r || fetch(e.request).then(res => {
                const clone = res.clone();
                caches.open(CACHE).then(c => c.put(e.request, clone));
                return res;
            }))
            .catch(() => caches.match('./index.html'))
    );
});

// ---- IndexedDB ----
function openDB() {
    return new Promise((res, rej) => {
        const req = indexedDB.open('mars_db', 2);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('tasks'))    db.createObjectStore('tasks',    { keyPath: 'id' });
            if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
        };
        req.onsuccess = e => res(e.target.result);
        req.onerror  = e => rej(e.target.error);
    });
}

async function dbSaveTasks(tasks) {
    const db = await openDB();
    return new Promise((res, rej) => {
        const tx    = db.transaction('tasks', 'readwrite');
        const store = tx.objectStore('tasks');
        store.clear();
        tasks.forEach(t => store.put(t));
        tx.oncomplete = res;
        tx.onerror    = e => rej(e.target.error);
    });
}

async function dbLoadTasks() {
    const db = await openDB();
    return new Promise((res, rej) => {
        const req = db.transaction('tasks', 'readonly').objectStore('tasks').getAll();
        req.onsuccess = e => res(e.target.result || []);
        req.onerror   = e => rej(e.target.error);
    });
}

async function dbUpdateTask(id, changes) {
    const db = await openDB();
    return new Promise((res, rej) => {
        const tx    = db.transaction('tasks', 'readwrite');
        const store = tx.objectStore('tasks');
        const req   = store.get(id);
        req.onsuccess = e => {
            const task = e.target.result;
            if (task) store.put({ ...task, ...changes });
            tx.oncomplete = () => res(task);
        };
        req.onerror = e => rej(e.target.error);
    });
}

function localTimeStr(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---- 背景鬧鐘循環 ----
// 只要 App 沒被強制關閉（最小化、螢幕鎖定皆可），此循環持續運作
let checkTimer = null;

function startAlarmLoop() {
    if (checkTimer) return;
    checkTimer = setInterval(async () => {
        const clients = await self.clients.matchAll({ type: 'window' });
        if (clients.length === 0) {
            clearInterval(checkTimer);
            checkTimer = null;
            return;
        }
        checkAndNotify(clients);
    }, 10000);
}

async function checkAndNotify(clients) {
    const tasks   = await dbLoadTasks();
    const now     = Date.now();
    const focused = clients.filter(c => c.visibilityState === 'visible');

    for (const t of tasks) {
        if (t.notified || new Date(t.time).getTime() > now) continue;

        await dbUpdateTask(t.id, { notified: true });

        if (focused.length > 0) {
            // App 在前景：讓頁面顯示全螢幕彈窗
            focused.forEach(c => c.postMessage({ type: 'ALARM_FIRED', id: t.id, name: t.name }));
        } else {
            // App 最小化或螢幕鎖定：顯示系統通知
            await self.registration.showNotification('火星管家提醒 🔔', {
                body:            '時間到！記得去做：' + t.name,
                icon:            './icon-192.png',
                badge:           './icon-192.png',
                vibrate:         [300, 100, 300, 100, 300],
                tag:             'alarm-' + t.id,
                requireInteraction: true,
                data:            { id: t.id },
                actions: [
                    { action: 'snooze',  title: '⏰ 延後10分鐘' },
                    { action: 'dismiss', title: '✅ 知道了' }
                ]
            });
            clients.forEach(c => c.postMessage({ type: 'ALARM_NOTIFIED', id: t.id }));
        }
    }
}

// ---- 來自頁面的訊息 ----
self.addEventListener('message', e => {
    if (!e.data) return;
    switch (e.data.type) {
        case 'SYNC_TASKS':
            dbSaveTasks(e.data.tasks).then(() => startAlarmLoop());
            break;
        case 'GET_TASKS':
            dbLoadTasks().then(tasks => e.source.postMessage({ type: 'TASKS_DATA', tasks }));
            break;
    }
});

// ---- 通知按鈕動作 ----
self.addEventListener('notificationclick', e => {
    e.notification.close();
    const { id } = e.notification.data || {};

    if (e.action === 'snooze' && id) {
        e.waitUntil((async () => {
            await dbUpdateTask(id, {
                time:     localTimeStr(new Date(Date.now() + 10 * 60000)),
                notified: false
            });
            const clients = await self.clients.matchAll({ type: 'window' });
            clients.forEach(c => c.postMessage({ type: 'SNOOZED', id }));
            if (clients.length) clients[0].focus();
            else self.clients.openWindow('./');
        })());
    } else {
        e.waitUntil(
            self.clients.matchAll({ type: 'window' })
                .then(clients => clients.length ? clients[0].focus() : self.clients.openWindow('./'))
        );
    }
});
