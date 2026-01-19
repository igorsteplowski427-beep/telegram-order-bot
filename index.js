require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// === KONFIG (z .env) ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // base64 32 bytes
const OPERATOR_CHAT_ID = process.env.OPERATOR_CHAT_ID || ''; // np. Twój adminID - do testów

if (!BOT_TOKEN) {
  console.error('Brak BOT_TOKEN w .env');
  process.exit(1);
}
if (!ENCRYPTION_KEY) {
  console.error('Brak ENCRYPTION_KEY w .env');
  process.exit(1);
}

// === Inicjalizacja bota ===
const bot = new Telegraf(BOT_TOKEN);

// === Prosta baza (sqlite) ===
const db = new Database('./orders.db');
db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  name TEXT,
  items TEXT,
  total REAL,
  payment_method TEXT,
  payment_status TEXT,
  blik_code_enc TEXT,
  assigned_operator_id INTEGER,
  reserved_until INTEGER,
  tracking_number TEXT
);
CREATE TABLE IF NOT EXISTS operators (
  id INTEGER PRIMARY KEY,
  role TEXT,
  available INTEGER DEFAULT 0
);
`);

// === Szyfrowanie AES-256-GCM ===
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const key = Buffer.from(ENCRYPTION_KEY, 'base64');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('base64') + ':' + tag.toString('base64') + ':' + encrypted.toString('base64');
}
function decrypt(payload) {
  const [ivB64, tagB64, dataB64] = payload.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(dataB64, 'base64');
  const key = Buffer.from(ENCRYPTION_KEY, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(enc), decipher.final()]);
  return decrypted.toString('utf8');
}

// === Helpers DB ===
function createOrder(obj) {
  const id = crypto.randomBytes(6).toString('hex');
  const stmt = db.prepare(`INSERT INTO orders (id,user_id,name,items,total,payment_status,reserved_until) VALUES (?,?,?,?,?,?,?)`);
  stmt.run(id, obj.user_id, obj.name, obj.items, obj.total, 'reserved', Date.now() + 30*60*1000);
  return id;
}
function getOrder(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}
function setBlik(id, enc, operatorId) {
  db.prepare('UPDATE orders SET blik_code_enc = ?, assigned_operator_id = ?, payment_method = ?, payment_status = ? WHERE id = ?')
    .run(enc, operatorId, 'blik', 'pending', id);
}

// === Komendy operatorów (proste) ===
bot.command('available', async ctx => {
  const id = ctx.from.id;
  const role = 'manager';
  db.prepare('INSERT OR REPLACE INTO operators (id, role, available) VALUES (?,?,?)').run(id, role, 1);
  await ctx.reply('Ustawiono: dostępny jako operator.');
});
bot.command('unavailable', async ctx => {
  const id = ctx.from.id;
  db.prepare('INSERT OR REPLACE INTO operators (id, role, available) VALUES (?,?,?)').run(id, 'manager', 0);
  await ctx.reply('Ustawiono: niedostępny.');
});

// === /start i instrukcja zamówienia ===
bot.start(async ctx => {
  const text = `Witaj! Aby zamówić wpisz /order\nMinimalne zamówienie: 500 PLN.\nDo testów: ustaw operatora: /available`;
  await ctx.reply(text);
});

// === Rozpoczęcie zamówienia — uproszczony flow ===
bot.command('order', async ctx => {
  await ctx.reply('Wklej proszę formularz (Imię,Miasto,E-mail,Tel,Produkty (nazwa/ilość/cena każda w nowej linii)).');
  ctx.session = ctx.session || {};
  ctx.session.awaitOrder = true;
});

// Prostą wiadomość tekstową traktujemy jako formularz jeśli oczekujemy
bot.on('text', async ctx => {
  ctx.session = ctx.session || {};
  if (!ctx.session.awaitOrder) return;

  const raw = ctx.message.text;
  // Bardzo prosta parsowanie: ostatnie linie to items
  const lines = raw.split('\n').map(s=>s.trim()).filter(Boolean);
  const name = lines[0] || ctx.from.first_name || 'Klient';
  const itemsText = lines.slice(4).join('\n') || lines.slice(1).join('\n');
  // compute total: proste - patrz pricing "nazwa / ilość / cena"
  let total = 0;
  const itemLines = itemsText.split('\n').filter(Boolean);
  for (const l of itemLines) {
    const p = l.split('/').map(x=>x.trim());
    if (p.length>=3) {
      const qty = parseInt(p[1])||1;
      const price = parseFloat(p[2].replace(/[^0-9.]/g,''))||0;
      total += qty*price;
    }
  }
  if (total < 500) {
    await ctx.reply(`Łączna wartość to ${total.toFixed(2)} PLN — minimalne zamówienie 500 PLN. Dopisz produkty lub napisz 'DOPEŁNIAM'.`);
    return;
  }

  const orderId = createOrder({user_id: ctx.from.id, name, items: itemsText, total});
  ctx.session.awaitOrder = false;

  const msg = `Zamówienie zarezerwowane (ID: ${orderId}). Kwota: ${total.toFixed(2)} PLN.\nWybierz sposób płatności:`, 
  keyboard = Markup.keyboard([['Czek BLIK'], ['Krypto'], ['Przelew']]).oneTime().resize();
  await ctx.reply(msg, keyboard);
  // zapamiętaj w sesji
  ctx.session.orderId = orderId;
});

// Obsługa wyboru płatności
bot.hears('Czek BLIK', async ctx => {
  ctx.session = ctx.session || {};
  const orderId = ctx.session.orderId;
  if (!orderId) return ctx.reply('Brak aktywnego zamówienia. Wpisz /order');

  // znajdź dostępnego operatora (proste)
  const op = db.prepare('SELECT id FROM operators WHERE available = 1 LIMIT 1').get();
  if (!op) return ctx.reply('Żaden operator nie jest dostępny. Wybierz inną metodę płatności lub spróbuj później.');

  await ctx.reply('Wyślij teraz 6-cyfrowy kod BLIK (tylko liczby). Kod zostanie przekazany do przypisanego operatora i ważny 30 minut.');
  ctx.session.awaitBlik = true;
  ctx.session.orderId = orderId;
  ctx.session.assignedOperator = op.id;
});

bot.on('text', async ctx => {
  // obsługa BLIK gdy oczekujemy
  ctx.session = ctx.session || {};
  if (!ctx.session.awaitBlik) return;
  const code = ctx.message.text.trim();
  if (!/^\d{6}$/.test(code)) return ctx.reply('Kod BLIK musi mieć 6 cyfr. Spróbuj ponownie.');

  const enc = encrypt(code);
  setBlik(ctx.session.orderId, enc, ctx.session.assignedOperator);

  // powiadom operatora prywatnie
  const opId = ctx.session.assignedOperator;
  await bot.telegram.sendMessage(opId, `Nowy BLIK (order ${ctx.session.orderId}) — kod: ${code}\nPo wykonaniu płatności potwierdź: /confirm_blik ${ctx.session.orderId}`);
  await ctx.reply('Kod BLIK przesłany do operatora. Operator ma 30 minut na odbiór. Po potwierdzeniu otrzymasz info o wysyłce.');
  ctx.session.awaitBlik = false;
});

// Komenda operatora: potwierdź blik
bot.command('confirm_blik', async ctx => {
  const parts = ctx.message.text.split(' ');
  const orderId = parts[1];
  if (!orderId) return ctx.reply('Użycie: /confirm_blik <orderId>');
  const order = getOrder(orderId);
  if (!order) return ctx.reply('Brak takiego zamówienia.');
  if (order.assigned_operator_id && order.assigned_operator_id !== ctx.from.id) return ctx.reply('Nie jesteś przypisanym operatorem.');
  // ustaw paid i usuń kod
  db.prepare('UPDATE orders SET payment_status = ?, blik_code_enc = NULL WHERE id = ?').run('paid', orderId);
  await ctx.reply(`Potwierdzone: order ${orderId} oznaczony jako OPŁACONY.`);
  await bot.telegram.sendMessage(order.user_id, `Płatność potwierdzona. Numer nadania prześlę w ciągu 12 godzin.`);
});

bot.launch().then(()=>console.log('Bot launched'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
