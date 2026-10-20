// Бот записи клиентов для мастера (барбершоп «Лезвие»).
// Запуск:  node --env-file=.env bot.js
// .env:  BOT_TOKEN=...   ADMIN_ID=...  (ADMIN_ID — твой Telegram id, узнать командой /myid)

const fs = require("fs");
const { Bot, InlineKeyboard, Keyboard } = require("grammy");

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_ID = Number(process.env.ADMIN_ID || 0); // кому слать уведомления о записях

// ---------- настройки мастера (их меняют под каждого клиента-заказчика) ----------
const SERVICES = [
  { id: "cut", name: "Стрижка", price: 1000 },
  { id: "beard", name: "Борода", price: 600 },
  { id: "combo", name: "Стрижка + борода", price: 1400 },
];
const HOURS = ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00"];
const DAYS_AHEAD = 5; // на сколько дней вперёд можно записаться
const REMIND_BEFORE_HOURS = 2; // за сколько часов напоминать клиенту
const ADDRESS = "ул. Пушкина, 10";

// ---------- хранение записей в файле bookings.json ----------
const FILE = "bookings.json";
function loadBookings() {
  const list = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : [];
  // у старых записей могло не быть id — выдаём и сразу сохраняем, иначе при каждом чтении id будет новый
  const noId = list.filter((b) => !b.id);
  noId.forEach((b) => { b.id = Math.random().toString(36).slice(2, 9); });
  if (noId.length) fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
  return list;
}
const saveBookings = (list) => fs.writeFileSync(FILE, JSON.stringify(list, null, 2));

// ---------- телефоны клиентов (users.json): спрашиваем один раз, дальше помним ----------
const USERS_FILE = "users.json";
const loadUsers = () => (fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE, "utf8")) : {});
const getUser = (userId) => loadUsers()[userId]; // { phone, verified }
// verified = true — номер пришёл кнопкой из Telegram (точно настоящий), false — клиент написал сам
function savePhone(userId, phone, verified) {
  const users = loadUsers();
  users[userId] = { phone, verified };
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
// номер, набранный руками → "+79001234567" или null, если на номер не похоже
function parsePhone(text) {
  const digits = text.replace(/\D/g, "");
  if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) return "+7" + digits.slice(1);
  if (digits.length === 10 && digits[0] === "9") return "+7" + digits;
  if (text.trim().startsWith("+") && digits.length >= 10 && digits.length <= 15) return "+" + digits; // номера других стран
  return null;
}

const drafts = new Map(); // черновик записи, пока человек выбирает

// ---------- даты ----------
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
// "2026-10-21" из локальной даты (не через toISOString — тот даёт время по Гринвичу и ночью ошибается на день)
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// "чт, 21 октября" — как удобно читать человеку
function prettyDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return `${WEEKDAYS[date.getDay()]}, ${d} ${MONTHS[m - 1]}`;
}
// дата + время записи как объект Date (по местному времени)
const bookingDate = (b) => new Date(`${b.day}T${b.time}:00`);

function nextDays() {
  const out = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const iso = isoDay(d);
    out.push({ iso, label: i === 0 ? "Сегодня" : i === 1 ? "Завтра" : prettyDay(iso) });
  }
  return out;
}
const isTaken = (day, time) => loadBookings().some((b) => b.day === day && b.time === time);
// свободные часы: не заняты и (если сегодня) ещё не прошли
const freeHours = (day) =>
  HOURS.filter((h) => !isTaken(day, h) && new Date(`${day}T${h}:00`) > new Date());

// Постоянные кнопки внизу экрана (вместо клавиатуры) — видны всегда, не уезжают вверх с сообщениями
const BTN = { book: "✂️ Записаться", mine: "📋 Мои записи", prices: "💰 Цены", contacts: "📍 Контакты" };
const mainMenu = new Keyboard()
  .text(BTN.book).row()
  .text(BTN.mine).row()
  .text(BTN.prices).text(BTN.contacts)
  .resized()     // кнопки компактные, а не на пол-экрана
  .persistent(); // не прячутся после нажатия

// Кнопка «Отправить номер»: Telegram сам подставляет номер аккаунта — его нельзя выдумать или ввести с ошибкой
// «Ввести другой номер» — если звонить нужно не на тот номер, к которому привязан Telegram
const PHONE_MANUAL = "✏️ Ввести другой номер";
const PHONE_CANCEL = "❌ Отмена";
const phoneKb = new Keyboard().requestContact("📱 Отправить мой номер").row().text(PHONE_MANUAL).row().text(PHONE_CANCEL).resized();
const phoneChange = new Set(); // кто сейчас меняет номер командой /nomer (без записи)

