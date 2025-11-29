const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs'); // Для надежного создания папки uploads
const http = require('http'); 
const { Server } = require("socket.io"); 
const db = require('./database'); // Убедитесь, что database.js существует

const app = express();
const server = http.createServer(app); 
const io = new Server(server); 
const PORT = 3000;

// --- КОНФИГУРАЦИЯ СЕРВЕРА И ФАЙЛОВОЙ СИСТЕМЫ ---

// Гарантия существования папки uploads
const uploadDir = path.join(__dirname, 'public', 'uploads'); 
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log('Successfully created the upload directory: public/uploads');
}

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Конфигурация сессий (автоматический вход через долгосрочные куки)
app.use(session({
    secret: 'neotube_secret_key_strong_random_string',
    resave: false,
    saveUninitialized: false,
    // MaxAge будет установлен вручную при успешном логине
}));

// Настройка загрузки файлов (Multer)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/uploads/'); 
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Middleware для проверки авторизации
const isAuthenticated = (req, res, next) => {
    if (req.session.userId) return next();
    res.redirect('/login');
};

// --- МАРШРУТЫ АВТОРИЗАЦИИ И ГЛАВНАЯ СТРАНИЦА ---

// Главная страница
app.get('/', (req, res) => {
    db.all(`SELECT videos.*, users.username, users.avatar as user_avatar 
            FROM videos 
            JOIN users ON videos.user_id = users.id 
            ORDER BY views DESC`, [], (err, videos) => {
        res.render('index', { videos, user: req.session.userId });
    });
});

// Регистрация
app.get('/register', (req, res) => res.render('register'));
app.post('/register', upload.single('avatar'), (req, res) => {
    const { username, password } = req.body;
    const avatar = req.file ? req.file.filename : 'default.png'; 
    const hash = bcrypt.hashSync(password, 10);
    
    db.run(`INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)`, 
        [username, hash, avatar], (err) => {
        if (err) return res.send("Error: Username already taken.");
        res.redirect('/login');
    });
});

// Вход (с установкой долгосрочной куки для автоматического входа)
app.get('/login', (req, res) => res.render('login'));
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.send("Invalid username or password.");
        }
        
        // Устанавливаем долгий срок жизни куки (30 дней) для автоматического входа
        req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;
        
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.avatar = user.avatar;
        res.redirect('/');
    });
});

// Выход (удаление куки)
app.get('/logout', (req, res) => {
    if (req.session) {
        req.session.cookie.maxAge = 0; // Сразу удаляем куки
    }
    req.session.destroy();
    res.redirect('/');
});

// --- МАРШРУТЫ ЗАГРУЗКИ И КАНАЛА ---

// Загрузка видео (с полем description)
app.get('/upload', isAuthenticated, (req, res) => res.render('upload'));
app.post('/upload', isAuthenticated, upload.fields([{ name: 'video' }, { name: 'thumbnail' }]), (req, res) => {
    const { title, description } = req.body;
    const videoFile = req.files['video'][0].filename;
    const thumbFile = req.files['thumbnail'][0].filename;

    db.run(`INSERT INTO videos (user_id, title, filename, thumbnail, description) VALUES (?, ?, ?, ?, ?)`,
        [req.session.userId, title, videoFile, thumbFile, description], 
        () => {
            res.redirect('/');
        });
});

// Страница канала
app.get('/channel/:username/:userId', (req, res) => {
    const { userId, username } = req.params;

    db.get(`SELECT id, username, avatar FROM users WHERE id = ? AND username = ?`, [userId, username], (err, channelUser) => {
        if (err || !channelUser) {
            return res.status(404).send("Channel not found.");
        }

        db.all(`SELECT * FROM videos WHERE user_id = ? ORDER BY id DESC`, [userId], (err, videos) => {
            if (err) {
                return res.status(500).send("Error loading videos.");
            }

            res.render('channel', {
                channelUser: channelUser,
                videos: videos,
                currentUser: req.session.userId 
            });
        });
    });
});

// --- МАРШРУТЫ ПРОСМОТРА И API (Socket.io) ---

