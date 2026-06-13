const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'chat_data.json');

app.use(express.json({ limit: '35mb' })); 
app.use(express.static(__dirname)); 

// قاعدة بيانات السيرفر المحفوظة دائماً
let db = {
    users: {},
    groups: {} // الحسابات والمجموعات والصلاحيات هتبقى هنا دائماً
};

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            if (!db.groups) db.groups = {};
            if (!db.users) db.users = {};
        }
    } catch (err) { console.error("خطأ في قراءة قاعدة البيانات:", err); }
}

function saveData() {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8'); } 
    catch (err) { console.error("خطأ في حفظ قاعدة البيانات:", err); }
}

loadData();
const activeSockets = {}; 

function generateID() {
    let id;
    do { id = Math.floor(100000 + Math.random() * 900000).toString(); } 
    while (db.users[id] || db.groups[id]);
    return id;
}

app.post('/api/register', (req, res) => {
    const { name, password, avatar } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'الرجاء إدخال الاسم وكلمة المرور' });
    const newID = generateID();
    db.users[newID] = { id: newID, name, password, avatar: avatar || '' };
    saveData();
    res.json({ success: true, id: newID, name, avatar: db.users[newID].avatar });
});

app.post('/api/login', (req, res) => {
    const { id, password } = req.body;
    const user = db.users[id];
    if (user && user.password === password) {
        res.json({ success: true, id: user.id, name: user.name, avatar: user.avatar });
    } else { res.status(401).json({ error: 'الأي دي أو كلمة المرور غير صحيحة' }); }
});

app.post('/api/search', (req, res) => {
    const { targetID } = req.body;
    if (db.users[targetID]) {
        res.json({ type: 'user', success: true, id: targetID, name: db.users[targetID].name, avatar: db.users[targetID].avatar, isOnline: !!activeSockets[targetID] });
    } else if (db.groups[targetID]) {
        res.json({ type: 'group', success: true, id: targetID, name: db.groups[targetID].name });
    } else { res.status(404).json({ error: 'لم يتم العثور على مستخدم أو مجموعة بهذا الرقم' }); }
});

io.on('connection', (socket) => {
    
    socket.on('register-socket', (userId) => {
        activeSockets[userId] = socket.id;
        socket.userId = userId;
        io.emit('user-status-change', { userId, status: 'online' });
        
        // إعادة إدخال المستخدم لجميع مجموعاته تلقائياً عند الاتصال
        for(let groupId in db.groups) {
            if(db.groups[groupId].members.includes(userId)) {
                socket.join(groupId);
            }
        }
    });

    socket.on('check-status', (targetId) => {
        socket.emit('status-response', { targetId, status: activeSockets[targetId] ? 'online' : 'offline' });
    });

    // إنشاء مجموعة جديدة ديناميكية
    socket.on('create-group', ({ groupName, creatorId }) => {
        const gID = 'g' + Math.floor(10000 + Math.random() * 90000);
        db.groups[gID] = {
            id: gID,
            name: groupName,
            creator: creatorId,
            admins: [creatorId],
            members: [creatorId]
        };
        saveData();
        
        if (activeSockets[creatorId]) {
            io.sockets.sockets.get(activeSockets[creatorId]).join(gID);
        }
        socket.emit('group-created', db.groups[gID]);
    });

    // إرسال الرسائل (خاص أو جروب)
    socket.on('private-message', (data) => {
        if(data.isGroup) {
            socket.to(data.receiverId).emit('receive-message', data);
        } else {
            const receiverSocketId = activeSockets[data.receiverId];
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('receive-message', data);
            }
        }
    });

    // تحديث حالة قراءة الرسالة (شوهد)
    socket.on('msg-read-receipt', ({ senderId, receiverId }) => {
        const senderSocket = activeSockets[senderId];
        if(senderSocket) {
            io.to(senderSocket).emit('msg-seen-confirmed', { receiverId });
        }
    });

    // التفاعلات بالإيموجي على الرسائل
    socket.on('send-reaction', ({ msgId, emoji, receiverId, isGroup, senderId }) => {
        if(isGroup) {
            socket.to(receiverId).emit('receive-reaction', { msgId, emoji, senderId });
        } else {
            const recSocket = activeSockets[receiverId];
            if(recSocket) io.to(recSocket).emit('receive-reaction', { msgId, emoji, senderId });
        }
    });

    // إدارة الجروب (تعيين أدمن / طرد)
    socket.on('manage-group', ({ groupId, action, targetMemberId, adminId }) => {
        const group = db.groups[groupId];
        if (!group || !group.admins.includes(adminId)) return;

        if (action === 'promote' && !group.admins.includes(targetMemberId)) {
            group.admins.push(targetMemberId);
            io.to(groupId).emit('group-updated', { groupId, message: `تم تعيين ${db.users[targetMemberId]?.name} كمشرف في المجموعة 🛠️`, group });
        } else if (action === 'kick') {
            group.members = group.members.filter(m => m !== targetMemberId);
            group.admins = group.admins.filter(a => a !== targetMemberId);
            
            io.to(groupId).emit('group-updated', { groupId, message: `تم طرد مستخدم من المجموعة 🚫`, group });
            
            const kickedSocket = activeSockets[targetMemberId];
            if (kickedSocket) {
                io.sockets.sockets.get(kickedSocket).leave(groupId);
                io.to(kickedSocket).emit('kicked-from-group', { groupId });
            }
        }
        saveData();
    });

    // انضمام لجروب قائم عبر البحث
    socket.on('join-group', ({ groupId, userId }) => {
        if(db.groups[groupId] && !db.groups[groupId].members.includes(userId)) {
            db.groups[groupId].members.push(userId);
            saveData();
            socket.join(groupId);
            io.to(groupId).emit('group-updated', { groupId, message: `انضم ${db.users[userId]?.name} للمجموعة 🎉`, group: db.groups[groupId] });
            socket.emit('join-success', db.groups[groupId]);
        }
    });

    socket.on('typing-signal', ({ senderId, receiverId, isTyping, isGroup }) => {
        if(isGroup) {
            socket.to(receiverId).emit('typing-receive', { senderId, senderName: db.users[senderId]?.name || 'شخص ما', isTyping, isGroup: true, groupId: receiverId });
        } else {
            const recSocket = activeSockets[receiverId];
            if (recSocket) io.to(recSocket).emit('typing-receive', { senderId, isTyping, isGroup: false });
        }
    });

    socket.on('disconnect', () => {
        if(socket.userId) {
            delete activeSockets[socket.userId];
            io.emit('user-status-change', { userId: socket.userId, status: 'offline' });
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 سيرفر النيون الخارق شغال تمام وجاهز على: http://localhost:${PORT}`);
});