const notifyAdmin = (text) => (ADMIN_ID ? bot.api.sendMessage(ADMIN_ID, text) : null);

// ---------- команды ----------
bot.command("start", (ctx) =>
  ctx.reply(`Привет, ${ctx.from.first_name}! 👋\nЯ бот барбершопа «Лезвие». Выбери кнопку внизу 👇`, { reply_markup: mainMenu }),
);
bot.command("myid", (ctx) => ctx.reply(`Твой id: ${ctx.from.id}`));
bot.command("zapisi", (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply("Эта команда только для мастера.");
  const list = loadBookings().filter((b) => bookingDate(b) > new Date()).sort((a, b) => bookingDate(a) - bookingDate(b));
  if (!list.length) return ctx.reply("Предстоящих записей нет.");
  ctx.reply("📋 Предстоящие записи:\n" + list.map((b) => `• ${prettyDay(b.day)}, ${b.time} — ${b.service} — ${b.name}${b.phone ? `, ${b.phone}` : ""}`).join("\n"));
});

// ---------- разделы меню ----------
// Каждый раздел — отдельная функция: её вызывают и кнопка внизу, и команда из «Меню», и старые кнопки в сообщениях
const showPrices = (ctx) =>
  ctx.reply("💰 Цены:\n" + SERVICES.map((s) => `• ${s.name} — ${s.price} ₽`).join("\n"), { reply_markup: mainMenu });
const showContacts = (ctx) =>
  ctx.reply(`📍 ${ADDRESS}\n🕙 Каждый день 10:00–21:00\n📞 +7 900 000-00-00`, { reply_markup: mainMenu });

async function showBook(ctx) {
  const kb = new InlineKeyboard();
  SERVICES.forEach((s) => kb.text(`${s.name} — ${s.price} ₽`, `svc:${s.id}`).row());
  await ctx.reply("Выбери услугу:", { reply_markup: kb });
}

async function showMine(ctx) {
  const mine = loadBookings()
    .filter((b) => b.userId === ctx.from.id && bookingDate(b) > new Date())
    .sort((a, b) => bookingDate(a) - bookingDate(b));
  if (!mine.length) return ctx.reply("У тебя нет предстоящих записей.", { reply_markup: mainMenu });
  const kb = new InlineKeyboard();
  mine.forEach((b) => kb.text(`❌ Отменить ${prettyDay(b.day)}, ${b.time}`, `del:${b.id}`).row());
  await ctx.reply(
    "📋 Твои записи:\n" + mine.map((b) => `• ${prettyDay(b.day)}, ${b.time} — ${b.service}`).join("\n"),
    { reply_markup: kb },
  );
}

// одна функция — три способа её вызвать
const sections = [
  { key: "book", cmd: "zapis", fn: showBook },
  { key: "mine", cmd: "moi", fn: showMine },
  { key: "prices", cmd: "ceny", fn: showPrices },
  { key: "contacts", cmd: "kontakty", fn: showContacts },
];
for (const s of sections) {
  bot.hears(BTN[s.key], s.fn); // кнопка внизу экрана
  bot.command(s.cmd, s.fn); // команда из «Меню»
  bot.callbackQuery(s.key, async (ctx) => { await ctx.answerCallbackQuery(); await s.fn(ctx); }); // кнопки в старых сообщениях
}

// ---------- отмена своей записи ----------
bot.callbackQuery(/^del:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const list = loadBookings();
  const b = list.find((x) => x.id === ctx.match[1] && x.userId === ctx.from.id); // отменить можно только свою
  if (!b) return ctx.editMessageText("Эта запись уже отменена.");
  saveBookings(list.filter((x) => x !== b));
  await ctx.editMessageText(`Запись на ${prettyDay(b.day)}, ${b.time} отменена.`);
  await ctx.reply("Чем ещё помочь?", { reply_markup: mainMenu });
  await notifyAdmin(`❌ Запись отменена\n👤 ${b.name}${b.phone ? `\n📞 ${b.phone}` : ""}\n✂️ ${b.service}\n📅 ${prettyDay(b.day)}, ${b.time}`);
});

// ---------- запись: услуга → день → время → подтверждение ----------
bot.callbackQuery(/^svc:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const service = SERVICES.find((s) => s.id === ctx.match[1]);
  drafts.set(ctx.from.id, { service: service.name });
  const kb = new InlineKeyboard();
  nextDays().forEach((d, i) => { kb.text(d.label, `day:${d.iso}`); if (i % 2 === 1) kb.row(); });
  await ctx.editMessageText(`✂️ ${service.name}\nВыбери день:`, { reply_markup: kb });
});

