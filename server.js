const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const http = require('http'); // Для Socket.io
const { Server } = require("socket.io"); // Сам Socket.io
const db = require('./database');
const fs = require('fs'); // Добавляем модуль для работы с файловой системой

const app = express();
const server = http.createServer(app); // Создаем HTTP сервер
const io = new Server(server); // Подключаем к нему Socket.io
const PORT = 3000;

// --- КОНФИГУРАЦИЯ ---
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Для обработки JSON запросов (лайки/комментарии)

app.use(session({
    secret: 'neotube_secret_key_strong_random_string',
    resave: false,
    saveUninitialized: false,
    // cookie: { maxAge: 1000 * 60 * 60 * 24 } <-- УБЕРИТЕ ЭТУ СТРОКУ
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

const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log('Created missing upload directory: public/uploads');
}

// Middleware для проверки авторизации
const isAuthenticated = (req, res, next) => {
    if (req.session.userId) return next();
    res.redirect('/login');
};

// --- МАРШРУТЫ АВТОРИЗАЦИИ И СТАРТА ---

// Главная страница (Сортировка по просмотрам)
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
    // Используем default.png если файл не загружен
    const avatar = req.file ? req.file.filename : 'default.png'; 
    const hash = bcrypt.hashSync(password, 10);
    
    db.run(`INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)`, 
        [username, hash, avatar], (err) => {
        if (err) return res.send("Error: Username already taken.");
        res.redirect('/login');
    });
});

// Вход
app.get('/login', (req, res) => res.render('login'));
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.send("Invalid username or password.");
        }
        
        // --- ЛОГИКА АВТОМАТИЧЕСКОГО ВХОДА ---
        
        // Устанавливаем долгий срок жизни куки (30 дней), если пользователь вошел
        // Это заменяет функционал "Запомнить меня"
        req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30; // 30 дней
        
        // Сохраняем данные пользователя в сессию
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.avatar = user.avatar;
        
        res.redirect('/');
    });
});

// Выход
// Выход
app.get('/logout', (req, res) => {
    // Обнуляем срок жизни куки, чтобы она сразу удалилась из браузера
    if (req.session) {
        req.session.cookie.maxAge = 0;
    }
    req.session.destroy();
    res.redirect('/');
});

// --- МАРШРУТЫ КАНАЛА И ЗАГРУЗКИ ---

// Загрузка видео (Видео + Превью + Описание)
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
            return res.status(404).render('404', { message: "Channel not found." }); // Используйте 404.ejs
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

// --- МАРШРУТЫ ПРОСМОТРА И ВЗАИМОДЕЙСТВИЯ (VIEW & API) ---

// Просмотр видео (с защитой от накрутки просмотров)
app.get('/watch/:id', (req, res) => {
    const videoId = req.params.id;
    
    // ЛОГИКА АНТИ-ДЮПА: Проверяем, смотрел ли юзер это видео в этой сессии
    if (!req.session.viewedVideos) req.session.viewedVideos = [];
    
    const renderPage = () => {
        db.get(`SELECT videos.*, users.username, users.avatar as author_avatar FROM videos JOIN users ON videos.user_id = users.id WHERE videos.id = ?`, [videoId], (err, video) => {
            if (!video) return res.status(404).send("Video not found.");
            
            db.all(`SELECT comments.*, users.username, users.avatar FROM comments JOIN users ON comments.user_id = users.id WHERE video_id = ? ORDER BY id DESC`, [videoId], (err, comments) => {
                db.get(`SELECT COUNT(*) as likes FROM likes WHERE video_id = ?`, [videoId], (err, l) => {
                    db.get(`SELECT COUNT(*) as dislikes FROM dislikes WHERE video_id = ?`, [videoId], (err, d) => {
                        res.render('watch', { 
                            video, comments, 
                            likes: l.likes, dislikes: d.dislikes, 
                            user: req.session.userId, 
                            currentUserAvatar: req.session.avatar,
                            currentUsername: req.session.username
                        });
                    });
                });
            });
        });
    };

    if (req.session.userId && !req.session.viewedVideos.includes(videoId)) {
        db.run(`UPDATE videos SET views = views + 1 WHERE id = ?`, [videoId], () => {
            req.session.viewedVideos.push(videoId); // Запоминаем ID
            renderPage();
        });
    } else {
        renderPage(); // Просто показываем
    }
});

// API Лайк
app.post('/api/like/:id', isAuthenticated, (req, res) => {
    const videoId = req.params.id;
    const userId = req.session.userId;
    
    // Удаляем дизлайк, если есть
    db.run(`DELETE FROM dislikes WHERE user_id = ? AND video_id = ?`, [userId, videoId], () => {
        // Проверяем, есть ли лайк
        db.get(`SELECT * FROM likes WHERE user_id = ? AND video_id = ?`, [userId, videoId], (err, row) => {
            if (row) {
                // Лайк уже есть, удаляем его (Un-like)
                db.run(`DELETE FROM likes WHERE user_id = ? AND video_id = ?`, [userId, videoId], sendStats);
            } else {
                // Лайка нет, добавляем его
                db.run(`INSERT INTO likes (user_id, video_id) VALUES (?, ?)`, [userId, videoId], sendStats);
            }
        });
    });

    // Функция отправки обновленной статистики через Socket.io
    function sendStats() {
        db.get(`SELECT COUNT(*) as c FROM likes WHERE video_id = ?`, [videoId], (e, l) => {
            db.get(`SELECT COUNT(*) as c FROM dislikes WHERE video_id = ?`, [videoId], (e, d) => {
                io.emit('update_stats', { videoId, likes: l.c, dislikes: d.c });
                res.json({ status: 'ok' });
            });
        });
    }
});

// API Дизлайк
app.post('/api/dislike/:id', isAuthenticated, (req, res) => {
    const videoId = req.params.id;
    const userId = req.session.userId;

    // Удаляем лайк, если есть
    db.run(`DELETE FROM likes WHERE user_id = ? AND video_id = ?`, [userId, videoId], () => {
        // Проверяем, есть ли дизлайк
        db.get(`SELECT * FROM dislikes WHERE user_id = ? AND video_id = ?`, [userId, videoId], (err, row) => {
            if (row) {
                // Дизлайк уже есть, удаляем его (Un-dislike)
                db.run(`DELETE FROM dislikes WHERE user_id = ? AND video_id = ?`, [userId, videoId], sendStats);
            } else {
                // Дизлайка нет, добавляем его
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

// API Комментарий
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

// Обработка соединения Socket.io (минимальная, так как основная логика в маршрутах)
io.on('connection', (socket) => {
    // console.log('A user connected');
    // socket.on('disconnect', () => {
    //     console.log('User disconnected');
    // });
});

// Запускаем HTTP сервер с Socket.io
server.listen(PORT, () => console.log(`NeoTube + Socket.io running on http://localhost:${PORT}`));