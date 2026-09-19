const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const dbFile = path.join(__dirname, 'vanta_core.db');
const db = new sqlite3.Database(dbFile);

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, role TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS servers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, node_type TEXT, memory TEXT, cpu TEXT, status TEXT, filename TEXT)");
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'vanta_supreme_architecture_999_secure_key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const activeProcesses = {};

app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "جميع الحقول مطلوبة" });
    try {
        const hashedPassword = await bcrypt.hash(password, 12);
        db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", [username, hashedPassword, 'admin'], (err) => {
            if (err) return res.status(400).json({ error: "اسم المستخدم مستخدم مسبقاً" });
            res.json({ success: true, message: "تم إنشاء الحساب بنجاح" });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: "بيانات الدخول غير صالحة" });
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(400).json({ error: "كلمة المرور غير صحيحة" });
        
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        res.json({ success: true, username: user.username });
    });
});

app.get('/api/auth/session', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ loggedIn: false });
    res.json({ loggedIn: true, username: req.session.username, role: req.session.role });
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/servers', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "غير مصرح" });
    db.all("SELECT * FROM servers WHERE user_id = ?", [req.session.userId], (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/servers/create', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "غير مصرح" });
    const { name, node_type, memory, cpu, code } = req.body;
    
    const ext = node_type === 'python' ? 'py' : 'js';
    const filename = `server_${req.session.userId}_${Date.now()}.${ext}`;
    const scriptsDir = path.join(__dirname, 'instances');
    
    if (!fs.existsSync(scriptsDir)) {
        fs.mkdirSync(scriptsDir, { recursive: true });
    }
    
    const defaultCode = code || (ext === 'py' ? 'import time\nwhile True:\n    print("Vanta Node Engine Active...")\n    time.sleep(2)' : 'setInterval(() => { console.log("Vanta Server Core Running..."); }, 2000);');
    fs.writeFileSync(path.join(scriptsDir, filename), defaultCode);

    db.run("INSERT INTO servers (user_id, name, node_type, memory, cpu, status, filename) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [req.session.userId, name || 'Vanta-Instance', node_type || 'node', memory || '1024MB', cpu || '100%', 'offline', filename], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, serverId: this.lastID });
        }
    );
});

app.post('/api/servers/:id/power', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "غير مصرح" });
    const serverId = req.params.id;
    const { action } = req.body;

    db.get("SELECT * FROM servers WHERE id = ? AND user_id = ?", [serverId, req.session.userId], (err, srv) => {
        if (err || !srv) return res.status(404).json({ error: "السيرفر غير موجود" });

        if (action === 'start') {
            if (activeProcesses[serverId]) return res.json({ success: true, message: "السيرفر يعمل بالفعل" });

            const filePath = path.join(__dirname, 'instances', srv.filename);
            const cmd = srv.node_type === 'python' ? 'python3' : 'node';
            
            const proc = spawn(cmd, [filePath], { cwd: path.join(__dirname, 'instances') });
            activeProcesses[serverId] = { proc, buffer: [] };

            const broadcastLog = (data) => {
                const msg = data.toString();
                activeProcesses[serverId].buffer.push(msg);
                if (activeProcesses[serverId].buffer.length > 500) activeProcesses[serverId].buffer.shift();
                
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN && client.serverId === serverId) {
                        client.send(JSON.stringify({ type: 'log', data: msg }));
                    }
                });
            };

            proc.stdout.on('data', broadcastLog);
            proc.stderr.on('data', broadcastLog);

            proc.on('close', (code) => {
                broadcastLog(`\n[Vanta Daemon] Process exited with status code ${code}\n`);
                db.run("UPDATE servers SET status = 'offline' WHERE id = ?", [serverId]);
                delete activeProcesses[serverId];
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN && client.serverId === serverId) {
                        client.send(JSON.stringify({ type: 'status', status: 'offline' }));
                    }
                });
            });

            db.run("UPDATE servers SET status = 'online' WHERE id = ?", [serverId], () => {
                res.json({ success: true, status: 'online' });
            });

        } else if (action === 'stop' || action === 'kill') {
            if (activeProcesses[serverId]) {
                activeProcesses[serverId].proc.kill('SIGKILL');
                delete activeProcesses[serverId];
            }
            db.run("UPDATE servers SET status = 'offline' WHERE id = ?", [serverId], () => {
                res.json({ success: true, status: 'offline' });
            });
        }
    });
});

wss.on('connection', (ws, req) => {
    ws.on('message', (message) => {
        try {
            const parsed = JSON.parse(message);
            if (parsed.action === 'subscribe') {
                ws.serverId = parsed.serverId;
                if (activeProcesses[parsed.serverId]) {
                    ws.send(JSON.stringify({ type: 'history', data: activeProcesses[parsed.serverId].buffer.join('') }));
                }
            } else if (parsed.action === 'command' && parsed.serverId) {
                if (activeProcesses[parsed.serverId] && activeProcesses[parsed.serverId].proc.stdin) {
                    activeProcesses[parsed.serverId].proc.stdin.write(parsed.command + '\n');
                }
            }
        } catch (e) {}
    });
});

server.listen(PORT, () => {
    console.log(`[Vanta Enterprise Core] Running on port ${PORT}`);
});