bot.callbackQuery(/^day:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = drafts.get(ctx.from.id);
  if (!draft) return ctx.reply("Начни запись заново 👇", { reply_markup: mainMenu });
  draft.day = ctx.match[1];
  const free = freeHours(draft.day);
  if (!free.length) return ctx.editMessageText(`На ${prettyDay(draft.day)} свободного времени нет 😔`, { reply_markup: new InlineKeyboard().text("⬅️ Выбрать другой день", "book") });
  const kb = new InlineKeyboard();
  free.forEach((h, i) => { kb.text(h, `time:${h}`); if (i % 4 === 3) kb.row(); });
  await ctx.editMessageText(`✂️ ${draft.service}\n📅 ${prettyDay(draft.day)}\nВыбери время:`, { reply_markup: kb });
});

bot.callbackQuery(/^time:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = drafts.get(ctx.from.id);
  if (!draft) return ctx.reply("Начни запись заново 👇", { reply_markup: mainMenu });
  draft.time = ctx.match[1];
  const kb = new InlineKeyboard().text("✅ Подтвердить", "confirm").text("❌ Отмена", "cancel");
  await ctx.editMessageText(`Проверь запись:\n✂️ ${draft.service}\n📅 ${prettyDay(draft.day)}\n🕐 ${draft.time}`, { reply_markup: kb });
});

bot.callbackQuery("cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  drafts.delete(ctx.from.id);
  await ctx.editMessageText("Запись отменена.");
  await ctx.reply("Чем ещё помочь?", { reply_markup: mainMenu });
});

bot.callbackQuery("confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = drafts.get(ctx.from.id);
  if (!draft) return ctx.reply("Начни запись заново 👇", { reply_markup: mainMenu });
  if (isTaken(draft.day, draft.time)) return ctx.editMessageText("Ой, это время только что заняли 😔", { reply_markup: new InlineKeyboard().text("⬅️ Заново", "book") });

  // убираем кнопки «Подтвердить/Отмена», чтобы не нажали второй раз
  await ctx.editMessageText(`Проверь запись:\n✂️ ${draft.service}\n📅 ${prettyDay(draft.day)}\n🕐 ${draft.time}`);
  if (getUser(ctx.from.id)?.phone) return finishBooking(ctx, draft);

  // номера ещё нет — просим один раз, запись завершится, когда он придёт
  draft.waitPhone = true;
  await ctx.reply(
    "Остался один шаг 👇\nНажми «📱 Отправить мой номер» — мастер сможет позвонить, если что-то изменится.\nЕсли звонить лучше на другой номер — нажми «✏️ Ввести другой номер». Спрошу только один раз.",
    { reply_markup: phoneKb },
  );
});

// номер с пометкой для мастера: настоящий из Telegram или написанный клиентом
const phoneLine = (u) => `${u.phone} ${u.verified ? "(из Telegram ✅)" : "(указал сам)"}`;

// сохраняем запись и сообщаем обоим: клиенту и мастеру
async function finishBooking(ctx, draft) {
  const user = getUser(ctx.from.id);
  const phone = user.phone;
  drafts.delete(ctx.from.id);
  if (isTaken(draft.day, draft.time)) return ctx.reply("Ой, это время только что заняли 😔 Выбери другое 👇", { reply_markup: mainMenu });

  const name = ctx.from.first_name + (ctx.from.username ? ` (@${ctx.from.username})` : "");
  const list = loadBookings();
  list.push({
    id: Math.random().toString(36).slice(2, 9),
    service: draft.service, day: draft.day, time: draft.time,
    name, phone, userId: ctx.from.id, reminded: false, createdAt: new Date().toISOString(),
  });
  saveBookings(list);

  await ctx.reply(
    `✅ Ты записан!\n✂️ ${draft.service}\n📅 ${prettyDay(draft.day)}\n🕐 ${draft.time}\n\nЖдём тебя: ${ADDRESS}\nНапомню за ${REMIND_BEFORE_HOURS} часа 😉`,
    { reply_markup: mainMenu },
  );
  await notifyAdmin(`🔔 Новая запись!\n👤 ${name}\n📞 ${phoneLine(user)}\n✂️ ${draft.service}\n📅 ${prettyDay(draft.day)}, ${draft.time}`);
}

// ждём ли мы от человека номер: при записи или при смене номера
const waitingPhone = (id) => drafts.get(id)?.waitPhone || phoneChange.has(id);

// номер получен (кнопкой или текстом) — сохраняем и продолжаем то, что человек делал
async function phoneReceived(ctx, phone, verified) {
  savePhone(ctx.from.id, phone, verified);
  phoneChange.delete(ctx.from.id);
  const draft = drafts.get(ctx.from.id);
  if (draft?.waitPhone) return finishBooking(ctx, draft);
  await ctx.reply(`Номер сохранён 👍 ${phone}`, { reply_markup: mainMenu });
}

