const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' })); // زيادة الحد لدعم رفع الصور الشخصية
app.use(express.static(__dirname)); 

// قاعدة بيانات المستخدمين في السيرفر
const users = {}; 
const activeSockets = {}; 

function generateRandomID() {
    let id;
    do {
        id = Math.floor(100000 + Math.random() * 900000).toString();
    } while (users[id]);
    return id;
}

app.post('/api/register', (req, res) => {
    const { name, password, avatar } = req.body;
    if (!name || !password) {
        return res.status(400).json({ error: 'الرجاء إدخال الاسم وكلمة المرور' });
    }
    const newID = generateRandomID();
    users[newID] = { id: newID, name, password, avatar: avatar || '' };
    res.json({ success: true, id: newID, name, avatar: users[newID].avatar });
});

app.post('/api/login', (req, res) => {
    const { id, password } = req.body;
    const user = users[id];
    if (user && user.password === password) {
        res.json({ success: true, id: user.id, name: user.name, avatar: user.avatar });
    } else {
        res.status(401).json({ error: 'الأي دي أو كلمة المرور غير صحيحة' });
    }
});

app.post('/api/update-avatar', (req, res) => {
    const { id, avatar } = req.body;
    if (users[id]) {
        users[id].avatar = avatar;
        return res.json({ success: true });
    }
    res.status(404).json({ error: 'المستخدم غير موجود' });
});

app.post('/api/search', (req, res) => {
    const { targetID } = req.body;
    const user = users[targetID];
    if (user) {
        res.json({ success: true, name: user.name, id: user.id, avatar: user.avatar });
    } else {
        res.status(404).json({ error: 'المستخدم غير موجود' });
    }
});

io.on('connection', (socket) => {
    socket.on('register-socket', (userId) => {
        activeSockets[userId] = socket.id;
    });

    socket.on('private-message', ({ senderId, receiverId, message, senderName }) => {
        const receiverSocketId = activeSockets[receiverId];
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('receive-message', { senderId, senderName, message });
        }
    });

    socket.on('disconnect', () => {
        for (let userId in activeSockets) {
            if (activeSockets[userId] === socket.id) {
                delete activeSockets[userId];
                break;
            }
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 السيرفر المطور شغال تمام! الرابط: http://localhost:${PORT}`);
});