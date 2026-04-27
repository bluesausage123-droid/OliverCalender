const express = require('express');
const webpush = require('web-push');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ── VAPID 金鑰 ────────────────────────────────────────────
const VAPID_FILE = path.join(__dirname, 'vapid.json');
let vapid;
if (!fs.existsSync(VAPID_FILE)) {
    vapid = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2));
    console.log('✅ 已產生 VAPID 金鑰');
} else {
    vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
}
webpush.setVapidDetails('mailto:admin@mars-reminder.app', vapid.publicKey, vapid.privateKey);

// ── 資料存取（每個使用者獨立，用 uid 區分）────────────────
const DATA_FILE = path.join(__dirname, 'data.json');

function load() {
    if (!fs.existsSync(DATA_FILE)) return { users: {} };
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch { return { users: {} }; }
}
function save(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

// ── API ───────────────────────────────────────────────────

// 前端取得 VAPID 公鑰
app.get('/api/vapid-key', (req, res) => res.json({ key: vapid.publicKey }));

// 儲存推送訂閱（綁定 uid）
app.post('/api/subscribe', (req, res) => {
    const { uid, sub } = req.body;
    if (!uid || !sub?.endpoint) return res.status(400).json({ error: 'invalid' });
    const data = load();
    if (!data.users[uid]) data.users[uid] = { sub: null, tasks: [] };
    data.users[uid].sub = sub;
    save(data);
    console.log(`📱 訂閱成功 uid=${uid}`);
    res.json({ ok: true });
});

// 取得任務
app.get('/api/tasks', (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'missing uid' });
    const data = load();
    res.json(data.users[uid]?.tasks || []);
});

// 同步整份任務
app.post('/api/tasks', (req, res) => {
    const { uid } = req.query;
    const tasks = req.body;
    if (!uid || !Array.isArray(tasks)) return res.status(400).json({ error: 'invalid' });
    const data = load();
    if (!data.users[uid]) data.users[uid] = { sub: null, tasks: [] };
    data.users[uid].tasks = tasks;
    save(data);
    res.json({ ok: true });
});

// 延後單筆任務 10 分鐘
app.post('/api/tasks/:id/snooze', (req, res) => {
    const { uid } = req.query;
    const id   = Number(req.params.id);
    if (!uid) return res.status(400).json({ error: 'missing uid' });
    const data = load();
    const user = data.users[uid];
    if (!user) return res.json({ ok: false });
    const task = user.tasks.find(t => t.id === id);
    if (task) {
        const d = new Date(Date.now() + 10 * 60000);
        const p = n => String(n).padStart(2, '0');
        task.time     = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
        task.notified = false;
        save(data);
    }
    res.json({ ok: !!task });
});

// ── 每 30 秒掃描到期任務並推送 ────────────────────────────
async function checkAndPush() {
    const data    = load();
    const now     = new Date();
    let   changed = false;

    for (const [uid, user] of Object.entries(data.users)) {
        if (!user.sub || !user.tasks?.length) continue;

        for (const task of user.tasks) {
            if (task.notified || new Date(task.time) > now) continue;

            task.notified = true;
            changed       = true;
            console.log(`🔔 推送提醒 uid=${uid} task=${task.name}`);

            try {
                await webpush.sendNotification(user.sub, JSON.stringify({
                    title: '火星管家提醒 🔔',
                    body:  '時間到！記得去做：' + task.name,
                    name:  task.name,
                    id:    task.id,
                    uid:   uid
                }));
            } catch(e) {
                if (e.statusCode === 410 || e.statusCode === 404) {
                    user.sub = null; // 訂閱失效，清除
                    console.log(`⚠️  訂閱失效，已清除 uid=${uid}`);
                } else {
                    console.error(`推送失敗 uid=${uid}:`, e.message);
                }
            }
        }
    }

    if (changed) save(data);
}

setInterval(checkAndPush, 30000);

// ── 啟動 ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 火星管家伺服器已啟動 port=${PORT}`));