// Просмотр видео (с защитой от накрутки просмотров)
app.get('/watch/:id', (req, res) => {
    const videoId = req.params.id;
    
    if (!req.session.viewedVideos) req.session.viewedVideos = [];
    
    const renderPage = () => {
        db.get(`SELECT videos.*, users.username, users.avatar as author_avatar, users.id as user_id FROM videos JOIN users ON videos.user_id = users.id WHERE videos.id = ?`, [videoId], (err, video) => {
            if (!video) return res.status(404).send("Video not found.");
            
            db.all(`SELECT comments.*, users.username, users.avatar FROM comments JOIN users ON comments.user_id = users.id WHERE video_id = ? ORDER BY id DESC`, [videoId], (err, comments) => {
                db.get(`SELECT COUNT(*) as likes FROM likes WHERE video_id = ?`, [videoId], (err, l) => {
                    db.get(`SELECT COUNT(*) as dislikes FROM dislikes WHERE video_id = ?`, [videoId], (err, d) => {
                        res.render('watch', { 
                            video, comments, 
                            likes: l.likes, dislikes: d.dislikes, 
                            user: req.session.userId, 
                            currentUserAvatar: req.session.avatar
                        });
                    });
                });
            });
        });
    };

    if (req.session.userId && !req.session.viewedVideos.includes(videoId)) {
        db.run(`UPDATE videos SET views = views + 1 WHERE id = ?`, [videoId], () => {
            req.session.viewedVideos.push(videoId);
            renderPage();
        });
    } else {
        renderPage();
    }
});

// API Лайк (Socket.io)
app.post('/api/like/:id', isAuthenticated, (req, res) => {
    const videoId = req.params.id;
    const userId = req.session.userId;
    
    db.run(`DELETE FROM dislikes WHERE user_id = ? AND video_id = ?`, [userId, videoId], () => {
        db.get(`SELECT * FROM likes WHERE user_id = ? AND video_id = ?`, [userId, videoId], (err, row) => {
            if (row) {
                db.run(`DELETE FROM likes WHERE user_id = ? AND video_id = ?`, [userId, videoId], sendStats);
            } else {
                db.run(`INSERT INTO likes (user_id, video_id) VALUES (?, ?)`, [userId, videoId], sendStats);
            }
        });
    });

    function sendStats() {
        db.get(`SELECT COUNT(*) as c FROM likes WHERE video_id = ?`, [videoId], (e, l) => {
            db.get(`SELECT COUNT(*) as c FROM dislikes WHERE video_id = ?`, [videoId], (e, d) => {
                io.emit('update_stats', { videoId, likes: l.c, dislikes: d.c });
                res.json({ status: 'ok' });
            });
        });
    }
});

// API Дизлайк (Socket.io)
app.post('/api/dislike/:id', isAuthenticated, (req, res) => {
    const videoId = req.params.id;
    const userId = req.session.userId;

    db.run(`DELETE FROM likes WHERE user_id = ? AND video_id = ?`, [userId, videoId], () => {
        db.get(`SELECT * FROM dislikes WHERE user_id = ? AND video_id = ?`, [userId, videoId], (err, row) => {
            if (row) {
                db.run(`DELETE FROM dislikes WHERE user_id = ? AND video_id = ?`, [userId, videoId], sendStats);
            } else {
                db.run(`INSERT INTO dislikes (user_id, video_id) VALUES (?, ?)`, [userId, videoId], sendStats);
            }
        });
    });

    function sendStats() {
        db.get(`SELECT COUNT(*) as c FROM likes WHERE video_id = ?`, [videoId], (e, l) => {
            db.get(`SELECT COUNT(*) as c FROM dislikes WHERE video_id = ?`, [videoId], (e, d) => {
                io.emit('update_stats', { videoId, likes: l.c, dislikes: d.c });
                res.json({ status: 'ok' });
            });
        });
    }
});

// API Комментарий (Socket.io)
app.post('/api/comment/:id', isAuthenticated, (req, res) => {
    const videoId = req.params.id;
    const { text } = req.body;
    
    db.run(`INSERT INTO comments (user_id, video_id, text) VALUES (?, ?, ?)`, 
        [req.session.userId, videoId, text], function() {
            // Отправляем всем новое сообщение через сокет
            const newComment = {
                username: req.session.username,
                avatar: req.session.avatar,
                text: text
            };
            io.emit('new_comment', { videoId, comment: newComment });
            res.json({ status: 'ok' });
        });
});

// --- ЗАПУСК СЕРВЕРА ---

io.on('connection', (socket) => {
    // Обработка соединений/отключений Socket.io (минимальная)
});

server.listen(PORT, () => console.log(`NeoTube + Socket.io running on http://localhost:${PORT}`));