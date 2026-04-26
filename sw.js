const CACHE = 'mars-v2';
const ASSETS = ['./', './index.html', './manifest.json', './sw.js'];

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

// ---- IndexedDB helpers ----
function openDB() {
    return new Promise((res, rej) => {
        const req = indexedDB.open('mars_db', 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore('tasks', { keyPath: 'id' });
        req.onsuccess = e => res(e.target.result);
        req.onerror = e => rej(e.target.error);
    });
}

async function dbSaveTasks(tasks) {
    const db = await openDB();
    return new Promise((res, rej) => {
        const tx = db.transaction('tasks', 'readwrite');
        const store = tx.objectStore('tasks');
        store.clear();
        tasks.forEach(t => store.put(t));
        tx.oncomplete = res;
        tx.onerror = e => rej(e.target.error);
    });
}

async function dbLoadTasks() {
    const db = await openDB();
    return new Promise((res, rej) => {
        const req = db.transaction('tasks', 'readonly').objectStore('tasks').getAll();
        req.onsuccess = e => res(e.target.result || []);
        req.onerror = e => rej(e.target.error);
    });
}

async function dbUpdateTask(id, changes) {
    const db = await openDB();
    return new Promise((res, rej) => {
        const tx = db.transaction('tasks', 'readwrite');
        const store = tx.objectStore('tasks');
        const req = store.get(id);
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

// ---- Background alarm loop ----
// Runs while the page is open (even minimized / screen locked).
// Stops automatically when all clients close.
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
    if (!clients) clients = await self.clients.matchAll({ type: 'window' });
    const tasks = await dbLoadTasks();
    const now = Date.now();

    for (const t of tasks) {
        if (t.notified || new Date(t.time).getTime() > now) continue;

        await dbUpdateTask(t.id, { notified: true });

        const focused = clients.filter(c => c.visibilityState === 'visible');

        if (focused.length > 0) {
            // Page is in foreground — let page handle the overlay
            focused.forEach(c => c.postMessage({ type: 'ALARM_FIRED', id: t.id, name: t.name }));
        } else {
            // Page minimized or screen locked — show system notification
            await self.registration.showNotification('火星管家提醒 🔔', {
                body: '時間到！記得去做：' + t.name,
                vibrate: [300, 100, 300, 100, 300],
                tag: 'alarm-' + t.id,
                requireInteraction: true,
                data: { id: t.id, name: t.name, useAlarm: t.useAlarm },
                actions: [
                    { action: 'snooze', title: '⏰ 延後10分鐘' },
                    { action: 'dismiss', title: '✅ 知道了' }
                ]
            });
            // Update background clients' localStorage state
            clients.forEach(c => c.postMessage({ type: 'ALARM_NOTIFIED', id: t.id }));
        }
    }
}

// ---- Messages from page ----
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

// ---- Periodic Background Sync (Android Chrome, PWA installed) ----
self.addEventListener('periodicsync', e => {
    if (e.tag === 'check-alarms') e.waitUntil(checkAndNotify());
});

// ---- Notification button actions ----
self.addEventListener('notificationclick', e => {
    e.notification.close();
    const { id } = e.notification.data || {};

    if (e.action === 'snooze' && id) {
        e.waitUntil((async () => {
            await dbUpdateTask(id, {
                time: localTimeStr(new Date(Date.now() + 10 * 60000)),
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
