const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" },
    perMessageDeflate: true // 开启压缩
});

app.use(express.static('public'));

// === 游戏配置 ===
const MAP_WIDTH = 2000;
const MAP_HEIGHT = 2000;
const PHYSICS_RATE = 60; // 物理计算 60Hz
const NETWORK_RATE = 30; // 网络广播 30Hz (降低带宽压力)

// === 生成地图 ===
const OBSTACLES = [];
// 四周墙壁
OBSTACLES.push({ x: -50, y: 0, w: 50, h: MAP_HEIGHT });
OBSTACLES.push({ x: MAP_WIDTH, y: 0, w: 50, h: MAP_HEIGHT });
OBSTACLES.push({ x: 0, y: -50, w: MAP_WIDTH, h: 50 });
OBSTACLES.push({ x: 0, y: MAP_HEIGHT, w: MAP_WIDTH, h: 50 });

// 随机障碍
for (let i = 0; i < 40; i++) {
    const w = Math.random() * 100 + 60;
    const h = Math.random() * 100 + 60;
    const x = Math.random() * (MAP_WIDTH - w);
    const y = Math.random() * (MAP_HEIGHT - h);
    OBSTACLES.push({ x, y, w, h });
}

const WEAPONS = {
    'pistol': { name: '手枪', damage: 10, speed: 14, cooldown: 400, count: 1, spread: 0.05, color: '#333' },
    'shotgun': { name: '喷子', damage: 6, speed: 10, cooldown: 900, count: 6, spread: 0.5, color: 'orange' },
    'machinegun': { name: '加特林', damage: 4, speed: 16, cooldown: 80, count: 1, spread: 0.15, color: 'purple' }
};

let players = {};
let bullets = [];

// 碰撞辅助
function checkRectCollision(rect1, rect2) {
    return (rect1.x < rect2.x + rect2.w &&
            rect1.x + rect1.w > rect2.x &&
            rect1.y < rect2.y + rect2.h &&
            rect1.y + rect1.h > rect2.y);
}

io.on('connection', (socket) => {
    // 1. 发送地图数据
    socket.emit('mapData', { obstacles: OBSTACLES, width: MAP_WIDTH, height: MAP_HEIGHT });

    // 2. 加入游戏
    socket.on('joinGame', (name) => {
        const safeName = (name || "无名氏").substring(0, 10);
        
        // 随机出生
        let x = Math.random() * (MAP_WIDTH - 200) + 100;
        let y = Math.random() * (MAP_HEIGHT - 200) + 100;

        players[socket.id] = {
            id: socket.id,
            x: x, y: y,
            w: 40, h: 40,
            color: `hsl(${Math.random() * 360}, 70%, 50%)`,
            name: safeName,
            hp: 100, maxHp: 100,
            score: 0,
            weapon: 'pistol',
            lastShootTime: 0
        };
        socket.emit('joinSuccess', safeName);
    });

    // 3. 玩家移动 (接收客户端预测坐标)
    socket.on('playerMovement', (pos) => {
        const p = players[socket.id];
        if (!p) return;

        // 简单的反作弊：验证位置是否撞墙
        // 如果撞墙，服务器不更新坐标，下次广播时客户端会被拉回
        const rect = { x: pos.x, y: pos.y, w: p.w, h: p.h };
        let valid = true;
        for (const wall of OBSTACLES) {
            if (checkRectCollision(rect, wall)) { valid = false; break; }
        }

        if (valid) {
            p.x = pos.x;
            p.y = pos.y;
        }
    });

    socket.on('switchWeapon', (k) => {
        if (players[socket.id] && WEAPONS[k]) players[socket.id].weapon = k;
    });

    socket.on('shoot', (angle) => {
        const p = players[socket.id];
        if (!p) return;
        const w = WEAPONS[p.weapon];
        const now = Date.now();
        
        if (now - p.lastShootTime >= w.cooldown) {
            p.lastShootTime = now;
            for (let i = 0; i < w.count; i++) {
                const a = angle + (Math.random() * w.spread - w.spread/2);
                bullets.push({
                    x: p.x + 20, y: p.y + 20,
                    angle: a,
                    speed: w.speed,
                    damage: w.damage,
                    color: w.color,
                    ownerId: socket.id,
                    life: 100
                });
            }
        }
    });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

// === 物理循环 (60Hz) ===
setInterval(() => {
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += Math.cos(b.angle) * b.speed;
        b.y += Math.sin(b.angle) * b.speed;
        b.life--;

        let remove = false;
        // 边界删除
        if (b.life <= 0 || b.x < -100 || b.x > MAP_WIDTH+100 || b.y < -100 || b.y > MAP_HEIGHT+100) remove = true;
        
        // 撞墙
        if (!remove) {
            for (const w of OBSTACLES) {
                if (b.x > w.x && b.x < w.x+w.w && b.y > w.y && b.y < w.y+w.h) { remove = true; break; }
            }
        }

        // 撞人
        if (!remove) {
            for (const pid in players) {
                if (b.ownerId === pid) continue;
                const p = players[pid];
                if (b.x > p.x && b.x < p.x+p.w && b.y > p.y && b.y < p.y+p.h) {
                    p.hp -= b.damage;
                    remove = true;
                    if (p.hp <= 0) {
                        if (players[b.ownerId]) {
                            players[b.ownerId].score++;
                            io.emit('killFeed', { killer: players[b.ownerId].name, victim: p.name, weapon: WEAPONS[players[b.ownerId].weapon].name });
                        }
                        p.hp = 100;
                        p.x = Math.random() * (MAP_WIDTH-200)+100;
                        p.y = Math.random() * (MAP_HEIGHT-200)+100;
                        p.score = Math.max(0, p.score-1);
                    }
                    break;
                }
            }
        }
        if (remove) bullets.splice(i, 1);
    }
}, 1000 / PHYSICS_RATE);

// === 网络循环 (30Hz) ===
setInterval(() => {
    io.emit('gameState', { players, bullets });
}, 1000 / NETWORK_RATE);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on ${PORT}`));