const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./neotube.db');

db.serialize(() => {
    // Таблица пользователей
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        avatar TEXT
    )`);

    // Таблица видео
    db.run(`CREATE TABLE IF NOT EXISTS videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        title TEXT,
        filename TEXT,
        thumbnail TEXT,
        views INTEGER DEFAULT 0,
        description TEXT, -- НОВОЕ ПОЛЕ для описания видео
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // Таблица лайков
    db.run(`CREATE TABLE IF NOT EXISTS likes (
        user_id INTEGER,
        video_id INTEGER,
        PRIMARY KEY (user_id, video_id)
    )`);

    // Таблица комментариев
    db.run(`CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        video_id INTEGER,
        text TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // Таблица дизлайков (если не создана)
    db.run(`CREATE TABLE IF NOT EXISTS dislikes (
        user_id INTEGER,
        video_id INTEGER,
        PRIMARY KEY (user_id, video_id)
    )`);
});

module.exports = db;