// клиент нажал «Отправить мой номер»
bot.on("message:contact", async (ctx) => {
  const contact = ctx.message.contact;
  // проверка: номер должен быть от этого же аккаунта, а не пересланный чужой контакт
  if (contact.user_id !== ctx.from.id) {
    return ctx.reply("Это чужой контакт 🙂 Нажми «📱 Отправить мой номер» или «✏️ Ввести другой номер».", { reply_markup: phoneKb });
  }
  const phone = contact.phone_number.startsWith("+") ? contact.phone_number : `+${contact.phone_number}`;
  await phoneReceived(ctx, phone, true);
});

bot.hears(PHONE_MANUAL, (ctx) =>
  ctx.reply("Напиши номер, на который тебе звонить, например: +7 900 123-45-67", { reply_markup: phoneKb }),
);

bot.hears(PHONE_CANCEL, async (ctx) => {
  const hadDraft = drafts.delete(ctx.from.id);
  phoneChange.delete(ctx.from.id);
  await ctx.reply(hadDraft ? "Запись отменена." : "Хорошо, номер не меняю.", { reply_markup: mainMenu });
});

// /nomer — поменять сохранённый номер
bot.command("nomer", (ctx) => {
  phoneChange.add(ctx.from.id);
  const u = getUser(ctx.from.id);
  return ctx.reply(`${u?.phone ? `Сейчас у тебя номер ${u.phone}.\n` : ""}Отправь новый номер кнопкой или напиши его 👇`, { reply_markup: phoneKb });
});

bot.on("message:text", async (ctx) => {
  // пока ждём номер, пробуем понять его из текста
  if (waitingPhone(ctx.from.id)) {
    const phone = parsePhone(ctx.message.text);
    if (phone) return phoneReceived(ctx, phone, false);
    return ctx.reply("Не похоже на номер 🤔 Напиши так: +7 900 123-45-67 — или нажми «📱 Отправить мой номер».", { reply_markup: phoneKb });
  }
  return ctx.reply("Нажми кнопку ниже 👇", { reply_markup: mainMenu });
});

// ---------- напоминания ----------
// Раз в минуту смотрим записи: если до визита осталось меньше REMIND_BEFORE_HOURS часов и ещё не напоминали — напоминаем.
async function sendReminders() {
  const list = loadBookings();
  const now = new Date();
  let changed = false;
  for (const b of list) {
    const left = bookingDate(b) - now; // сколько миллисекунд до визита
    if (!b.reminded && left > 0 && left <= REMIND_BEFORE_HOURS * 3600 * 1000) {
      try {
        await bot.api.sendMessage(b.userId, `⏰ Напоминаю: сегодня в ${b.time} — ${b.service}.\n📍 ${ADDRESS}\nЕсли не получается прийти — отмени запись в «Мои записи».`);
      } catch (e) {
        console.error("Не удалось отправить напоминание:", e.message);
      }
      b.reminded = true;
      changed = true;
    }
  }
  if (changed) saveBookings(list);
}
setInterval(sendReminders, 60 * 1000);

// ---------- профиль бота в Telegram ----------
// Кнопка «Меню» слева от поля ввода и текст «Что умеет этот бот?», который видно в пустом чате до нажатия «Старт»
async function setupProfile() {
  try {
    await bot.api.setMyCommands([
      { command: "zapis", description: "✂️ Записаться" },
      { command: "moi", description: "📋 Мои записи" },
      { command: "ceny", description: "💰 Цены" },
      { command: "kontakty", description: "📍 Контакты" },
      { command: "nomer", description: "📞 Изменить номер телефона" },
      { command: "start", description: "🏠 Главное меню" },
    ]);
    await bot.api.setMyDescription(
      `Онлайн-запись в барбершоп «Лезвие» ✂️\n\n• Запишись за 30 секунд — без звонков и переписки\n• Видно только свободное время\n• Напомню о визите за ${REMIND_BEFORE_HOURS} часа\n• Отменить запись — в один клик\n\nНажми «Старт» 👇`,
    );
    await bot.api.setMyShortDescription("Онлайн-запись в барбершоп «Лезвие» — без звонков, с напоминанием о визите.");
  } catch (e) {
    console.error("Не удалось обновить профиль бота:", e.message);
  }
}

bot.catch((err) => console.error("Ошибка:", err.message));
setupProfile();
bot.start();
sendReminders();
console.log("Бот запущен! Открой его в Telegram и напиши /start");
