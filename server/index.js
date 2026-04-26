const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(cors({ origin: ['http://localhost:3000', 'https://pixel-canvas-client-tan.vercel.app'] }));
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ['http://localhost:3000', 'https://pixel-canvas-client-tan.vercel.app'], methods: ['GET', 'POST'] }
});

const JWT_SECRET = process.env.JWT_SECRET || 'pixelgarden_secret';

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const generateCode = () => Math.random().toString(36).substring(2, 10).toUpperCase();

pool.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS game_type VARCHAR(30) DEFAULT 'pixel_painting'`).catch(console.error);
pool.query(`CREATE TABLE IF NOT EXISTS game_rounds (
  id SERIAL PRIMARY KEY,
  room_id INTEGER REFERENCES rooms(id),
  round_number INTEGER,
  true_prompt VARCHAR(200),
  impostor_prompt VARCHAR(200),
  status VARCHAR(20) DEFAULT 'waiting',
  created_at TIMESTAMP DEFAULT NOW()
)`).catch(console.error);

pool.query(`CREATE TABLE IF NOT EXISTS prompt_games (
  id SERIAL PRIMARY KEY,
  canvas_id INTEGER,
  word VARCHAR(100),
  status VARCHAR(20) DEFAULT 'drawing',
  created_at TIMESTAMP DEFAULT NOW()
)`).catch(console.error);

pool.query(`CREATE TABLE IF NOT EXISTS grow_tiles (
  id SERIAL PRIMARY KEY,
  canvas_id INTEGER,
  x INTEGER,
  y INTEGER,
  player_username VARCHAR(100),
  color VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(canvas_id, x, y)
)`).catch(console.error);

pool.query(`CREATE TABLE IF NOT EXISTS wordle_scores (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  word_name VARCHAR(50),
  guesses_count INTEGER,
  won BOOLEAN,
  played_at DATE DEFAULT CURRENT_DATE,
  UNIQUE(user_id, played_at)
)`).catch(console.error);

const seedCanvasTiles = async (canvasId) => {
  const values = [];
  for (let x = 0; x < 50; x++) {
    for (let y = 0; y < 50; y++) {
      values.push(`(${canvasId}, ${x}, ${y})`);
    }
  }
  const chunkSize = 500;
  for (let i = 0; i < values.length; i += chunkSize) {
    const chunk = values.slice(i, i + chunkSize).join(',');
    await pool.query(`INSERT INTO canvas_tiles (canvas_id, x, y) VALUES ${chunk} ON CONFLICT DO NOTHING`);
  }
};

app.post('/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'All fields required' });
  try {
    const exists = await pool.query(
      'SELECT id FROM users WHERE email = $1 OR username = $2', [email, username]
    );
    if (exists.rows.length > 0)
      return res.status(400).json({ error: 'Username or email already taken' });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username',
      [username, email, hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, username: user.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0)
      return res.status(400).json({ error: 'Invalid email or password' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match)
      return res.status(400).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, username: user.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/canvases', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM canvases WHERE owner_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch canvases' });
  }
});

app.post('/canvases', auth, async (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  try {
    const result = await pool.query(
      'INSERT INTO canvases (title, description, owner_id) VALUES ($1, $2, $3) RETURNING *',
      [title, description || '', req.user.id]
    );
    const canvas = result.rows[0];
    await seedCanvasTiles(canvas.id);
    res.json(canvas);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create canvas' });
  }
});

app.delete('/canvases/:id', auth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM canvases WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete canvas' });
  }
});

app.get('/canvases/:id/tiles', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM canvas_tiles WHERE canvas_id = $1 ORDER BY y, x',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tiles' });
  }
});

app.post('/canvases/:id/tiles', auth, async (req, res) => {
  const { x, y, color } = req.body;
  try {
    await pool.query(
      'UPDATE canvas_tiles SET color = $1, owner_id = $2, last_updated = NOW() WHERE canvas_id = $3 AND x = $4 AND y = $5',
      [color, req.user.id, req.params.id, x, y]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save tile' });
  }
});

app.delete('/canvases/:id/tiles', auth, async (req, res) => {
  try {
    await pool.query(
      "UPDATE canvas_tiles SET color = '#FFFFFF', owner_id = NULL WHERE canvas_id = $1",
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clear canvas' });
  }
});

app.get('/stats', auth, async (req, res) => {
  try {
    const [canvasesResult, tilesResult] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM canvases WHERE owner_id = $1', [req.user.id]),
      pool.query('SELECT COUNT(*) FROM canvas_tiles WHERE owner_id = $1', [req.user.id]),
    ]);
    res.json({
      canvases_count: parseInt(canvasesResult.rows[0].count),
      tiles_painted: parseInt(tilesResult.rows[0].count),
      games_played: 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.post('/prompt-games', auth, async (req, res) => {
  const { canvasId, word } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO prompt_games (canvas_id, word) VALUES ($1, $2) RETURNING *',
      [canvasId, word]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create prompt game' });
  }
});

app.get('/prompt-games/:canvasId', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM prompt_games WHERE canvas_id = $1 ORDER BY created_at DESC LIMIT 1',
      [req.params.canvasId]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch prompt game' });
  }
});

app.post('/grow-tiles', auth, async (req, res) => {
  const { canvasId, x, y, color } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO grow_tiles (canvas_id, x, y, player_username, color)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (canvas_id, x, y) DO NOTHING RETURNING *`,
      [canvasId, x, y, req.user.username, color]
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save grow tile' });
  }
});

app.get('/grow-tiles/:canvasId', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM grow_tiles WHERE canvas_id = $1',
      [req.params.canvasId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch grow tiles' });
  }
});

app.post('/wordle-scores', auth, async (req, res) => {
  const { wordName, guessesCount, won } = req.body;
  try {
    await pool.query(
      `INSERT INTO wordle_scores (user_id, word_name, guesses_count, won)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, played_at) DO UPDATE
       SET guesses_count = EXCLUDED.guesses_count, won = EXCLUDED.won`,
      [req.user.id, wordName, guessesCount, won]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save score' });
  }
});

app.post('/rooms', auth, async (req, res) => {
  const { canvasId, mode } = req.body;
  try {
    const code = generateCode();
    const result = await pool.query(
      'INSERT INTO rooms (code, canvas_id, owner_id, mode) VALUES ($1, $2, $3, $4) RETURNING *',
      [code, canvasId, req.user.id, mode || 'free']
    );
    const room = result.rows[0];
    await pool.query(
      'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [room.id, req.user.id]
    );
    res.json(room);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

app.post('/rooms/join', auth, async (req, res) => {
  const { code } = req.body;
  try {
    const result = await pool.query(
      `SELECT r.*, c.title, c.description FROM rooms r
       JOIN canvases c ON c.id = r.canvas_id
       WHERE r.code = $1`, [code]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Room not found' });
    const room = result.rows[0];
    await pool.query(
      'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [room.id, req.user.id]
    );
    res.json(room);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to join room' });
  }
});

const roomStates = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join_room', ({ roomCode, username }) => {
    socket.join(roomCode);
    socket.username = username;
    socket.roomCode = roomCode;

    if (!roomStates[roomCode]) {
      roomStates[roomCode] = { members: [], currentTurn: null, turnTimer: null, mode: 'free' };
    }

    if (!roomStates[roomCode].members.includes(username)) {
      roomStates[roomCode].members.push(username);
    }

    io.to(roomCode).emit('room_members', roomStates[roomCode].members);
  });

  socket.on('set_mode', ({ roomCode, mode }) => {
    if (!roomStates[roomCode]) return;
    roomStates[roomCode].mode = mode;

    if (mode === 'battle') {
      const members = roomStates[roomCode].members;
      if (members.length > 0) {
        roomStates[roomCode].currentTurn = members[0];
        io.to(roomCode).emit('turn_change', { currentTurn: members[0], timeLeft: 30 });
        startTurnTimer(roomCode);
      }
    } else {
      if (roomStates[roomCode].turnTimer) {
        clearInterval(roomStates[roomCode].turnTimer);
        roomStates[roomCode].turnTimer = null;
      }
      io.to(roomCode).emit('mode_change', { mode: 'free' });
    }
  });

  socket.on('paint_tile', ({ roomCode, x, y, color, username }) => {
    const state = roomStates[roomCode];
    if (state && state.mode === 'battle' && state.currentTurn !== username) return;
    socket.to(roomCode).emit('tile_updated', { x, y, color, username });
  });

  socket.on('set_prompt_word', ({ roomCode, word }) => {
    if (!roomStates[roomCode]) return;
    roomStates[roomCode].promptWord = word;
    io.to(roomCode).emit('prompt_word_set', { word });
  });

  socket.on('guess', ({ roomCode, username, text }) => {
    if (!roomStates[roomCode]) return;
    const correct = roomStates[roomCode].promptWord &&
      text.toLowerCase() === roomStates[roomCode].promptWord.toLowerCase();
    io.to(roomCode).emit('guess_received', { username, text, correct });
  });

  socket.on('grow_tile', ({ roomCode, x, y, color, username }) => {
    if (!roomStates[roomCode]) return;
    if (!roomStates[roomCode].growTiles) roomStates[roomCode].growTiles = {};
    roomStates[roomCode].growTiles[`${x},${y}`] = { username, color };
    io.to(roomCode).emit('tile_grown', { x, y, color, username });
  });

  socket.on('impostor_start', ({ roomCode, truePrompt, impostorPrompt, players }) => {
    if (!roomStates[roomCode]) return;
    roomStates[roomCode].impostorPhase = 'drawing';
    const impostorIdx = Math.floor(Math.random() * players.length);
    players.forEach((player, idx) => {
      const prompt = idx === impostorIdx ? impostorPrompt : truePrompt;
      io.to(roomCode).emit('impostor_assigned', { player, prompt, isImpostor: idx === impostorIdx });
    });
  });

  socket.on('player_ready', ({ roomCode, username }) => {
    if (!roomStates[roomCode]) return;
    if (!roomStates[roomCode].readyPlayers) roomStates[roomCode].readyPlayers = new Set();
    roomStates[roomCode].readyPlayers.add(username);
    const total = roomStates[roomCode].members.length;
    const ready = roomStates[roomCode].readyPlayers.size;
    io.to(roomCode).emit('ready_update', { ready, total });
    if (ready >= total) {
      roomStates[roomCode].impostorPhase = 'voting';
      io.to(roomCode).emit('phase_change', { phase: 'voting' });
    }
  });

  socket.on('cast_vote', ({ roomCode, voter, target }) => {
    if (!roomStates[roomCode]) return;
    if (!roomStates[roomCode].votes) roomStates[roomCode].votes = {};
    roomStates[roomCode].votes[voter] = target;
    const total = roomStates[roomCode].members.length;
    const count = Object.keys(roomStates[roomCode].votes).length;
    io.to(roomCode).emit('vote_update', { count, total });
    if (count >= total) {
      const tallied = {};
      Object.values(roomStates[roomCode].votes).forEach(v => {
        tallied[v] = (tallied[v] || 0) + 1;
      });
      const mostVoted = Object.entries(tallied).sort((a, b) => b[1] - a[1])[0][0];
      roomStates[roomCode].impostorPhase = 'results';
      io.to(roomCode).emit('results', { votes: roomStates[roomCode].votes, tallied, mostVoted });
    }
  });

  socket.on('disconnect', () => {
    const { roomCode, username } = socket;
    if (roomCode && roomStates[roomCode]) {
      roomStates[roomCode].members = roomStates[roomCode].members.filter(m => m !== username);
      io.to(roomCode).emit('room_members', roomStates[roomCode].members);
    }
  });
});

function startTurnTimer(roomCode) {
  let timeLeft = 30;
  if (roomStates[roomCode].turnTimer) clearInterval(roomStates[roomCode].turnTimer);

  roomStates[roomCode].turnTimer = setInterval(() => {
    timeLeft--;
    io.to(roomCode).emit('timer_tick', { timeLeft });

    if (timeLeft <= 0) {
      clearInterval(roomStates[roomCode].turnTimer);
      const members = roomStates[roomCode].members;
      if (members.length === 0) return;
      const currentIndex = members.indexOf(roomStates[roomCode].currentTurn);
      const nextIndex = (currentIndex + 1) % members.length;
      roomStates[roomCode].currentTurn = members[nextIndex];
      io.to(roomCode).emit('turn_change', { currentTurn: members[nextIndex], timeLeft: 30 });
      startTurnTimer(roomCode);
    }
  }, 1000);
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));